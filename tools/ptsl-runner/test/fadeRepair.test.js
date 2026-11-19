import assert from 'node:assert/strict';
import test from 'node:test';
import { conformManifest } from '../src/conformEngine.js';
import { buildCommandPlan } from '../src/commandPlan.js';

function audio(trackName, start, end, source, extra={}) {
  return {trackName, channel:1, type:'audio', isFade:false, clipName:'same-name',
    timelineStartSamples:start, timelineEndSamples:end, durationSamples:end-start,
    sourceStartSamples:source, sourceEndSamples:source+end-start,
    sourceFile:trackName+'.wav', sourceFilePath:'/tmp/'+trackName+'.wav', sourceChannel:1, ...extra};
}
function fade(type,start,end) {
  return {trackName:'DEMO',channel:1,type,isFade:true,timelineStartSamples:start,timelineEndSamples:end,durationSamples:end-start};
}
const track=(name,events)=>({name,events});
function plan(edit,recordings) {
  return conformManifest({
    demoSession:{metadata:{sampleRate:48000},tracks:[track('DEMO',edit)]},
    recordingSession:{metadata:{sampleRate:48000},tracks:[
      track('REF',[audio('REF',10000,15000,0,{sourceFile:'DEMO.wav'})]),track('REC',recordings)]},
    manifest:{sample_rate:48000,cues:[{recording_reference_track:'REF',edit_demo_track:'DEMO',
      target_tracks:[{recording_source_track:'REC',edit_destination_track:'OUT'}]}]}
  });
}
function standalone() {
  return [fade('fade-in',900,1000),audio('DEMO',1000,2000,100,{
    clipListSourceStartSamples:0,clipListSourceEndSamples:1200,isMuted:true}),fade('fade-out',2000,2100)];
}
const rec=(start,end)=>audio('REC',start,end,5000+start-10000,{sourceFileKnownEndSamples:10000});
const fatals=p=>p.fadeDiagnostics.filter(d=>d.severity==='fatal');

test('shorter recorded clip recovers both fade handles without moving its audio',()=>{
  const p=plan(standalone(),[rec(10050,11150)]);
  assert.equal(fatals(p).length,0);
  assert.deepEqual(p.clips.map(c=>[c.timelineStartSamples,c.timelineEndSamples,c.sourceStartSamples,c.sourceEndSamples,c.isMuted]),[[900,2100,5000,6200,true]]);
  assert.deepEqual(p.transitions.map(t=>t.type),['fade-in','fade-out']);
  assert.equal(p.gaps.length,0);
  assert.equal(p.fadeDiagnostics.filter(d=>d.severity==='info').length,2);
});
test('continuous same-source fragments across a fade become one clip, without rendering',()=>{
  const p=plan(standalone(),[rec(10000,10050),rec(10050,11150),rec(11150,12000)]);
  assert.equal(fatals(p).length,0);
  assert.equal(p.clips.length,1);
  assert.equal(p.transitions.length,2);
  assert.equal(p.gaps.length,0);
});
test('different takes inside a fade block preflight instead of silently losing the fade',()=>{
  const p=plan(standalone(),[rec(10000,10050),{...rec(10050,12000),sourceFilePath:'/tmp/other-take.wav'}]);
  assert.equal(p.clips.length,2);
  assert.equal(fatals(p).length,1);
  const commands=buildCommandPlan(p);
  assert.equal(commands.issues[0].severity,'fatal');
  assert.match(commands.issues[0].message,/OUT.*fade-in.*900/);
});
test('missing or unverified handles never read before source start or extrapolate the reference mapping',()=>{
  for (const modified of [
    {...rec(10050,12000),sourceStartSamples:0,sourceEndSamples:1950},
    {...rec(10050,12000),sourceFileKnownEndSamples:null}
  ]) {
    const p=plan(standalone(),[modified]);
    assert.equal(p.clips[0].timelineStartSamples,950);
    assert.equal(fatals(p).length, 0);
    assert.ok(p.fadeDiagnostics.some(d=>d.code === "shortened-fade"));
    assert.equal(p.transitions.find(t=>t.type === "fade-in").timelineStartSamples,950);
  }
});
test('same clip name at repeated Edit occurrences does not borrow a fade from another occurrence',()=>{
  const edit=standalone();
  edit.push(fade('fade-in',3900,4000),audio('DEMO',4000,5000,4100,{
    clipListSourceStartSamples:4000,clipListSourceEndSamples:5100}));
  const p=plan(edit,[rec(10000,12000)]);
  assert.ok(fatals(p).some(d=>d.timelineStartSamples===3900));
  assert.equal(p.transitions.filter(t=>t.type==='fade-in').length,1);
});
test('trimmed crossfade boundary is recovered per Edit occurrence',()=>{
  const edit=[audio('DEMO',1000,1900,100,{clipListSourceStartSamples:100,clipListSourceEndSamples:1150}),
    fade('crossfade',1900,2200),audio('DEMO',2200,3000,500,{clipListSourceStartSamples:500,clipListSourceEndSamples:1450})];
  const p=plan(edit,[rec(10000,11100)]);
  assert.equal(fatals(p).length,0);
  assert.equal(p.transitions.length,1);
  assert.equal(p.clips[0].timelineEndSamples,2050);
  assert.equal(p.clips[1].timelineStartSamples,2050);
  assert.equal(p.clips[0].sourceEndSamples,6150);
  assert.ok(p.gaps.every(g=>g.timelineStartSamples>2200));
});
test('crossfade with limited tail handles is shortened to the known file end before Apply',()=>{
  const edit=[audio('DEMO',1000,1900,100,{clipListSourceStartSamples:100,clipListSourceEndSamples:1150}),
    fade('crossfade',1900,2200),audio('DEMO',2200,3000,500,{clipListSourceStartSamples:500,clipListSourceEndSamples:1450})];
  const p=plan(edit,[{...rec(10000,11100),sourceFileKnownEndSamples:6150}]);
  assert.equal(p.transitions.length,1);
  assert.equal(fatals(p).length,0);
  assert.equal(p.transitions[0].timelineEndSamples,2050);
  assert(p.fadeDiagnostics.some(i=>i.code==='shortened-fade'));
});

test('stereo channels repair identically and unverified handles produce a visible shortened-fade note',()=>{
  const recordings=[1,2].map(channel=>({...rec(10050,11150),channel,sourceChannel:channel}));
  const p=plan(standalone(),recordings);
  assert.equal(fatals(p).length,0);
  const commands=buildCommandPlan(p);
  assert.equal(commands.clipGroups.length,1);
  assert.equal(commands.clipGroups[0].channelCount,2);
  assert.equal(commands.fadeGroups.length,2);
  assert.ok(commands.fadeGroups.every(f=>f.channels.length===2));
  recordings[1].sourceFileKnownEndSamples=null;
  const failed=plan(standalone(),recordings);
  assert.equal(fatals(failed).length,0);
  assert.ok(failed.fadeDiagnostics.filter(d=>d.severity === "review").every(d=>d.channel===2));
  assert.equal(buildCommandPlan(failed).summary.fatalIssues,0);
  assert.equal(buildCommandPlan(failed).reviewNotes.length,2);
});

test('trimmed reference start allows a shortened stereo fade without shifting audio (diagnostic regression)',()=>{
  const start=11780255, fadeEnd=13354655, end=16857335;
  const sourceOffset=60752, recordingOffset=43721;
  const demo=[fade('fade-in',start,fadeEnd),audio('DEMO',fadeEnd,16483324,1574400,{
    clipListSourceStartSamples:0,clipListSourceEndSamples:end-start}),fade('fade-out',16483324,end)];
  const p=conformManifest({
    demoSession:{metadata:{sampleRate:48000},tracks:[track('DEMO',demo)]},
    recordingSession:{metadata:{sampleRate:48000},tracks:[
      track('REF',[audio('REF',recordingOffset,9683874,sourceOffset,{sourceFile:'DEMO.wav'})]),
      track('REC',[1,2].map(channel=>audio('REC',0,9606514,0,{channel,sourceChannel:channel,sourceFileKnownEndSamples:9606514})))
    ]},manifest:{sample_rate:48000,cues:[{recording_reference_track:'REF',edit_demo_track:'DEMO',target_tracks:[{recording_source_track:'REC',edit_destination_track:'OUT'}]}]}
  });
  assert.equal(fatals(p).length,0);
  assert.ok(p.clips.every(c=>c.timelineStartSamples===start+sourceOffset-recordingOffset && c.sourceStartSamples===0));
  assert.ok(p.transitions.filter(t=>t.type==='fade-in').every(t=>t.timelineStartSamples===start+sourceOffset-recordingOffset && t.timelineEndSamples===fadeEnd));
  const commands=buildCommandPlan(p);
  assert.equal(commands.summary.fatalIssues,0);
  assert.equal(commands.fadeGroups.length,2);
  assert.equal(commands.issues.filter(i=>i.code==='shortened-fade').length,2);
});
