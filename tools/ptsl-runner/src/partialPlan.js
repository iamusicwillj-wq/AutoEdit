import { fadeUsesClip } from './fadeDependencies.js';
import { inspectSourceFile } from './sourceFileAccess.js';
import { planDigest } from './executionPolicy.js';

const clone = value => JSON.parse(JSON.stringify(value));
const overlaps = (a,b) => a.destinationTrack === b.destinationTrack
  && a.timelineStartSamples < b.timelineEndSamples && b.timelineStartSamples < a.timelineEndSamples;
const scoped = i => Boolean(i.destinationTrack);
const range = c => ({destinationTrack:c.destinationTrack, timelineStartSamples:c.timelineStartSamples, timelineEndSamples:c.timelineEndSamples, clipName:c.name});
export const skipIssue = (code, message, context = {}, action = 'skip-clip') => ({...context, severity:'warning', code, message, action});

// A skipped clip always includes all channels, plus any fade touching it.
// The original plan stays intact in diagnostics; only this derived plan is executed.
export function preparePartialPlan(original, { exists, inspectSource = inspectSourceFile, uncertainAudio = 'skip' } = {}) {
  const plan = clone(original ?? {}), skipIssues = [], reviewIssues = [], importIssues = [], fatalIssues = [];
  const reject = message => fatalIssues.push({severity:'fatal',code:'invalid-plan',message});
  if (!['skip','import'].includes(uncertainAudio)) reject('Invalid uncertain-audio choice.');
  for (const key of ['imports','createTracks','clipGroups','fadeGroups']) {
    if (!Array.isArray(plan[key]) || plan[key].some(item=>!item || typeof item!=="object")) reject(`Invalid command plan: ${key} must be an array.`);
  }
  if (!Array.isArray(plan.issues ?? []) || (plan.issues ?? []).some(i=>!i || typeof i!=="object")) reject('Invalid command plan: issues must be an array.');
  if (fatalIssues.length) return finish();
  if (new Set(plan.createTracks.map(t=>t.track_name)).size !== plan.createTracks.length
      || new Set(plan.clipGroups.map(c=>c.name)).size !== plan.clipGroups.length) reject('Invalid command plan: duplicate track or clip identifiers.');
  const formats={1:'Mono',2:'Stereo',3:'LCR',4:'LCRS',5:'5_0',6:'5_1'};
  const removedClips = new Set(), removedTracks = new Set(), removedFades = new Set();
  const sourceChecks = new Map();
  const removeClip = c => removedClips.add(c.name);
  const issues = plan.issues ?? [];
  for (const issue of issues) {
    if (issue.severity === 'info') continue;
    if (['inactive-source-track','shortened-fade','recovered-fade-boundary','extended-reference-mapping'].includes(issue.code)) { reviewIssues.push(issue); continue; }
    if (issue.code === 'empty-conform-plan') continue; // derived empty-result check below
    if (['position-gap','position-reference-partial','unverified-mapping','reference-name-mismatch','unverified-recording-range','reference-fade-coverage'].includes(issue.code)) {
      if(!scoped(issue) || !Number.isSafeInteger(issue.timelineStartSamples) || !Number.isSafeInteger(issue.timelineEndSamples)) {reject('Cannot determine the affected mapping interval.');continue;}
      const affected = plan.clipGroups.filter(c=>overlaps(c,issue));
      if (issue.uncoveredOnly || ['position-gap','reference-fade-coverage'].includes(issue.code)) {
        // The issue describes missing samples, not uncertain samples in the
        // surviving clips. Keep all usable audio and independently valid fades.
        importIssues.push({...issue,severity:'warning',action:'keep-audio',draftClipNames:[]});
        continue;
      }
      // Audio gaps may touch rather than overlap a surviving clip. They still
      // require approval and must remain visible in the final result.
      if (uncertainAudio === 'import' && plan.clipGroups.some(c=>c.destinationTrack===issue.destinationTrack)) {
        importIssues.push({...issue,severity:'warning',action:'import-for-review',draftClipNames:affected.map(c=>c.name)});
      } else {
        affected.forEach(removeClip);
        skipIssues.push(skipIssue(issue.code,issue.message,issue,'skip-unmapped'));
      }
      // The user approved this exact proposed mapping. Preserve its generated
      // fades too; explicit unresolved-fade issues still remove invalid ones.
      if (uncertainAudio !== 'import') plan.fadeGroups.filter(f=>overlaps(f,issue)).forEach(f=>removedFades.add(f.key));
      continue;
    }
    if (issue.code === 'unresolved-fade' && scoped(issue)) {
      // Entirely unmapped clips already explain their missing fades. Do not duplicate four channel errors.
      const uncovered = issues.some(i=>((i.code==='position-reference-partial' && i.coverage==='uncovered')||i.code==='unverified-mapping')
        && i.destinationTrack===issue.destinationTrack && i.timelineStartSamples<=issue.timelineStartSamples && i.timelineEndSamples>=issue.timelineEndSamples);
      if (!uncovered) skipIssues.push(skipIssue(issue.code,issue.message,issue,'skip-fade'));
      for(const f of plan.fadeGroups) if(overlaps(f,issue)) removedFades.add(f.key);
      continue;
    }
    if (['offline-source-file','offline-source-clip','missing-source-file-path','unsupported-clip-channel-count'].includes(issue.code) && scoped(issue)) {
      const matches=plan.clipGroups.filter(c=>overlaps(c,issue));
      matches.forEach(removeClip);
      skipIssues.push(skipIssue(issue.code,issue.message,issue)); continue;
    }
    if (issue.code==='unsupported-track-channel-count' && scoped(issue)) {
      removedTracks.add(issue.destinationTrack);
      skipIssues.push(skipIssue(issue.code,issue.message,issue,'skip-track'));continue;
    }
    // Unknown local errors can be isolated by dropping the affected track. Unknown unscoped
    // errors cannot be safely bounded, so are treated as an invalid/unverifiable plan.
    if(scoped(issue)) {
      removedTracks.add(issue.destinationTrack);
      skipIssues.push(skipIssue(issue.code,issue.message,issue,'skip-track'));
    } else reject(`Cannot determine the affected track or clip: ${issue.message}`);
  }
  for(const t of plan.createTracks) {
    if(removedTracks.has(t.track_name)) continue;
    if(!formats[t.channel_count]) {
      removedTracks.add(t.track_name);
      skipIssues.push(skipIssue('unsupported-track-channel-count','Unsupported destination channel count.',{destinationTrack:t.track_name},'skip-track'));continue;
    }
    if(!t.track_name || t.number_of_tracks!==1 || t.track_type!=='TType_Audio'
      || t.track_timebase!=='TTimebase_Samples' || t.track_format!==`TFormat_${formats[t.channel_count]}`) reject('Invalid destination track request.');
  }
  for(const c of plan.clipGroups) {
    if(removedTracks.has(c.destinationTrack)||removedClips.has(c.name)) continue;
    if(!Number.isSafeInteger(c.timelineStartSamples) || !Number.isSafeInteger(c.timelineEndSamples)
      || !Number.isSafeInteger(c.sourceStartSamples) || !Number.isSafeInteger(c.sourceEndSamples)
      || c.sourceStartSamples<0 || c.sourceEndSamples-c.sourceStartSamples!==c.timelineEndSamples-c.timelineStartSamples || c.sourceEndSamples<=c.sourceStartSamples || c.timelineEndSamples<=c.timelineStartSamples) {
      removeClip(c);skipIssues.push(skipIssue('invalid-clip-range','Invalid clip range; skip this entire clip.',range(c)));continue;
    }
    // Validate materialized requests against the human-readable plan before any writes.
    const request=c.createAudioClipRequest?.clip_list;
    const spot=c.spotClipsByIdRequest;
    if(!Array.isArray(request) || request.length!==1 || !Array.isArray(request[0].clip_info) || !request[0].clip_info.length
      || request[0].name!==c.name || request[0].clip_info.length!==c.channels?.length
      || request[0].channel_format!==`SFormat_${formats[c.channelCount]}` || spot?.dst_track_name!==c.destinationTrack
      || spot?.dst_location_data?.location_type!=='SLType_Start'
      || spot?.dst_location_data?.location?.time_type!=='TLType_Samples'
      || Number(spot?.dst_location_data?.location?.location)!==c.timelineStartSamples
      || request[0].clip_info.some(i=>i.file_id_ref!==c.sourceFilePath
        || Number(i.src_start_point?.position)!==c.sourceStartSamples || Number(i.src_end_point?.position)!==c.sourceEndSamples
        || i.src_start_point?.time_type!=='BTType_Samples' || i.src_end_point?.time_type!=='BTType_Samples')) {
      reject(`Invalid command plan requests for clip ${c.name}.`);
    }
    const track=plan.createTracks.find(t=>t.track_name===c.destinationTrack);
    if(!track) reject(`No planned destination track for ${c.name}.`);
    else if(c.channelCount!==track.channel_count || c.channels?.length!==c.channelCount
      || new Set(c.channels?.map(ch=>ch.channel)).size!==c.channelCount) {
      removeClip(c);skipIssues.push(skipIssue('missing-channels','Clip channels do not match the target track; skip the entire clip.',range(c)));
    }
    if (!sourceChecks.has(c.sourceFilePath)) sourceChecks.set(c.sourceFilePath, exists
      ? {ok:Boolean(c.sourceFilePath && exists(c.sourceFilePath)),code:'path-not-found',fileErrorCode:'ENOENT'}
      : inspectSource(c.sourceFilePath));
    const access = sourceChecks.get(c.sourceFilePath);
    if(!access.ok) {
      const reason = access.code === 'source-access-denied' ? 'Permission to read the source file was denied'
        : access.code === 'path-not-found' ? 'Source path was not found'
        : access.code === 'source-not-file' ? 'Source path is not a regular file' : 'Source file could not be read';
      removeClip(c);skipIssues.push(skipIssue(access.code,`${reason} (${access.fileErrorCode}): ${c.sourceFilePath || c.sourceFile}. Locate the file or restore access before retrying.`,{...range(c),sourcePath:c.sourceFilePath,fileErrorCode:access.fileErrorCode}));
    }
  }
  for (const f of plan.fadeGroups) {
    if(removedTracks.has(f.destinationTrack)||removedFades.has(f.key)
      || plan.clipGroups.some(c=>removedClips.has(c.name)&&fadeUsesClip(f,c)))continue;
    if(!Number.isSafeInteger(f.timelineStartSamples) || !Number.isSafeInteger(f.timelineEndSamples) || f.timelineEndSamples<=f.timelineStartSamples) {
      removedFades.add(f.key);skipIssues.push(skipIssue('unresolved-fade','Invalid fade interval.',range(f),'skip-fade'));continue;
    }
    if(!plan.createTracks.some(t=>t.track_name===f.destinationTrack) || !f.createFadesBasedOnPresetRequest
      || f.selectTracksByNameRequest?.track_names?.length!==1 || f.selectTracksByNameRequest.track_names[0]!==f.destinationTrack
      || f.selectTracksByNameRequest.selection_mode!=='SMode_Replace'
      || f.setTimelineSelectionRequest?.location_type!=='TLType_Samples'
      || Number(f.setTimelineSelectionRequest?.in_time)!==f.timelineStartSamples
      || Number(f.setTimelineSelectionRequest?.out_time)!==f.timelineEndSamples) reject(`Invalid fade request on ${f.destinationTrack}.`);
  }
  const dropped=plan.clipGroups.filter(c=>removedClips.has(c.name)||removedTracks.has(c.destinationTrack));
  plan.clipGroups=plan.clipGroups.filter(c=>!dropped.includes(c));
  plan.fadeGroups=plan.fadeGroups.filter(f=>{
    const removed=removedTracks.has(f.destinationTrack)||removedFades.has(f.key)||dropped.some(c=>fadeUsesClip(f,c));
    if(removed && !removedTracks.has(f.destinationTrack) && !removedFades.has(f.key))
      skipIssues.push(skipIssue('dependent-fade','Skip this fade because a required clip was skipped.',range(f),'skip-fade'));
    return !removed;
  });
  const activeTracks=new Set(plan.clipGroups.map(c=>c.destinationTrack));
  for (const track of plan.createTracks) {
    if (!activeTracks.has(track.track_name) && dropped.some(c=>c.destinationTrack===track.track_name)) {
      skipIssues.push(skipIssue('empty-destination-track','All clips on this destination track were skipped. This track will not be created.',
        {destinationTrack:track.track_name},'skip-track'));
    }
  }
  plan.createTracks=plan.createTracks.filter(t=>activeTracks.has(t.track_name));
  plan.fadeGroups=plan.fadeGroups.filter(f=>activeTracks.has(f.destinationTrack));
  const files=new Set(plan.clipGroups.map(c=>c.sourceFilePath));
  plan.imports=plan.imports.filter(i=>files.has(i.path));
  if([...files].some(p=>!plan.imports.some(i=>i.path===p))) reject('Invalid command plan: a required import is absent.');
  if(!plan.clipGroups.length) fatalIssues.push({severity:'fatal',code:'nothing-to-apply',message:'Nothing can be applied after skipping the affected items.'});
  return finish();

  function finish() {
    const unique=[...new Map(skipIssues.map(i=>[JSON.stringify(i),i])).values()];
    // A completely uncovered target must still be reported when other tracks
    // remain executable; never silently hide it because it has no output clips.
    for (const issue of importIssues.filter(i=>!i.draftClipNames.length && !plan.clipGroups.some(c=>c.destinationTrack===i.destinationTrack))) {
      const skipped=skipIssue(issue.code,issue.message,issue,'skip-unmapped');
      if(!unique.some(i=>i.destinationTrack===issue.destinationTrack && i.timelineStartSamples===issue.timelineStartSamples && i.timelineEndSamples===issue.timelineEndSamples)) unique.push(skipped);
    }
    const retainedImportIssues=importIssues.filter(i=>i.draftClipNames.length
      ? plan.clipGroups.some(c=>i.draftClipNames.includes(c.name))
      : plan.clipGroups.some(c=>c.destinationTrack===i.destinationTrack));
    const summary={imports:plan.imports?.length??0,createTracks:plan.createTracks?.length??0,clipGroups:plan.clipGroups?.length??0,fadeGroups:plan.fadeGroups?.length??0,warnings:unique.length,fatalIssues:fatalIssues.length};
    summary.warnings += retainedImportIssues.length;
    const policyDigest=planDigest(JSON.stringify({uncertainAudio,plan,skipIssues:unique,reviewIssues,importIssues:retainedImportIssues,fatalIssues}));
    return {plan,skipIssues:unique,reviewIssues,importIssues:retainedImportIssues,fatalIssues,summary,policyDigest,uncertainAudio};
  }
}

export function partialPreflight(original, options = {}) {
  const p=preparePartialPlan(original,options);
  if(options.approvedPolicyDigest && options.approvedPolicyDigest!==p.policyDigest) {
    p.fatalIssues.push({severity:'fatal',code:'approval-changed',message:'Approved plan changed. Run Apply again to review the new plan.'});
    p.summary.fatalIssues=p.fatalIssues.length;
  }
  const approved=options.approvedPolicyDigest===p.policyDigest;
  const approvalIssues=[...p.skipIssues,...p.importIssues];
  const blockers=[...p.fatalIssues,...(approved?[]:approvalIssues)];
  const result = {effectivePlan:p.plan,okToExecute:blockers.length===0,needsSkipApproval:!p.fatalIssues.length&&approvalIssues.length>0&&!approved,
    uncertainAudio:p.uncertainAudio,approvalIssues,skipIssues:p.skipIssues,importIssues:p.importIssues,
    reviewIssues:[...p.reviewIssues,...p.importIssues],fatalIssues:p.fatalIssues,blockers,policyDigest:p.policyDigest,
    summary:{...p.summary,blockers:blockers.length}};
  if (options.includeAlternatives && !options.approvedPolicyDigest && p.uncertainAudio === 'skip') {
    const alternative=partialPreflight(original,{...options,includeAlternatives:false,uncertainAudio:'import'});
    if(!alternative.fatalIssues.length && alternative.summary.clipGroups>p.summary.clipGroups) {
      // Both choices carry their own digest; the execute call must use the
      // exact option and materialized plan the user reviewed.
      const {effectivePlan,...preview}=alternative;
      result.importAnyway=preview;
    }
  }
  return result;
}
