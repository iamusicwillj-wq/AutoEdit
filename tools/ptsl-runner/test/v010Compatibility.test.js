import assert from 'node:assert/strict';
import test from 'node:test';
import {conformManifest} from '../src/conformEngine.js';
import {buildCommandPlan} from '../src/commandPlan.js';
import {partialPreflight} from '../src/partialPlan.js';

// Reduced numeric cases from the diagnostic investigation, with anonymous
// names/paths. Test sample relationships, not private session snapshots.
const audio=(start,end,source,fullEnd=source+end-start,extra={})=>({
  type:'audio',isFade:false,isMuted:false,trackName:'REF',channel:1,sourceChannel:1,
  clipName:`clip-${start}`,sourceFile:'ref.wav',sourceFilePath:'/fixture/ref.wav',
  timelineStartSamples:start,timelineEndSamples:end,durationSamples:end-start,
  sourceStartSamples:source,sourceEndSamples:source+end-start,
  clipListSourceStartSamples:source,clipListSourceEndSamples:fullEnd,...extra});
const fade=(type,start,end)=>({type,isFade:true,channel:1,trackName:'REF',
  timelineStartSamples:start,timelineEndSamples:end,durationSamples:end-start});
function run(events,{reference=audio(0,10000000,0),length=10000000,channels=2,recordings}={}) {
  const session=tracks=>({metadata:{sampleRate:48000},tracks:tracks.map(([name,events])=>({name,events}))});
  const rec=recordings??Array.from({length:channels},(_,i)=>audio(0,length,0,length,{
    channel:i+1,sourceChannel:i+1,trackName:'REC',sourceFile:'rec.wav',sourceFilePath:'/fixture/rec.wav',sourceFileKnownEndSamples:length}));
  const conform=conformManifest({manifest:{sample_rate:48000,cues:[{
    recording_reference_track:'REF',edit_demo_track:'REF',target_tracks:[{recording_source_track:'REC',edit_destination_track:'OUT'}]}]},
    recordingSession:session([['REF',Array.isArray(reference)?reference:[reference]],['REC',rec]]),demoSession:session([['REF',events]]),partialPolicy:true});
  const commands=buildCommandPlan(conform);
  const pre=partialPreflight(commands,{exists:()=>true,includeAlternatives:true});
  const imported=partialPreflight(commands,{exists:()=>true,uncertainAudio:'import'});
  return {conform,commands,pre,imported};
}
test('a user-selected renamed reference retains V0.1 audio coordinates and both fades without approval',()=>{
  const events=[fade('fade-in',85562878,86202878),
    audio(86202878,87788478,5888000,8722286,{sourceFile:'ref.1.wav'}),fade('fade-out',87788478,88397164)];
  const r=run(events,{reference:audio(0,8722286,0),length:8722286});
  assert.equal(r.pre.summary.clipGroups,1);
  assert.equal(r.pre.summary.fadeGroups,2);
  assert.equal(r.pre.okToExecute,true);
  assert.deepEqual(r.pre.approvalIssues,[]);
  const c=r.pre.effectivePlan.clipGroups[0];
  assert.deepEqual([c.sourceStartSamples,c.sourceEndSamples,c.timelineStartSamples,c.timelineEndSamples],
    [5888000,8722286,85562878,88397164]);
  assert.equal(r.pre.effectivePlan.fadeGroups.length,2);
});
test('a trimmed reference keeps every available sample and the distant fade; missing head needs approval only',()=>{
  for(const channels of [1,2]) {
    const r=run([audio(5179959,8209557,0,3103957),fade('fade-out',8209557,8283916)],{
      reference:audio(4310,7472418,94968),length:7440643,channels});
    assert.equal(r.pre.summary.clipGroups,1);
    assert.equal(r.pre.summary.fadeGroups,1);
    assert.equal(r.pre.needsSkipApproval,true);
    assert.equal(r.pre.skipIssues.length,0);
    assert(r.pre.approvalIssues.every(i=>i.action==='keep-audio'));
    const c=r.commands.clipGroups[0];
    assert.deepEqual([c.timelineStartSamples,c.sourceStartSamples,c.timelineEndSamples],[5270617,0,8283916]);
    const gap=r.conform.gaps[0];
    assert.deepEqual([gap.timelineStartSamples,gap.timelineEndSamples],[5179959,5270617]);
    // The old first available source sample still lands at exactly its old time.
    assert.equal(c.timelineStartSamples+4310-c.sourceStartSamples,5274927);
    assert.equal(c.channelCount,channels);
  }
});
test('tail coverage can use known reference-file samples past a trimmed reference occurrence',()=>{
  const r=run([audio(10000,11000,1000)],{reference:audio(500,1500,500,1500,{sourceFileKnownEndSamples:2500}),length:2500});
  assert.equal(r.commands.clipGroups[0].timelineEndSamples,11000);
  assert.equal(r.commands.clipGroups[0].sourceEndSamples,2000);
  assert(r.commands.issues.some(i=>i.code==='extended-reference-mapping'));
});
test('partial reference tails report only missing samples and retain the covered clip',()=>{
  const r=run([audio(10000,11000,1000)],{reference:audio(0,1500,0),length:2500});
  assert.equal(r.pre.summary.clipGroups,1);
  const issue=r.pre.approvalIssues.find(i=>i.code==='position-reference-partial');
  assert.deepEqual([issue.timelineStartSamples,issue.timelineEndSamples],[10500,11000]);
  assert.equal(issue.action,'keep-audio');
  assert.equal(r.commands.clipGroups[0].timelineEndSamples,10500);
});
test('reference extrapolation never invents a mapping across repeated or unverified reference placements',()=>{
  for (const reference of [
    [audio(500,1000,500),audio(2000,2500,500)],
    audio(500,1000,500,1000,{mappingUnverified:true})
  ]) {
    const r=run([audio(10000,10200,0)],{reference,length:3000});
    assert.equal(r.imported.summary.clipGroups,0);
    assert.equal(r.imported.okToExecute,false);
    assert(!r.commands.issues.some(i=>i.code==='extended-reference-mapping'));
  }
});
test('crossfade followed by a fade-out recovers the full tail without changing visible source alignment',()=>{
  const r=run([fade('fade-in',48259200,48819200),audio(48819200,49020800,73600,905600),
    fade('crossfade',49020800,49478400),audio(49478400,51081600,905600,3120000,{isMuted:true}),
    fade('fade-out',51081600,51491200)],{length:5431705,reference:audio(0,5431705,0)});
  const last=r.commands.clipGroups.at(-1);
  assert.equal(last.timelineEndSamples,51491200);
  assert.equal(last.timelineStartSamples-last.sourceStartSamples,48185600);
  assert.equal(last.isMuted,true);
  assert.equal(r.commands.fadeGroups.length,3);
  assert.equal(r.pre.summary.fadeGroups,3);
  assert(!r.commands.issues.some(i=>i.code==='unresolved-fade'||i.code==='reference-fade-coverage'));
});
test('zero hidden handles on one crossfade arm keep asymmetric crossfades valid',()=>{
  for(const [aEnd,bStart,bEnd] of [[100,100,300],[200,200,300]]) {
    const r=run([audio(1000,1100,0,aEnd),fade('crossfade',1100,1200),audio(1200,1300,bStart,bEnd)],{length:1000,reference:audio(0,1000,0)});
    assert.equal(r.commands.fadeGroups.length,1);
    assert.equal(r.commands.fadeGroups[0].timelineStartSamples,1100);
    assert.equal(r.commands.fadeGroups[0].timelineEndSamples,1200);
  }
});
test('crossfade at the recorded file head is shortened instead of losing both clips or reading negative samples',()=>{
  const r=run([audio(73278078,74263678,0,985600),fade('crossfade',74263678,75252478),
    audio(75252478,80023678,0,5760000)],{reference:audio(43133,5747269,55864),length:5957538});
  assert.equal(r.pre.summary.clipGroups,2);
  assert.equal(r.pre.summary.fadeGroups,1);
  const cross=r.commands.fadeGroups[0];
  assert.deepEqual([cross.timelineStartSamples,cross.timelineEndSamples],[74276409,75252478]);
  const [a,b]=r.commands.clipGroups;
  assert.equal(a.timelineEndSamples,b.timelineStartSamples);
  assert.equal(b.sourceStartSamples,0);
  assert.equal(a.timelineStartSamples-a.sourceStartSamples,73290809);
  assert.equal(b.timelineStartSamples-b.sourceStartSamples,74276409);
  assert(r.commands.clipGroups.every(c=>c.sourceStartSamples>=0&&c.sourceEndSamples<=5957538));
  assert(r.pre.reviewIssues.some(i=>i.code==='shortened-fade'));
  assert.equal(r.conform.gaps.length,1); // The opening only, not a false hole under the crossfade.
});
test('a long parent clip never overlaps the next edited occurrence, even after reference extrapolation',()=>{
  const r=run([audio(73278078,74263678,0,3097600),audio(74263678,80023678,0,5760000)],{
    reference:audio(43133,5747269,55864),length:5957538});
  assert.equal(r.pre.summary.clipGroups,2);
  assert.equal(r.commands.clipGroups[0].timelineEndSamples,74263678);
  assert(r.commands.clipGroups[0].timelineEndSamples<r.commands.clipGroups[1].timelineStartSamples);
});
test('standalone fade recovery stops at a different recording take even when the source has a longer tail',()=>{
  const rec=audio(0,280,0,280,{trackName:'REC',sourceFile:'rec.wav',sourceFilePath:'/fixture/rec.wav',sourceFileKnownEndSamples:1000});
  const other=audio(280,1000,0,720,{trackName:'REC',sourceFile:'other.wav',sourceFilePath:'/fixture/other.wav',sourceFileKnownEndSamples:1000});
  const r=run([audio(1000,1100,0,100),fade('crossfade',1100,1200),audio(1200,1300,100,250),fade('fade-out',1300,1400)],{
    reference:audio(0,1000,0),recordings:[rec,other],channels:1});
  assert(r.commands.clipGroups.filter(c=>c.sourceFile==='rec.wav').every(c=>c.sourceEndSamples<=280));
  assert(r.commands.issues.some(i=>['shortened-fade','unresolved-fade','reference-fade-coverage'].includes(i.code)));
});
