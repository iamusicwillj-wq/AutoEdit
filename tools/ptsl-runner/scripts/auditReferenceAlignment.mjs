#!/usr/bin/env node
// Offline diagnostic only. This module has no PTSL client, audio-device, or
// database dependencies and writes only the explicitly requested report file.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { conformManifest } from '../src/conformEngine.js';
import { buildCommandPlan } from '../src/commandPlan.js';
import { audioEventsForTrack, findTrack, parseSessionInfoText } from '../src/sessionInfoParser.js';
import { enrichSessionWithClipMetadata } from '../src/clipMetadata.js';

const usage = `Usage:
  node scripts/auditReferenceAlignment.mjs --diagnostic <AutoEdit-Diagnostics>
    [--edit-reference <track>] [--recording-reference <track>]
    [--output <new-report.json>]

Reads manifest.json, Session Info and GetClipList snapshots under work/.
Overrides are report-only and require a single-cue manifest. They never update
the saved Profile or input manifest. With no --output, prints JSON to stdout.
An existing output file is refused. No Pro Tools connection or media write occurs.
`;

function getTrack(session,name) {
  const track=findTrack(session,name);
  if (!track) throw new Error(`Snapshot does not contain selected track: ${name}`);
  return track;
}

// Keep the accepted aliases and nullish precedence identical to conformEngine's
// referenceTrackName / targetTrackConfig. These helpers only describe or clone
// input manifests; the production algorithm still receives the original schema.
const editReferenceFields=['edit_demo_track','editDemoTrack','edit_demo_tracks','demo_track','demoTrack','demo_tracks'];
const recordingReferenceFields=['recording_reference_track','recordingReferenceTrack','recording_demo_track','recordingDemoTrack'];
const asArray=value=>value===undefined || value===null || value==='' ? [] : Array.isArray(value) ? value : [value];
const firstDefined=(object,fields)=>fields.map(field=>object[field]).find(value=>value!==undefined && value!==null);
const targetsForCue=cue=>asArray(cue.target_tracks ?? cue.targetTracks);
const recordingReferenceForCue=cue=>firstDefined(cue,recordingReferenceFields);
const editReferencesForTarget=(cue,target)=>asArray(firstDefined(target,editReferenceFields) ?? firstDefined(cue,editReferenceFields));
const demoChannelForTarget=(cue,target)=>target.demo_channel ?? target.demoChannel ?? cue.demo_channel ?? cue.demoChannel ?? 1;

function selectedEvents(session,name,options) {
  getTrack(session,name); // Same name/rawName lookup as the production planner.
  return audioEventsForTrack(session,name,{...options,includeFades:true})
    .filter(event=>event.timelineStartSamples!==null && event.timelineEndSamples!==null);
}

export function applyReportOnlyOverrides(input,{editReference,recordingReference}={}) {
  const manifest=structuredClone(input),overrides={};
  if(editReference===undefined && recordingReference===undefined) return {manifest,overrides};
  const cues=asArray(manifest.cues);
  if(cues.length!==1) throw new Error('Reference overrides require a single-cue diagnostic.');
  const cue=cues[0];
  if(editReference!==undefined) {
    overrides.edit_demo_track={saved:editReferencesForTarget(cue,{}),
      savedTargets:targetsForCue(cue).map(target=>({tracks:editReferencesForTarget(cue,target),
        channel:demoChannelForTarget(cue,target)})),replay:editReference};
    for(const field of editReferenceFields) delete cue[field];
    cue.edit_demo_track=editReference;
    // Either container is accepted by the planner, with target_tracks taking
    // precedence. Clear all target-level aliases so none override the replay.
    for(const target of [...asArray(cue.target_tracks),...asArray(cue.targetTracks)]) {
      for(const field of editReferenceFields) delete target[field];
    }
  }
  if(recordingReference!==undefined) {
    overrides.recording_reference_track={saved:recordingReferenceForCue(cue),replay:recordingReference};
    for(const field of recordingReferenceFields) delete cue[field];
    cue.recording_reference_track=recordingReference;
  }
  return {manifest,overrides};
}

function eventSummary(event) {
  return Object.fromEntries(['type','channel','clipName','sourceFile','timelineStartSamples','timelineEndSamples',
    'sourceStartSamples','sourceEndSamples','clipListSourceStartSamples','clipListSourceEndSamples',
    'timestampSamples','sourceRangeBasis','mappingUnverified'].map(key=>[key,event[key]]));
}

export function auditReferenceAlignment({manifest,recordingSession,demoSession}) {
  const conform=conformManifest({manifest,recordingSession,demoSession,partialPolicy:true});
  const commands=buildCommandPlan(conform);
  const pairs=[];
  for (const cue of asArray(manifest.cues)) {
    const referenceName=recordingReferenceForCue(cue);
    if (!referenceName) throw new Error('This audit requires explicit Recording Reference tracks.');
    const referenceChannel=cue.recording_reference_channel ?? cue.recordingReferenceChannel ?? 1;
    const referenceEvents=selectedEvents(recordingSession,referenceName,{
      channel:referenceChannel,includeMuted:Boolean(cue.include_muted_reference ?? true),
      includeHidden:cue.include_hidden ?? true,includeInactive:cue.include_inactive ?? true});
    const referenceSources=[...new Set(referenceEvents.filter(e=>e.type==='audio').map(e=>e.sourceFile).filter(Boolean))];
    pairs.push({cueId:cue.cue_id ?? cue.cueId ?? '',recordingReference:referenceName,referenceChannel,
      referenceSourceFiles:referenceSources,referenceEvents:referenceEvents.map(eventSummary),
      editReferences:targetsForCue(cue).flatMap(target=>editReferencesForTarget(cue,target).map(name=>{
        const channel=demoChannelForTarget(cue,target);
        const events=selectedEvents(demoSession,name,{channel,
          includeMuted:Boolean(target.include_muted_demo ?? cue.include_muted_demo ?? true),
          includeHidden:target.include_hidden ?? cue.include_hidden ?? true,
          includeInactive:target.include_inactive ?? cue.include_inactive ?? true});
        const sourceFiles=[...new Set(events.filter(e=>e.type==='audio').map(e=>e.sourceFile).filter(Boolean))];
        return {name,channel,sourceFiles,sameFileNames:sourceFiles.filter(f=>referenceSources.includes(f)),
          events:events.map(eventSummary)};
      }))});
  }

  // Independent check only where all operands are explicit and no fade
  // reconstruction is needed. It compares the recording timeline moment of a
  // known file sample with the reference source moment at the same edit time.
  // It cannot prove that two different files contain the same performance.
  const coordinateChecks=conform.clips.map(clip=>{
    const pair=pairs.find(p=>p.cueId===clip.cueId && p.recordingReference===clip.mappingEvidence?.referenceTrack);
    const referenceEvents=pair?.referenceEvents ?? [];
    const matches=referenceEvents.filter(e=>e.type==='audio' && e.clipName===clip.mappingEvidence?.referenceClip);
    const recTrack=getTrack(recordingSession,clip.sourceTrack);
    const recEvents=recTrack.events.filter(e=>e.channel===clip.channel);
    const recordings=recEvents.filter(e=>e.type==='audio' && e.clipName===clip.sourceClipName
      && e.timelineStartSamples<=clip.recordingStartSamples && e.timelineEndSamples>=clip.recordingEndSamples);
    const base={destinationTrack:clip.destinationTrack,channel:clip.channel,
      editStart:clip.timelineStartSamples,recordedSourceStart:clip.sourceStartSamples,
      referenceMatchBasis:clip.mappingEvidence?.referenceMatchBasis};
    if(matches.length!==1 || recordings.length!==1 || referenceEvents.some(e=>e.type!=='audio')
      || recEvents.some(e=>e.type!=='audio')) {
      return {...base,status:'not-checked',reason:'Repeated occurrences or fade handles need a separate reconstruction check.'};
    }
    const ref=matches[0],rec=recordings[0];
    if(ref.mappingUnverified || rec.mappingUnverified || clip.mappingUnverified) {
      return {...base,status:'not-checked',reason:'Source metadata is marked uncertain.'};
    }
    const referenceSourceAtOutput=clip.mappingEvidence.demoSourceStartSamples
      +clip.timelineStartSamples-clip.mappingTimelineStartSamples;
    const recordingTimeFromReference=ref.timelineStartSamples+referenceSourceAtOutput-ref.sourceStartSamples;
    const recordingTimeFromFile=rec.timelineStartSamples+clip.sourceStartSamples-rec.sourceStartSamples;
    return {...base,status:recordingTimeFromReference===recordingTimeFromFile?'consistent-if-reference-coordinates-match':'inconsistent',
      referenceSourceAtOutput,recordingTimeFromReference,recordingTimeFromFile,
      differenceSamples:recordingTimeFromFile-recordingTimeFromReference,
      assumedSharedReferenceSourceCoordinates:true};
  });

  return {schemaVersion:1,mode:'offline snapshots only',sampleRates:{recording:recordingSession.metadata.sampleRate,
    edit:demoSession.metadata.sampleRate},pairs,coordinateChecks,
    clipGroups:commands.clipGroups.map(c=>Object.fromEntries(['name','destinationTrack','sourceFilePath',
      'channelCount','sourceStartSamples','sourceEndSamples','timelineStartSamples','timelineEndSamples',
      'isMuted'].map(k=>[k,c[k]]))),
    fadeGroups:commands.fadeGroups,issues:commands.issues,
    limits:[
      'Coordinate consistency is conditional on the two reference tracks sharing source coordinates; file names or track selections alone do not prove that.',
      'BWF/original/user timestamps are not file-relative source positions. GetClipList source positions are used when present.',
      'No source audio was opened or compared. No waveform alignment, real Pro Tools execution, or listening result is established.',
      'A diagnostic records one saved run. A report-only override is a hypothetical replay, not evidence that the user ran that selection.'
    ]};
}

function main(args) {
  if(args.includes('--help') || args.includes('-h')) {console.log(usage);return;}
  const known=new Set(['--diagnostic','--edit-reference','--recording-reference','--output']);
  const values={};
  for(let i=0;i<args.length;i+=2) {
    if(!known.has(args[i]) || !args[i+1] || args[i+1].startsWith('--')) throw new Error(usage);
    if(values[args[i]]!==undefined) throw new Error(`Duplicate argument: ${args[i]}`);
    values[args[i]]=args[i+1];
  }
  if(!values['--diagnostic']) throw new Error(usage);
  const input=path.resolve(values['--diagnostic']);
  const work=fs.existsSync(path.join(input,'manifest.json')) ? input : path.join(input,'work');
  const fingerprints={};
  const read=name=>{
    const bytes=fs.readFileSync(path.join(work,name));
    fingerprints[name]=crypto.createHash('sha256').update(bytes).digest('hex');
    return bytes.toString('utf8');
  };
  const savedManifest=JSON.parse(read('manifest.json'));
  const parse=prefix=>enrichSessionWithClipMetadata(parseSessionInfoText(read(`${prefix}_session_info.txt`)),
    JSON.parse(read(`${prefix}_clip_metadata.json`)));
  const recordingSession=parse('recording'),demoSession=parse('edit');
  const {manifest,overrides}=applyReportOnlyOverrides(savedManifest,{
    editReference:values['--edit-reference'],recordingReference:values['--recording-reference']});
  const report={inputFingerprints:fingerprints,reportOnlyOverrides:overrides,
    ...auditReferenceAlignment({manifest,recordingSession,demoSession})};
  const json=JSON.stringify(report,null,2)+'\n';
  if(values['--output']) {
    const output=path.resolve(values['--output']);
    fs.writeFileSync(output,json,{flag:'wx'});
    console.log(`Wrote offline report: ${output}`);
  } else process.stdout.write(json);
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {main(process.argv.slice(2));} catch(error) {console.error(error.message);process.exitCode=1;}
}
