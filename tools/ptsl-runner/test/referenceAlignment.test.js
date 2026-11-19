import assert from 'node:assert/strict';
import test from 'node:test';
import { enrichSessionWithClipMetadata } from '../src/clipMetadata.js';
import { conformManifest } from '../src/conformEngine.js';

const session = tracks => ({metadata:{sampleRate:48000}, warnings:[],
  tracks:Object.entries(tracks).map(([name,events]) => ({name,events}))});

function audio(track, timelineStart, timelineEnd, sourceStart, sourceEnd, extra={}) {
  return {trackName:track, event:1, type:'audio', isFade:false, channel:1, sourceChannel:1,
    clipName:track, sourceFile:track === 'REC' ? 'recorded.wav' : 'reference.wav',
    sourceFilePath:track === 'REC' ? '/fixture/recorded.wav' : '/fixture/reference.wav',
    timelineStartSamples:timelineStart, timelineEndSamples:timelineEnd,
    durationSamples:timelineEnd-timelineStart,
    sourceStartSamples:sourceStart, sourceEndSamples:sourceStart+timelineEnd-timelineStart,
    clipListSourceStartSamples:sourceStart, clipListSourceEndSamples:sourceEnd,
    sourceFileKnownEndSamples:sourceEnd, ...extra};
}

const fade = (type,start,end) => ({trackName:'REF',type,isFade:true,channel:1,
  timelineStartSamples:start,timelineEndSamples:end,durationSamples:end-start});

function plan(reference, edit, recording=[audio('REC',0,20000,0,20000)], extra={}) {
  return conformManifest({partialPolicy:true,
    manifest:{sample_rate:48000,cues:[{recording_reference_track:'REF',edit_demo_track:'EDIT',
      target_tracks:[{recording_source_track:'REC',edit_destination_track:'OUT'}]}]},
    recordingSession:session({REF:reference,REC:recording}),demoSession:session({EDIT:edit}),...extra});
}

// Independent tiny PCM renderer: the expected samples are authored directly on
// the recording timeline, not obtained from conformEngine's coordinate formula.
// No DAW, file IO or audio device is involved.
function readPlannedSamples(result, pcm, start, end, channel=1) {
  const rendered = new Array(end-start).fill(null);
  for (const clip of result.clips.filter(c => c.channel === channel)) {
    for (let at=Math.max(start,clip.timelineStartSamples); at<Math.min(end,clip.timelineEndSamples); at++) {
      const index=at-start;
      assert.equal(rendered[index],null,'a destination sample must not be written twice');
      rendered[index]=pcm[clip.sourceStartSamples+at-clip.timelineStartSamples];
    }
  }
  return rendered;
}

test('trimmed reference preserves the authored recording alignment; source origin must not be discarded',()=>{
  // These three musical landmarks were deliberately aligned before export.
  // The reference source has 90,658 extra samples before the same performance.
  const referenceLandmarks=[94968,100000,200000];
  const recordedLandmarks=[4310,9342,109342];
  const r=plan([audio('REF',4310,300000,94968,390658)],
    referenceLandmarks.map((source,i)=>audio('EDIT',500000+i*20000,500001+i*20000,source,source+1)),
    [audio('REC',0,300000,0,300000)]);
  assert.deepEqual(r.clips.map(c=>c.sourceStartSamples),recordedLandmarks);
  assert.deepEqual(r.clips.map(c=>c.timelineStartSamples),[500000,520000,540000]);
  assert.equal(r.mappingDiagnostics.filter(d=>d.code==='unverified-mapping').length,0);
});

test('reference standalone fade-in does not shift the recorded audio by its hidden prefix',()=>{
  // Full reference clip: source [1000,1900) at recording [100,1000).
  // Its fade hides timeline [100,200) from the EDL audio event.
  const reference=[fade('fade-in',100,200),audio('REF',200,1000,1000,1900)];
  const pcm=new Float64Array(20000);
  const expected=[0.1,-0.7,0.4,0.9];
  pcm.set(expected,300); // Authored landmarks for reference source [1200,1204).
  const r=plan(reference,[audio('EDIT',10000,10004,1200,1204)]);
  assert.deepEqual(readPlannedSamples(r,pcm,10000,10004),expected);
  assert.equal(r.clips[0].sourceStartSamples,300);
  assert.equal(r.clips[0].mappingUnverified,false);
});

test('reference incoming asymmetric crossfade preserves its independent source origin',()=>{
  // A ends at R=530: 30 samples hidden after its visible audio. B starts
  // at R=530: 70 samples hidden before its visible audio. B source=2000.
  const reference=[audio('REF',100,500,1000,1430,{clipName:'A'}),
    fade('crossfade',500,600),audio('REF',600,1000,2000,2470,{clipName:'B'})];
  const pcm=new Float64Array(20000);
  const expected=[0.6,-0.2,0.3,-0.8];
  pcm.set(expected,630); // B source [2100,2104) appears here before conform.
  const r=plan(reference,[audio('EDIT',10000,10004,2100,2104)]);
  assert.deepEqual(readPlannedSamples(r,pcm,10000,10004),expected);
  assert.equal(r.clips[0].sourceStartSamples,630);
  assert.equal(r.clips[0].mappingUnverified,false);
});

test('reference fade ranges cover available recorded samples without adding reference fades to the output',()=>{
  const reference=[fade('fade-in',100,200),audio('REF',200,900,1000,1900),fade('fade-out',900,1000)];
  const r=plan(reference,[audio('EDIT',10000,10004,1010,1014),audio('EDIT',11000,11004,1890,1894)]);
  assert.deepEqual(r.clips.map(c=>c.sourceStartSamples),[110,990]);
  assert.equal(r.gaps.length,0);
  assert.deepEqual(r.transitions,[],'reference fades describe alignment, not destination fades');
});

test('reference channel selection and stereo recorded channels keep the same sample correspondence',()=>{
  const reference=[fade('fade-in',100,200),audio('REF',200,1000,1000,1900)];
  // A different second reference channel must not create an overlapping map.
  reference.push(...reference.map(e=>({...e,channel:2,sourceChannel:2,
    timelineStartSamples:e.timelineStartSamples+1000,timelineEndSamples:e.timelineEndSamples+1000})));
  const recording=[1,2].map(channel=>audio('REC',50,2000,500,2450,{channel,sourceChannel:channel}));
  const r=plan(reference,[audio('EDIT',10000,10004,1200,1204)],recording);
  assert.deepEqual(r.clips.map(c=>[c.channel,c.sourceStartSamples,c.timelineStartSamples]),[[1,750,10000],[2,750,10000]]);
  assert(!r.mappingDiagnostics.some(d=>d.code==='unverified-mapping'));
});

test('uncertain reference fade allocation stays a reviewable draft',()=>{
  const reference=[audio('REF',100,500,1000,1600,{clipName:'A'}),
    fade('crossfade',500,600),audio('REF',600,1000,2000,2450,{clipName:'B'})];
  const r=plan(reference,[audio('EDIT',10000,10004,2100,2104)]);
  assert(r.mappingDiagnostics.some(d=>d.code==='unverified-mapping'));
  assert(r.clips.every(c=>c.mappingUnverified));
});

test('GetClipList source positions, not BWF/user timestamps, determine recorded samples',()=>{
  const parsed=session({REF:[audio('REF',4310,300000,94968,390658)],
    REC:[audio('REC',0,300000,44703,344703,{clipName:'Recorded',sourceRangeBasis:'track_edl_timestamp',timestampSamples:44703})]});
  const metadata={clips:[
    {clip_full_name:'REF',file_id:'reference',src_start_point:{position:94968},src_end_point:{position:390658},is_online:true},
    {clip_full_name:'Recorded',file_id:'recorded',src_start_point:{position:0},src_end_point:{position:300000},
      user_timestamp_point:{location:'44703'},original_timestamp_point:{location:'44703'},is_online:true}
  ],file_locations:[{file_id:'reference',path:'/fixture/reference.wav'},{file_id:'recorded',path:'/fixture/recorded.wav'}]};
  const recordingSession=enrichSessionWithClipMetadata(parsed,metadata);
  const r=plan([],[audio('EDIT',500000,500004,100000,100004)],[],{recordingSession});
  assert.equal(r.clips[0].sourceStartSamples,9342);
  assert.equal(r.clips[0].timelineStartSamples,500000);
});
