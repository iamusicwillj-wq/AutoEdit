import assert from 'node:assert/strict';
import test from 'node:test';
import {applyReportOnlyOverrides,auditReferenceAlignment} from '../scripts/auditReferenceAlignment.mjs';

const aliases=['edit_demo_track','editDemoTrack','edit_demo_tracks','demo_track','demoTrack','demo_tracks'];
const valueFor=(field,name)=>field.endsWith('tracks')?[name]:name;
const target={recording_source_track:'REC',edit_destination_track:'OUT'};

function audio(track,source,channel=1,extra={}) {
  return {trackName:track,type:'audio',isFade:false,event:1,channel,sourceChannel:channel,
    clipName:`${track}-${channel}`,sourceFile:track==='REC'?'recorded.wav':'reference.wav',
    sourceFilePath:track==='REC'?'/fixture/recorded.wav':'/fixture/reference.wav',
    timelineStartSamples:track==='REC'||track==='REF'?0:10000,
    timelineEndSamples:track==='REC'||track==='REF'?2000:10004,
    durationSamples:track==='REC'||track==='REF'?2000:4,
    sourceStartSamples:source,sourceEndSamples:source+(track==='REC'||track==='REF'?2000:4),
    ...extra};
}
const session=tracks=>({metadata:{sampleRate:48000},warnings:[],tracks});
const sessions=()=>({recordingSession:session([
  {name:'REF',rawName:'raw REF',events:[audio('REF',0)]},
  {name:'REC',rawName:'raw REC',events:[audio('REC',0)]}]),
  demoSession:session([
    {name:'OLD',events:[audio('OLD',300)]},
    {name:'NEW',rawName:'raw NEW',events:[audio('NEW',700)]},
    {name:'EDIT',rawName:'raw EDIT',events:[audio('EDIT',100,1),audio('EDIT',900,2)]}])});

test('audit override replaces every target alias in either manifest container without mutating the input',()=>{
  for(const container of ['target_tracks','targetTracks']) for(const alias of aliases) {
    const original={cues:[{recording_reference_track:'REF',demo_track:'OLD',
      [container]:[{...target,[alias]:valueFor(alias,'OLD')}]}]};
    const frozen=JSON.stringify(original);
    const {manifest,overrides}=applyReportOnlyOverrides(original,{editReference:'NEW'});
    const report=auditReferenceAlignment({manifest,...sessions()});
    assert.equal(JSON.stringify(original),frozen);
    assert.equal(overrides.edit_demo_track.savedTargets[0].tracks[0],'OLD');
    assert.equal(overrides.edit_demo_track.replay,'NEW');
    assert.deepEqual(report.pairs[0].editReferences.map(r=>r.name),['NEW']);
    assert.equal(report.clipGroups[0].sourceStartSamples,700,`${container}/${alias}`);
  }
});

test('audit preserves production target-container precedence and resolves cue aliases',()=>{
  for(const alias of aliases) {
    const manifest={cues:[{recording_demo_track:'REF',[alias]:valueFor(alias,'NEW'),
      target_tracks:[target],targetTracks:[{...target,demo_track:'OLD'}]}]};
    const report=auditReferenceAlignment({manifest,...sessions()});
    assert.deepEqual(report.pairs[0].editReferences.map(r=>r.name),['NEW']);
    assert.equal(report.clipGroups[0].sourceStartSamples,700);
  }
  const withBoth={cues:[{recordingReferenceTrack:'REF',target_tracks:[{...target,demoTrack:'OLD'}],
    targetTracks:[{...target,demo_tracks:['OLD']}]}]};
  const {manifest}=applyReportOnlyOverrides(withBoth,{editReference:'NEW'});
  assert(!('demoTrack' in manifest.cues[0].target_tracks[0]));
  assert(!('demo_tracks' in manifest.cues[0].targetTracks[0]));
  assert.equal(auditReferenceAlignment({manifest,...sessions()}).clipGroups[0].sourceStartSamples,700);
});

test('audit reports the actual selected edit channel including target-over-cue precedence and raw track names',()=>{
  const variants=[{cue:{demo_channel:2},target:{}},{cue:{demoChannel:2},target:{}},
    {cue:{demo_channel:1},target:{demoChannel:2}},
    {cue:{demo_channel:1},target:{demo_channel:2,demoChannel:1}}];
  for(const variant of variants) {
    const manifest={cues:[{recordingDemoTrack:'raw REF',editDemoTrack:'raw EDIT',...variant.cue,
      targetTracks:[{...target,recording_source_track:'raw REC',...variant.target}]}]};
    const report=auditReferenceAlignment({manifest,...sessions()});
    const reference=report.pairs[0].editReferences[0];
    assert.equal(reference.name,'raw EDIT');
    assert.equal(reference.channel,2);
    assert.deepEqual(reference.events.map(e=>[e.channel,e.sourceStartSamples]),[[2,900]]);
    assert.equal(report.clipGroups[0].sourceStartSamples,900);
    assert(report.coordinateChecks.every(c=>c.differenceSamples===0));
  }
});

test('audit reports two target-specific channels independently and respects muted/hidden filters',()=>{
  const manifest={cues:[{recording_reference_track:'REF',edit_demo_track:'EDIT',target_tracks:[
    {...target,demo_channel:1},{...target,edit_destination_track:'OUT2',demo_channel:2}]}]};
  const report=auditReferenceAlignment({manifest,...sessions()});
  assert.deepEqual(report.pairs[0].editReferences.map(r=>[r.channel,r.events[0].sourceStartSamples]),[[1,100],[2,900]]);
  const input=sessions();
  input.demoSession.tracks.find(t=>t.name==='EDIT').events[1].isMuted=true;
  manifest.cues[0].target_tracks[1].include_muted_demo=false;
  const filtered=auditReferenceAlignment({manifest,...input});
  assert.equal(filtered.pairs[0].editReferences[1].events.length,0);
  assert.equal(filtered.clipGroups.length,1);
  input.demoSession.tracks.find(t=>t.name==='EDIT').isHidden=true;
  manifest.cues[0].include_hidden=false;
  const hidden=auditReferenceAlignment({manifest,...input});
  assert(hidden.pairs[0].editReferences.every(r=>r.events.length===0));
  assert.equal(hidden.clipGroups.length,0);
});

test('audit overrides accept singleton schemas and recording aliases but reject multi-cue ambiguity',()=>{
  const original={cues:{recordingDemoTrack:'OLD REF',demo_tracks:['OLD'],targetTracks:target}};
  const {manifest,overrides}=applyReportOnlyOverrides(original,{editReference:'raw NEW',recordingReference:'raw REF'});
  assert.equal(overrides.recording_reference_track.saved,'OLD REF');
  assert.equal(original.cues.recordingDemoTrack,'OLD REF');
  assert.equal(auditReferenceAlignment({manifest,...sessions()}).clipGroups[0].sourceStartSamples,700);
  assert.throws(()=>applyReportOnlyOverrides({cues:[{},{}]},{editReference:'NEW'}),/single-cue/);
});
