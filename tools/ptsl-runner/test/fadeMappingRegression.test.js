import assert from 'node:assert/strict';
import test from 'node:test';
import { enrichSessionWithClipMetadata } from '../src/clipMetadata.js';
import { conformManifest } from '../src/conformEngine.js';
import { buildCommandPlan } from '../src/commandPlan.js';
import { partialPreflight } from '../src/partialPlan.js';

// Reduced, renamed numeric reproductions; no client paths or project data.
const audio=(track,start,end,source,extra={})=>({trackName:track,channel:1,sourceChannel:1,
  clipName:track+'.L',sourceFile:track+'.wav',sourceFilePath:'/test/'+track+'.wav',
  type:'audio',isFade:false,isMuted:false,timelineStartSamples:start,timelineEndSamples:end,
  durationSamples:end-start,sourceStartSamples:source,sourceEndSamples:source+end-start,...extra});
const fade=(type,start,end)=>({trackName:'REF',channel:1,type,isFade:true,
  timelineStartSamples:start,timelineEndSamples:end,durationSamples:end-start});
const session=tracks=>({metadata:{sampleRate:48000},warnings:[],tracks:tracks.map(([name,events])=>({name,events}))});
const manifest={sample_rate:48000,cues:[{recording_reference_track:'REF',edit_demo_track:'REF',
  target_tracks:[{recording_source_track:'REC',edit_destination_track:'OUT'}]}]};
function keyboardFixture() {
  const event=audio('REF',65805762,69258972,628332,{clipName:'REF-01.L'});
  const edit=session([['REF',[fade('fade-in',65597888,65805762),event,fade('fade-out',69258972,69845415)]]]);
  const metadata={clips:[4875859,9700905].map((end,i)=>({clip_full_name:'REF-01.L',clip_id:'candidate-'+i,
    file_id:'ref-file',is_online:true,src_start_point:{position:628332},src_end_point:{position:end}})),
    file_locations:[{file_id:'ref-file',path:'/test/REF.wav',info:{is_online:true}}]};
  const recording=session([['REF',[audio('REF',43721,9683874,60752)]],
    ['REC',[1,2].map(channel=>audio('REC',0,9606514,0,{channel,sourceChannel:channel,sourceFileKnownEndSamples:9606514}))]]);
  return {edit,metadata,recording};
}
function conform(edit,recording) {return conformManifest({manifest,demoSession:edit,recordingSession:recording,partialPolicy:true});}

test('same-name source revisions resolve by occurrence plus standalone fades and preserve stereo/mute',()=>{
  const f=keyboardFixture();f.edit.tracks[0].events[1].isMuted=true;
  const edit=enrichSessionWithClipMetadata(f.edit,f.metadata), event=edit.tracks[0].events[1];
  assert.equal(event.mappingUnverified,undefined);
  assert.equal(event.clipId,'candidate-0');
  assert.equal(event.clipMetadataResolution.basis,'occurrence-duration-with-fades');
  const p=buildCommandPlan(conform(edit,f.recording));
  assert.equal(p.clipGroups.length,1);assert.equal(p.clipGroups[0].channelCount,2);
  const c=p.clipGroups[0];
  assert.deepEqual([c.timelineStartSamples,c.timelineEndSamples,c.sourceStartSamples,c.sourceEndSamples,c.isMuted],
    [65597888,69845415,611301,4858828,true]);
  assert.deepEqual(p.fadeGroups.map(f=>[f.type,f.timelineStartSamples,f.timelineEndSamples]),
    [['fade-in',65597888,65805762],['fade-out',69258972,69845415]]);
  assert.equal(p.issues.length,0);
});
test('matching length cannot choose a different source origin, and uncertain draft requires a choice',()=>{
  const f=keyboardFixture();f.metadata.clips[1].src_start_point.position+=200;
  const edit=enrichSessionWithClipMetadata(f.edit,f.metadata);
  assert.equal(edit.tracks[0].events[1].mappingUnverified,true);
  const p=buildCommandPlan(conform(edit,f.recording));
  assert(p.issues.some(i=>i.code==='unverified-mapping'));
  assert(p.issues.some(i=>i.code==='reference-fade-coverage'&&i.durationSamples===207874));
  const pre=partialPreflight(p,{exists:()=>true,includeAlternatives:true});
  assert.equal(pre.summary.clipGroups,0);assert.equal(pre.importAnyway.summary.clipGroups,1);
  assert.equal(pre.importAnyway.okToExecute,false);
  assert(pre.importAnyway.approvalIssues.some(i=>i.action==='import-for-review'));
});
test('two exact candidates with distinct source identities remain ambiguous',()=>{
  const f=keyboardFixture();f.metadata.clips[1].src_end_point.position=4875859;
  f.metadata.clips[1].file_id='another-ref';
  f.metadata.file_locations.push({file_id:'another-ref',path:'/other/REF.wav',info:{is_online:true}});
  assert.equal(enrichSessionWithClipMetadata(f.edit,f.metadata).tracks[0].events[1].mappingUnverified,true);
});
test('duration resolution is per occurrence and independent of clip-list order',()=>{
  const f=keyboardFixture();f.metadata.clips.reverse();
  const first=enrichSessionWithClipMetadata(f.edit,f.metadata).tracks[0].events[1];
  assert.equal(first.clipListSourceEndSamples,4875859);
  f.edit.tracks[0].events.push(audio('REF',80000000,89072573,628332,{clipName:'REF-01.L'}));
  const events=enrichSessionWithClipMetadata(f.edit,f.metadata).tracks[0].events;
  assert.equal(events[1].clipListSourceEndSamples,4875859);
  assert.equal(events[3].clipListSourceEndSamples,9700905);
});
test('a parent clip longer than the playlist occurrence does not import its unused tail',()=>{
  const f=keyboardFixture();
  f.edit.tracks[0].events=[audio('REF',10000,11000,628332,{clipName:'REF-01.L'})];
  f.metadata.clips=[f.metadata.clips[0]];
  const commands=buildCommandPlan(conform(enrichSessionWithClipMetadata(f.edit,f.metadata),f.recording));
  assert.equal(commands.clipGroups.length,1);
  assert.equal(commands.clipGroups[0].timelineEndSamples,11000);
  assert.equal(commands.clipGroups[0].sourceEndSamples-commands.clipGroups[0].sourceStartSamples,1000);
});
function crossfadeFixture() {
  const edit=session([['REF',[fade('fade-in',6209937,7421478),
    audio('REF',7421478,7498098,800779,{clipListSourceStartSamples:800779,clipListSourceEndSamples:2273251}),
    fade('crossfade',7498098,7942120),
    audio('REF',7942120,9433165,2164340,{clipListSourceStartSamples:2164340,clipListSourceEndSamples:3655385})]]]);
  const recording=session([['REF',[audio('REF',0,3655385,0)]],
    ['REC',[1,2].map(channel=>audio('REC',0,3990528,0,{channel,sourceChannel:channel,sourceFileKnownEndSamples:3990528}))]]);
  return {edit,recording};
}
test('crossfade with zero reported right handle fills the 259711-sample hole without shifting either source mapping',()=>{
  const f=crossfadeFixture(), p=conform(f.edit,f.recording), commands=buildCommandPlan(p);
  assert.equal(commands.fadeGroups.length,2);
  assert(!commands.issues.some(i=>i.severity==='fatal'||i.code==='reference-fade-coverage'));
  for(const channel of [1,2]) {
    const [a,b]=p.clips.filter(c=>c.channel===channel);
    assert.equal(a.timelineEndSamples,b.timelineStartSamples);
    assert.equal(a.sourceStartSamples-a.timelineStartSamples,800779-6209937);
    assert.equal(b.sourceStartSamples-b.timelineStartSamples,2164340-7942120);
    assert.equal(b.timelineEndSamples,9433165);
  }
  assert(p.fadeDiagnostics.some(i=>i.code==='recovered-fade-boundary' && i.severity==='info'));
  assert(!commands.issues.some(i=>i.code==='recovered-fade-boundary'));
});
test('crossfade recovery cannot cross a competing take or read unverified file handles',()=>{
  for(const competing of [false,true]) {
    const f=crossfadeFixture();
    if(competing) f.recording.tracks[1].events.push(audio('REC',2273251,2310951,0,
      {sourceFilePath:'/test/other-take.wav',sourceFileKnownEndSamples:100000}));
    else f.recording.tracks[1].events.forEach(e=>e.sourceFileKnownEndSamples=null);
    const p=buildCommandPlan(conform(f.edit,f.recording));
    assert(p.issues.some(i=>i.code==='unresolved-fade'));
    assert(!partialPreflight(p,{exists:()=>true}).effectivePlan.fadeGroups.some(f=>f.type==='crossfade'));
  }
});
test('a fade ending outside the known reference media is shortened without exceeding that bound',()=>{
  const f=crossfadeFixture();
  f.recording.tracks[0].events=[audio('REF',0,2400000,0)];
  const p=buildCommandPlan(conform(f.edit,f.recording));
  const cross=p.fadeGroups.find(f=>f.type==='crossfade');
  assert(cross);
  assert.equal(cross.timelineEndSamples,6209937+2400000-800779);
  assert(p.issues.some(i=>i.code==='shortened-fade'));
});

function chainedRevisionFixture() {
  const edit=session([['REF',[
    fade('fade-in',42989865,43257483),
    audio('REF',43257483,45516926,35467,{clipName:'first.L',sourceFile:'edit-copy.wav'}),
    fade('crossfade',45516926,45531839),
    audio('REF',45531839,47104051,4390877,{clipName:'second.L',sourceFile:'edit-copy.wav'})
  ]]]);
  const clip=(name,start,end,id)=>({clip_full_name:name,clip_id:id,file_id:'edit-file',is_online:true,
    src_start_point:{position:start},src_end_point:{position:end}});
  const metadata={clips:[clip('first.L',35467,2571596,'current'),clip('first.L',35467,2572848,'revision'),
    clip('second.L',4390877,5968934,'right')],
    file_locations:[{file_id:'edit-file',path:'/test/edit-copy.wav',info:{is_online:true}}]};
  const recording=session([['REF',[audio('REF',0,5968934,0)]],
    ['REC',[1,2].map(channel=>audio('REC',0,5968934,0,{channel,sourceChannel:channel,sourceFileKnownEndSamples:5968934}))]]);
  return {edit,metadata,recording,clip};
}

test('fade-in plus asymmetric crossfade selects the unique same-origin revision with no warnings',()=>{
  for (const reversed of [false,true]) {
    const f=chainedRevisionFixture();
    if (reversed) f.metadata.clips.reverse();
    f.edit.tracks[0].events[3].isMuted=true;
    const edit=enrichSessionWithClipMetadata(f.edit,f.metadata);
    assert.deepEqual(edit.warnings,[]);
    const first=edit.tracks[0].events[1];
    assert.equal(first.clipId,'current');
    assert.equal(first.clipMetadataResolution.basis,'occurrence-duration-with-crossfades');
    assert.equal(first.clipMetadataResolution.hiddenPrefixSamples,267618);
    assert.equal(first.clipMetadataResolution.hiddenSuffixSamples,9068);
    const p=conform(edit,f.recording), commands=buildCommandPlan(p);
    assert.deepEqual(commands.issues,[]);
    assert.equal(commands.clipGroups.length,2);
    const [a,b]=commands.clipGroups;
    // Independent sample equations: 9068 + 5845 = the 14913-sample crossfade.
    assert.deepEqual([a.timelineStartSamples,a.timelineEndSamples,a.sourceStartSamples,a.sourceEndSamples],
      [42989865,45525994,35467,2571596]);
    assert.deepEqual([b.timelineStartSamples,b.timelineEndSamples,b.sourceStartSamples,b.sourceEndSamples],
      [45525994,47104051,4390877,5968934]);
    assert.equal(a.timelineStartSamples+303085-a.sourceStartSamples,43257483);
    assert.equal(a.channelCount,2);assert.equal(b.channelCount,2);assert.equal(b.isMuted,true);
    assert.deepEqual(commands.fadeGroups.map(f=>[f.type,f.timelineStartSamples,f.timelineEndSamples]),
      [['fade-in',42989865,43257483],['crossfade',45516926,45531839]]);
    const pre=partialPreflight(commands,{exists:()=>true,includeAlternatives:true});
    assert.equal(pre.okToExecute,true);assert.equal(pre.needsSkipApproval,false);
    assert.equal(pre.summary.warnings,0);assert.equal(p.gaps.length,0);
  }
});

test('crossfade duration cannot select a different file or a different source start',()=>{
  for(const difference of ['source','file']) {
    const f=chainedRevisionFixture();
    if(difference==='source') f.metadata.clips[1].src_start_point.position+=1;
    else {
      f.metadata.clips[1].file_id='other-file';
      f.metadata.file_locations.push({file_id:'other-file',path:'/other/edit-copy.wav',info:{is_online:true}});
    }
    const edit=enrichSessionWithClipMetadata(f.edit,f.metadata);
    assert.equal(edit.tracks[0].events[1].mappingUnverified,true);
    const pre=partialPreflight(buildCommandPlan(conform(edit,f.recording)),{exists:()=>true});
    assert.equal(pre.okToExecute,false);
  }
});

test('two complete crossfade solutions remain ambiguous instead of choosing by clip-list order',()=>{
  const f=chainedRevisionFixture();
  // The second left revision pairs exactly with a right revision 1252 samples shorter.
  f.metadata.clips.push(f.clip('second.L',4390877,5967682,'right-revision'));
  const edit=enrichSessionWithClipMetadata(f.edit,f.metadata);
  assert.equal(edit.tracks[0].events[1].mappingUnverified,true);
  assert.equal(edit.tracks[0].events[3].mappingUnverified,true);
});

test('a chain of crossfades uses both ends, including a trailing fade-out, to resolve revisions',()=>{
  const f=chainedRevisionFixture();
  f.edit=session([['REF',[fade('fade-in',1000,1100),
    audio('REF',1100,1200,0,{clipName:'a',sourceFile:'edit-copy.wav'}),fade('crossfade',1200,1300),
    audio('REF',1300,1400,500,{clipName:'b',sourceFile:'edit-copy.wav'}),fade('crossfade',1400,1500),
    audio('REF',1500,1600,1000,{clipName:'c',sourceFile:'edit-copy.wav'}),fade('fade-out',1600,1650)]]]);
  f.metadata.clips=[f.clip('a',0,240,'a-current'),f.clip('a',0,250,'a-old'),
    f.clip('b',500,690,'b-current'),f.clip('b',500,700,'b-old'),f.clip('c',1000,1220,'c')];
  // Right fade-out fixes c's prefix at 70, b's suffix at 30, then a's suffix at 40.
  const edit=enrichSessionWithClipMetadata(f.edit,f.metadata);
  assert.equal(edit.tracks[0].events[1].clipId,'a-current');
  assert.equal(edit.tracks[0].events[3].clipId,'b-current');
  assert.equal(edit.tracks[0].events[5].clipMetadataResolution.hiddenPrefixSamples,70);
  const commands=buildCommandPlan(conform(edit,f.recording));
  assert.deepEqual(commands.issues,[]);
  assert.deepEqual(commands.clipGroups.map(c=>[c.timelineStartSamples,c.timelineEndSamples,c.sourceStartSamples,c.sourceEndSamples]),
    [[1000,1240,0,240],[1240,1430,500,690],[1430,1650,1000,1220]]);
  assert.equal(commands.fadeGroups.length,4);
});

test('inconsistent crossfade lengths do not select the nearest candidate',()=>{
  const f=chainedRevisionFixture();
  f.metadata.clips[2].src_end_point.position-=1;
  assert.equal(enrichSessionWithClipMetadata(f.edit,f.metadata).tracks[0].events[1].mappingUnverified,true);
});

test('standalone fade-in on a longer parent clip uses the occurrence boundary without warnings',()=>{
  const edit=session([['REF',[fade('fade-in',42989865,43257483),
    audio('REF',43257483,45482265,35467,{clipName:'parent.L',sourceFile:'edit-copy.wav'}),
    fade('fade-in',45482265,45663633),
    audio('REF',45663633,47104051,4347148,{clipName:'next.L',sourceFile:'edit-copy.wav'})]]]);
  const f=chainedRevisionFixture();
  const metadata={...f.metadata,clips:[f.clip('parent.L',35467,2577441,'parent'),
    f.clip('next.L',4347148,5968934,'next')]};
  const p=conform(enrichSessionWithClipMetadata(edit,metadata),f.recording), commands=buildCommandPlan(p);
  assert.deepEqual(commands.issues,[]);
  assert.deepEqual(commands.clipGroups.map(c=>[c.timelineStartSamples,c.timelineEndSamples,c.sourceStartSamples,c.sourceEndSamples]),
    [[42989865,45482265,35467,2527867],[45482265,47104051,4347148,5968934]]);
  assert.equal(commands.fadeGroups.length,2);
  assert.equal(partialPreflight(commands,{exists:()=>true}).okToExecute,true);
});

function repeatedOriginFixture() {
  const f=chainedRevisionFixture();
  const occurrence=(start,end,source,name)=>audio('REF',start,end,source,{clipName:name,sourceFile:'edit-copy.wav',
    sourceRangeBasis:'track_edl_timestamp',timestampSamples:source});
  f.edit=session([['REF',[
    occurrence(1000,1100,500,'repeat'),fade('crossfade',1100,1200),
    occurrence(1200,1400,900,'repeat'),fade('crossfade',1400,1440),
    occurrence(1440,1500,1600,'last'),fade('fade-out',1500,1600)
  ]]]);
  f.metadata.clips=[f.clip('repeat',500,650,'left'),f.clip('repeat',900,1170,'middle'),f.clip('last',1600,1780,'last')];
  for(const c of f.metadata.clips)c.user_timestamp_point={location:String(c.src_start_point.position)};
  return f;
}
test('same-name different-origin occurrences recover an entire crossfade chain and trailing fade-out',()=>{
  for(const reverse of [false,true]) {
    const f=repeatedOriginFixture();if(reverse)f.metadata.clips.reverse();
    f.edit.tracks[0].events[2].isMuted=true;
    const enriched=enrichSessionWithClipMetadata(f.edit,f.metadata);
    const events=enriched.tracks[0].events.filter(e=>!e.isFade);
    assert.deepEqual(events.map(e=>e.clipId),['left','middle','last']);
    assert.deepEqual(enriched.warnings,[]);
    const commands=buildCommandPlan(conform(enriched,f.recording));
    assert.deepEqual(commands.issues,[]);
    assert.deepEqual(commands.clipGroups.map(c=>[c.timelineStartSamples,c.timelineEndSamples,c.sourceStartSamples,c.sourceEndSamples]),
      [[1000,1150,500,650],[1150,1420,900,1170],[1420,1600,1600,1780]]);
    assert(commands.clipGroups[1].isMuted);
    assert(commands.clipGroups.every(c=>c.channelCount===2));
    assert.deepEqual(commands.fadeGroups.map(f=>[f.type,f.timelineStartSamples,f.timelineEndSamples]),
      [['crossfade',1100,1200],['crossfade',1400,1440],['fade-out',1500,1600]]);
  }
});
test('timestamp narrowing still requires a complete valid fade chain and a single file identity',()=>{
  for(const failure of ['length','timestamp','file','missing-timestamp']) {
    const f=repeatedOriginFixture();
    if(failure==='length')f.metadata.clips[2].src_end_point.position--;
    if(failure==='timestamp')f.metadata.clips[0].user_timestamp_point.location='501';
    if(failure==='missing-timestamp')delete f.edit.tracks[0].events[0].timestampSamples;
    if(failure==='file') {
      f.metadata.clips[1].file_id='other';
      f.metadata.file_locations.push({file_id:'other',path:'/other/edit-copy.wav',info:{is_online:true}});
    }
    const enriched=enrichSessionWithClipMetadata(f.edit,f.metadata);
    assert.equal(enriched.tracks[0].events[0].mappingUnverified,true,failure);
    assert.equal(enriched.tracks[0].events[0].clipId,undefined,failure);
  }
});
test('standalone fades can resolve same-name origins only with corroborated timestamps and exact length',()=>{
  const f=keyboardFixture();const event=f.edit.tracks[0].events[1];
  event.timestampSamples=628332;event.sourceRangeBasis='track_edl_timestamp';
  f.metadata.clips[0].user_timestamp_point={location:'628332'};
  f.metadata.clips[1].src_start_point.position+=200;
  let enriched=enrichSessionWithClipMetadata(f.edit,f.metadata);
  assert.equal(enriched.tracks[0].events[1].clipId,'candidate-0');
  assert.deepEqual(buildCommandPlan(conform(enriched,f.recording)).issues,[]);
  f.metadata.clips[0].src_end_point.position--;
  enriched=enrichSessionWithClipMetadata(f.edit,f.metadata);
  assert.equal(enriched.tracks[0].events[1].mappingUnverified,true);
});

function trimmedRepeatedOriginFixture() {
  const f=repeatedOriginFixture();
  f.edit=session([['REF',[
    audio('REF',1000,1100,900,{clipName:'repeat',sourceFile:'edit-copy.wav',
      sourceRangeBasis:'track_edl_timestamp',timestampSamples:900,isMuted:true}),
    fade('fade-in',1100,1130),
    audio('REF',1130,1230,500,{clipName:'repeat',sourceFile:'edit-copy.wav',
      sourceRangeBasis:'track_edl_timestamp',timestampSamples:500}),
    fade('fade-out',1230,1250)
  ]]]);
  f.metadata.clips=f.metadata.clips.slice(0,2);
  f.metadata.clips[1].src_end_point.position=1040;
  return f;
}

test('a trimmed repeated origin keeps its used range and leaves the next occurrence fades intact',()=>{
  for(const reverse of [false,true]) {
    const f=trimmedRepeatedOriginFixture();
    if(reverse)f.metadata.clips.reverse();
    const edit=enrichSessionWithClipMetadata(f.edit,f.metadata);
    assert.deepEqual(edit.warnings,[]);
    assert.equal(edit.tracks[0].events[0].clipId,'middle');
    assert.equal(edit.tracks[0].events[0].clipMetadataResolution.basis,'occurrence-origin-with-trimmed-tail');
    assert.equal(edit.tracks[0].events[2].clipId,'left');
    const commands=buildCommandPlan(conform(edit,f.recording));
    assert.deepEqual(commands.issues,[]);
    assert.deepEqual(commands.clipGroups.map(c=>[c.timelineStartSamples,c.timelineEndSamples,c.sourceStartSamples,c.sourceEndSamples]),
      [[1000,1100,900,1000],[1100,1250,500,650]]);
    assert.equal(commands.clipGroups[0].isMuted,true);
    assert(commands.clipGroups.every(c=>c.channelCount===2));
    assert.deepEqual(commands.fadeGroups.map(f=>[f.type,f.timelineStartSamples,f.timelineEndSamples]),
      [['fade-in',1100,1130],['fade-out',1230,1250]]);
    const pre=partialPreflight(commands,{exists:()=>true});
    assert.equal(pre.summary.clipGroups,2);
    assert.equal(pre.needsSkipApproval,false);
    assert.equal(pre.okToExecute,true);
  }
});

test('trimmed origin recovery does not guess when existing origin evidence or source coverage is missing',()=>{
  for(const failure of ['short-source','timestamp','file','missing-timestamp']) {
    const f=trimmedRepeatedOriginFixture();
    if(failure==='short-source')f.metadata.clips[1].src_end_point.position=999;
    if(failure==='timestamp')f.metadata.clips[1].user_timestamp_point.location='901';
    if(failure==='missing-timestamp')delete f.edit.tracks[0].events[0].timestampSamples;
    if(failure==='file') {
      f.metadata.clips[1].file_id='other';
      f.metadata.file_locations.push({file_id:'other',path:'/other/edit-copy.wav',info:{is_online:true}});
    }
    const event=enrichSessionWithClipMetadata(f.edit,f.metadata).tracks[0].events[0];
    assert.equal(event.mappingUnverified,true,failure);
    assert.equal(event.clipId,undefined,failure);
  }
});
