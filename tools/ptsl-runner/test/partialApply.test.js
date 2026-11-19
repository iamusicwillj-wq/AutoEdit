import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {buildCommandPlan} from '../src/commandPlan.js';
import {partialPreflight,preparePartialPlan} from '../src/partialPlan.js';
import {executePartialPlan} from '../src/partialApply.js';
import {runtimeApproval} from '../src/runtimeApproval.js';
import {approvalSnapshot} from '../src/approvalSnapshot.js';
const ok=(body={})=>({header:{status:'TStatus_Completed'},body});
const fail=message=>({header:{status:'TStatus_Failed'},body:{},errors:{errors:[{command_error_message:message,is_warning:false}]}});
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ae-partial-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const clips=[], transitions=[];
  for(const [track,count] of [['A',2],['B',1]]) {
    const file=path.join(root,track+'.wav');fs.writeFileSync(file,'test audio');
    for(let ch=1;ch<=count;ch++) {
      clips.push({destinationTrack:track,sourceFilePath:file,sourceFile:track+'.wav',sourceClipName:track,
        channel:ch,sourceChannel:ch,sourceStartSamples:0,sourceEndSamples:1000,timelineStartSamples:1000,timelineEndSamples:2000,isMuted:true});
      if(track==='A')transitions.push({type:'fade-in',destinationTrack:track,channel:ch,timelineStartSamples:1000,timelineEndSamples:1100});
    }
  }
  return buildCommandPlan({project:'Partial test',sampleRate:48000,clips,transitions});
}
function mock(hook=()=>{}) {
  const state={name:'Edit',path:'/test/Edit.ptx',tracks:[],selected:[],selection:{},calls:[]};
  const client={async send(command,body={}) {
    state.calls.push({command,body});
    const override=await hook(command,body,state);if(override)return override;
    switch(command) {
      case 'GetSessionName':return ok({session_name:state.name});
      case 'GetSessionPath':return ok({session_path:{path:state.path}});
      case 'GetTrackList':return ok({track_list:body.track_filter_list?state.tracks.filter(t=>state.selected.includes(t.name)):state.tracks});
      case 'ImportAudioToClipList':return ok({file_list:[{original_input_path:body.file_list[0],destination_file_list:[{file_id:body.file_list[0]}]}]});
      case 'CreateNewTracks':state.tracks.push({name:body.track_name,id:'new-'+body.track_name,index:state.tracks.length});return ok();
      case 'CreateAudioClips':return ok({clip_list:[{clip_ids:body.clip_list[0].clip_info.map((_,i)=>body.clip_list[0].name+'-'+i)}]});
      case 'SelectTracksByName':state.selected=body.track_names;return ok();
      case 'SetTimelineSelection':state.selection=body;return ok();
      case 'GetTimelineSelection':return ok(state.selection);
      case 'SpotClipsByID':case 'CreateFadesBasedOnPreset':return ok();
      default:throw new Error('Unexpected command '+command);
    }
  }};
  return {client,state};
}
const options={expectedSession:'Edit',audioOperation:'AOperations_AddAudio',snapshot:async()=> 'unchanged'};
const writes=s=>s.calls.filter(c=>!c.command.startsWith('Get'));

function touchingCrossfadePlan(t,cut) {
  const base=fixture(t),file=base.imports[0].path;
  return buildCommandPlan({clips:[0,1].map(i=>({destinationTrack:'A',sourceFilePath:file,
    channel:1,sourceChannel:1,sourceStartSamples:i*1000,sourceEndSamples:(i+1)*1000,
    timelineStartSamples:cut+(i-1)*1000,timelineEndSamples:cut+i*1000})),
    transitions:[{type:'crossfade',destinationTrack:'A',channel:1,
      timelineStartSamples:1000,timelineEndSamples:1100,timelineEditBoundarySamples:cut}]});
}
for(const cut of [1000,1100]) test(`preflight removes a crossfade when its touching arm is skipped (cut=${cut})`,t=>{
  const p=touchingCrossfadePlan(t,cut),affected=p.clipGroups[cut===1100?1:0];
  p.issues.push({severity:'warning',code:'unverified-mapping',message:'Review source',...affected});
  const pre=partialPreflight(p);
  assert.equal(pre.summary.clipGroups,1);assert.equal(pre.summary.fadeGroups,0);
  assert(pre.skipIssues.some(i=>i.action==='skip-fade'));
});
for(const cut of [1000,1100]) test(`runtime removes a crossfade when its touching arm fails (cut=${cut})`,async t=>{
  const p=touchingCrossfadePlan(t,cut),affected=p.clipGroups[cut===1100?1:0];
  const m=mock((c,b)=>c==='CreateAudioClips'&&b.clip_list[0].name===affected.name?fail('Cannot create this clip'):null);
  const r=await executePartialPlan(p,m.client,{...options,onIssue:async()=>true});
  assert.equal(r.completedClips,1);assert(r.skipIssues.some(i=>i.code==='dependent-fade'));
  assert.equal(m.state.calls.filter(c=>c.command==='CreateFadesBasedOnPreset').length,0);
});
test('session checks are grouped while destination identity and fade selection remain fresh',async t=>{
  const p=touchingCrossfadePlan(t,1100),m=mock();
  const r=await executePartialPlan(p,m.client,options);
  assert.equal(r.completedClips,2);
  const calls=m.state.calls;
  assert.equal(calls.filter(c=>c.command==='GetSessionName').length,1);
  assert.equal(calls.filter(c=>c.command==='GetSessionPath').length,4);
  for(let i=0;i<calls.length;i++) {
    if(calls[i].command==='SpotClipsByID' && !calls.slice(0,i).some(c=>c.command==='SpotClipsByID')) assert.equal(calls[i-1].command,'GetTrackList');
    if(calls[i].command==='CreateFadesBasedOnPreset') {
      assert.equal(calls[i-1].command,'GetTimelineSelection');
      assert.equal(calls[i-2].command,'GetTrackList');
      assert.equal(calls[i-3].command,'GetSessionPath');
    }
  }
});

function writeImportAudio(plan) {
  for(const item of plan.imports) {
    const channels=plan.clipGroups.find(c=>c.sourceFilePath===item.path).channelCount;
    const dataSize=1000*channels*3, wav=Buffer.alloc(44+dataSize);
    wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);
    wav.writeUInt16LE(1,20);wav.writeUInt16LE(channels,22);wav.writeUInt32LE(48000,24);
    wav.writeUInt32LE(48000*channels*3,28);wav.writeUInt16LE(channels*3,32);wav.writeUInt16LE(24,34);
    wav.write('data',36);wav.writeUInt32LE(dataSize,40);fs.writeFileSync(item.path,wav);
  }
}
function imported(body,errors=[]) {
  return {...ok({failure_list:[],file_list:[{original_input_path:body.file_list[0],
    destination_file_list:[{file_id:'imported-'+path.basename(body.file_list[0])}]}]}),errors:{errors}};
}

for(const operation of ['AOperations_AddAudio','AOperations_ConvertAudio']) {
  for(const order of ['type-first','message-first']) test(`completed UID warning continues through clips/fades (${operation}, ${order})`,async t=>{
    const p=fixture(t);writeImportAudio(p);
    const type={command_error_type:'PT_UnknownError'};
    const message={command_error_message:"Audio Files:take.1.wav has the same unique identifier as a file already in this session.\n  Pro Tools must stamp this file with a unique identifier in order to use it."};
    // The actual PTSL response has type before message. Diagnostic JSON sorts
    // keys, so both orders must have the same semantics.
    const warning={...(order==='type-first'?{...type,...message}:{...message,...type}),is_warning:true};
    const m=mock((c,b)=>{
      if(c==='GetSessionAudioFormat')return ok({current_setting:'SAF_WAVE'});
      if(c==='GetSessionSampleRate')return ok({sample_rate:'SR_48000'});
      if(c==='GetSessionBitDepth')return ok({current_setting:'Bit24'});
      if(c==='GetSessionInterleavedState')return ok({current_setting:true});
      if(c==='ImportAudioToClipList')return imported(b,[{command_error_type:'PT_Info',command_error_message:'Importing audio file',is_warning:true},warning]);
    });
    let prompts=0;
    const r=await executePartialPlan(p,m.client,{...options,audioOperation:operation,onIssue:async()=>{prompts++;return true;}});
    assert.equal(prompts,0);assert.equal(r.completedClips,2);assert.equal(r.failedCommands,0);assert.equal(r.partial,false);
    const imports=m.state.calls.filter(c=>c.command==='ImportAudioToClipList');
    assert.equal(imports.length,2);
    assert(imports.every(c=>c.body.audio_operations===(operation==='AOperations_AddAudio'?operation:'AOperations_CopyAudio')));
    assert.equal(m.state.calls.filter(c=>c.command==='SpotClipsByID').length,2);
    assert.equal(m.state.calls.filter(c=>c.command==='CreateFadesBasedOnPreset').length,1);
    assert(r.results.filter(r=>r.errors?.errors?.length).every(r=>r.errors.errors.some(e=>e.command_error_message===message.command_error_message)));
  });
}

test('completed ordinary warnings cannot become connection failures through their message or field order',async t=>{
  const p=fixture(t),m=mock((c,b)=>c==='ImportAudioToClipList'?imported(b,[
    {commandErrorType:'PT_UnknownError',commandErrorMessage:'Importing /test/no-session timeout connection.wav',isWarning:true}
  ]):null);
  const r=await executePartialPlan(p,m.client,options);
  assert.equal(r.completedClips,2);assert.equal(r.partial,false);
});

for(const type of ['PT_Info','CEType_PT_Info',200]) test(`completed SDK informational response is not a failure (${type})`,async t=>{
  const p=fixture(t),m=mock((c,b)=>c==='ImportAudioToClipList'?imported(b,[
    {command_error_type:type,command_error_message:'Importing /test/connection closed.wav',is_warning:false}
  ]):null);
  let prompts=0;
  const r=await executePartialPlan(p,m.client,{...options,onIssue:async()=>{prompts++;return true;}});
  assert.equal(prompts,0);assert.equal(r.failedCommands,0);assert.equal(r.completedClips,2);assert.equal(r.partial,false);
});

test('a failed status remains a failure even with only informational entries',async t=>{
  const p=fixture(t);let first=true;
  const m=mock((c,b)=>{
    if(c!=='ImportAudioToClipList'||!first)return;
    first=false;
    return {...imported(b,[{commandErrorType:'PT_Info',commandErrorMessage:'Import attempt finished'}]),header:{status:'TStatus_Failed'}};
  });
  let prompts=0;
  const r=await executePartialPlan(p,m.client,{...options,onIssue:async()=>{prompts++;return true;}});
  assert.equal(prompts,1);assert.equal(r.failedCommands,1);assert.equal(r.completedClips,1);assert.equal(r.partial,true);
});

test('ordinary file errors mentioning timeout or session paths remain skippable',async t=>{
  const p=fixture(t);let first=true;
  const m=mock(c=>{
    if(c!=='ImportAudioToClipList'||!first)return;
    first=false;
    return {header:{status:'TStatus_Failed'},body:{},errors:{errors:[
      {command_error_type:'PT_UnknownError',command_error_message:'Source file unavailable: /Audio/no session/connection closed/timeout.wav',is_warning:false},
      {command_error_type:'PT_UnknownError',command_error_message:'timeout.wav could not be imported',is_warning:false}
    ]}};
  });
  let prompts=0;
  const r=await executePartialPlan(p,m.client,{...options,onIssue:async()=>{prompts++;return true;}});
  assert.equal(prompts,1);assert.equal(r.completedClips,1);assert.equal(r.partial,true);
});

for(const kind of ['missing-file-id','failure-list','nonwarning-error']) test(`completed response still checks ${kind}`,async t=>{
  const p=fixture(t);let first=true;
  const m=mock((c,b)=>{
    if(c!=='ImportAudioToClipList'||!first)return;
    first=false;
    const response=imported(b,[{command_error_type:'PT_Info',command_error_message:'Import complete',is_warning:true}]);
    if(kind==='missing-file-id')response.body.file_list[0].destination_file_list=[];
    if(kind==='failure-list')response.body.failure_list=[{file_path:b.file_list[0],failure_message:'File could not be imported'}];
    if(kind==='nonwarning-error')response.errors.errors.push({command_error_type:'PT_UnknownError',command_error_message:'Unsupported source',is_warning:false});
    return response;
  });
  let prompts=0;
  const r=await executePartialPlan(p,m.client,{...options,onIssue:async i=>{prompts++;assert.equal(i.action,'skip-file');return true;}});
  assert.equal(prompts,1);assert.equal(r.completedClips,1);assert.equal(r.partial,true);
  assert(m.state.calls.filter(c=>c.command==='SpotClipsByID').every(c=>c.body.dst_track_name==='B'));
});

for(const [status,type,message] of [
  ['TStatus_Failed','CEType_PT_NoOpenedSession','工程未打开'],
  ['TStatus_Failed',137,'请求超时'],
  ['TStatus_Completed','PT_UnknownError','Connection closed'],
  ['TStatus_Failed','PT_UnknownError','No session is open'],
  ['TStatus_Failed','SDK_GrpcGeneric','服务不可用'],
  ['TStatus_InProgress','PT_UnknownError','Unsupported source']
]) test(`unavailable or unfinished write stops without approval/retry (${status}, ${type}, ${message})`,async t=>{
  const p=fixture(t),m=mock(c=>c==='ImportAudioToClipList'?{
    header:{status},body:{},errors:{errors:[{command_error_type:type,command_error_message:message,is_warning:false}]}
  }:null);
  let prompts=0;
  await assert.rejects(executePartialPlan(p,m.client,{...options,onIssue:async()=>{prompts++;return true;}}),/write status is uncertain/);
  assert.equal(prompts,0);assert.equal(m.state.tracks.length,0);
  assert.equal(m.state.calls.filter(c=>c.command==='ImportAudioToClipList').length,1);
});

test('partial apply retains stereo channels, clip mute, and fade request on a clean plan',async t=>{
  const p=fixture(t),m=mock(); const r=await executePartialPlan(p,m.client,options);
  assert.equal(r.completedClips,2);assert.equal(r.partial,false);
  assert.equal(m.state.calls.filter(c=>c.command==='CreateFadesBasedOnPreset').length,1);
  const spots=m.state.calls.filter(c=>c.command==='SpotClipsByID');assert.equal(spots.length,2);
  assert.equal(spots[0].body.clip_instance_attributes.is_muted,true);
  assert.equal(m.state.calls.find(c=>c.command==='CreateAudioClips').body.clip_list[0].clip_info.length,2);
});
test('missing source drops whole stereo clip, dependent fade and empty track, requires bound approval',async t=>{
  const p=fixture(t);fs.unlinkSync(p.imports[0].path);
  const prepared=preparePartialPlan(p);assert.equal(prepared.plan.clipGroups.length,1);assert.equal(prepared.plan.fadeGroups.length,0);
  assert.deepEqual(prepared.plan.createTracks.map(t=>t.track_name),['B']);
  const pre=partialPreflight(p);assert.equal(pre.needsSkipApproval,true);
  const m=mock();await assert.rejects(executePartialPlan(p,m.client,options));assert.equal(m.state.calls.length,0);
  const result=await executePartialPlan(p,m.client,{...options,approvedPolicyDigest:pre.policyDigest});
  assert.equal(result.partial,true);assert.equal(result.completedClips,1);
});
test('unresolved fade is skippable without losing verified audio',t=>{
  const p=fixture(t);p.issues.push({severity:'fatal',code:'unresolved-fade',message:'Missing handle',destinationTrack:'A',timelineStartSamples:1000,timelineEndSamples:1100});
  const r=preparePartialPlan(p);assert.equal(r.plan.clipGroups.length,2);assert.equal(r.plan.fadeGroups.length,0);assert.equal(r.fatalIssues.length,0);assert.equal(r.skipIssues[0].action,'skip-fade');
});
test('unmapped reference collapses four channel fade errors into one approval item',t=>{
  const p=fixture(t);p.clipGroups=p.clipGroups.filter(c=>c.destinationTrack!=='A');p.fadeGroups=[];
  const base={destinationTrack:'A',timelineStartSamples:1000,timelineEndSamples:2000};
  p.issues=[{...base,severity:'warning',code:'unverified-mapping',message:'Wrong reference',demoClipName:'other-source'}];
  for(let i=0;i<4;i++)p.issues.push({...base,severity:'fatal',code:'unresolved-fade',message:'Fade '+i});
  const r=preparePartialPlan(p);assert.equal(r.skipIssues.length,1);assert.equal(r.fatalIssues.length,0);assert.equal(r.plan.clipGroups.length,1);
});
test('unverified range drops any overlapping clip across all channels and its fades',t=>{
  const p=fixture(t);p.issues.push({severity:'warning',code:'unverified-recording-range',message:'Ambiguous',destinationTrack:'A',timelineStartSamples:1200,timelineEndSamples:1300});
  const r=preparePartialPlan(p);assert.deepEqual(r.plan.clipGroups.map(c=>c.destinationTrack),['B']);assert.equal(r.plan.fadeGroups.length,0);
});
test('Import Anyway retains uncertain stereo audio only after approving that exact choice',async t=>{
  const p=fixture(t);p.issues.push({severity:'warning',code:'unverified-mapping',message:'Ambiguous source position',
    destinationTrack:'A',timelineStartSamples:1000,timelineEndSamples:2000});
  const pre=partialPreflight(p,{includeAlternatives:true});
  assert.equal(pre.summary.clipGroups,1);assert.equal(pre.importAnyway.summary.clipGroups,2);
  const m=mock();
  await assert.rejects(executePartialPlan(p,m.client,{...options,uncertainAudio:'import',approvedPolicyDigest:pre.policyDigest}));
  assert.equal(m.state.calls.length,0);
  const r=await executePartialPlan(p,m.client,{...options,uncertainAudio:'import',approvedPolicyDigest:pre.importAnyway.policyDigest});
  assert.equal(r.completedClips,2);assert.equal(r.partial,false);
  assert(r.reviewIssues.some(i=>i.action==='import-for-review'));
  assert.equal(m.state.calls.filter(c=>c.command==='CreateFadesBasedOnPreset').length,1);
  assert.equal(m.state.calls.filter(c=>c.command==='SpotClipsByID')[0].body.src_clips.length,2);
});
test('Import Anyway cannot bypass unavailable files, invalid ranges or corrupt requests',t=>{
  for(const kind of ['file','range','request']) {
    const p=fixture(t);p.issues.push({severity:'warning',code:'unverified-mapping',message:'Ambiguous',destinationTrack:'A',timelineStartSamples:1000,timelineEndSamples:2000});
    if(kind==='file')fs.unlinkSync(p.imports[0].path);
    if(kind==='range')p.clipGroups[0].sourceStartSamples=-1;
    if(kind==='request')p.clipGroups[0].spotClipsByIdRequest.dst_track_name='Original';
    const pre=partialPreflight(p,{uncertainAudio:'import'});
    if(kind==='request')assert(pre.fatalIssues.length>0);
    else {assert.equal(pre.summary.clipGroups,1);assert(pre.skipIssues.some(i=>['path-not-found','invalid-clip-range'].includes(i.code)));}
  }
});
test('Import Anyway is available when every clip is uncertain, but approval is still mandatory',async t=>{
  const p=fixture(t);p.issues=p.clipGroups.map(c=>({severity:'warning',code:'unverified-mapping',message:'Ambiguous',...c}));
  const pre=partialPreflight(p,{includeAlternatives:true});
  assert(pre.fatalIssues.some(i=>i.code==='nothing-to-apply'));
  assert.equal(pre.importAnyway.summary.clipGroups,2);
  const m=mock();await assert.rejects(executePartialPlan(p,m.client,{...options,uncertainAudio:'import'}));
  assert.equal(m.state.calls.length,0);
});
test('scoped unknown error skips only its track; unscoped unknown error blocks',t=>{
  const p=fixture(t);p.issues=[{severity:'fatal',code:'unknown',message:'Unknown local issue',destinationTrack:'A'}];
  assert.equal(preparePartialPlan(p).plan.createTracks.length,1);
  delete p.issues[0].destinationTrack;assert.equal(partialPreflight(p).needsSkipApproval,false);assert.equal(partialPreflight(p).fatalIssues.length,1);
});
test('missing source changes invalidate earlier approval even if newly restored and clean',t=>{
  const p=fixture(t);const file=p.imports[0].path;fs.unlinkSync(file);const pre=partialPreflight(p);
  fs.writeFileSync(file,'restored');const next=partialPreflight(p,{approvedPolicyDigest:pre.policyDigest});
  assert.equal(next.okToExecute,false);assert.equal(next.fatalIssues[0].code,'approval-changed');
});
test('no useful content prevents every host call including track creation',async t=>{
  const p=fixture(t);for(const i of p.imports)fs.unlinkSync(i.path);const m=mock();
  const pre=partialPreflight(p);assert.equal(pre.needsSkipApproval,false);assert(pre.fatalIssues.some(i=>i.code==='nothing-to-apply'));
  await assert.rejects(executePartialPlan(p,m.client,{...options,approvedPolicyDigest:pre.policyDigest}));assert.equal(m.state.calls.length,0);
});
for(const corrupt of ['spot','track','source','fade'])test('corrupt '+corrupt+' request blocks before writes',async t=>{
  const p=fixture(t);if(corrupt==='spot')p.clipGroups[0].spotClipsByIdRequest.dst_track_name='original';
  if(corrupt==='track')p.createTracks[0].number_of_tracks=2;
  if(corrupt==='source')p.clipGroups[0].createAudioClipRequest.clip_list[0].clip_info[0].src_start_point.position=900;
  if(corrupt==='fade')p.fadeGroups[0].selectTracksByNameRequest.selection_mode='SMode_Add';
  const m=mock();await assert.rejects(executePartialPlan(p,m.client,options));assert.equal(m.state.calls.length,0);
});
test('failed import prompts once and skips only dependent track and clips',async t=>{
  const p=fixture(t),m=mock((c,b)=>c==='ImportAudioToClipList'&&b.file_list[0].endsWith('A.wav')?fail('unsupported file'):null);
  const prompts=[];const r=await executePartialPlan(p,m.client,{...options,onIssue:async i=>{prompts.push(i);return true;}});
  assert.equal(prompts.length,1);assert.equal(prompts[0].action,'skip-file');assert.equal(r.completedClips,1);assert(r.partial);
  assert.deepEqual(m.state.tracks.map(t=>t.name),['B']);assert.equal(r.decisions.length,1);assert(r.effectivePlan);
});
for(const command of ['CreateNewTracks','CreateAudioClips','SpotClipsByID'])test(command+' explicit failure skips its scope, prevents dependent fades',async t=>{
  const p=fixture(t);let fired=false;
  const m=mock((c)=>{if(c===command&&!fired){fired=true;return fail('rejected');}});
  const r=await executePartialPlan(p,m.client,{...options,onIssue:async()=>true});
  assert.equal(r.completedClips,1);assert.equal(r.partial,true);assert.equal(m.state.calls.filter(c=>c.command==='CreateFadesBasedOnPreset').length,0);
});
for(const command of ['SelectTracksByName','SetTimelineSelection','CreateFadesBasedOnPreset'])test(command+' failure preserves audio and stops local fade sequence',async t=>{
  const p=fixture(t),m=mock(c=>c===command?fail('rejected'):null);
  const r=await executePartialPlan(p,m.client,{...options,onIssue:async()=>true});
  assert.equal(r.completedClips,2);assert.equal(r.partial,true);
  if(command!=='CreateFadesBasedOnPreset')assert.equal(m.state.calls.filter(c=>c.command==='CreateFadesBasedOnPreset').length,0);
});
test('existing target never receives new clips, other new track can proceed',async t=>{
  const p=fixture(t),m=mock();m.state.tracks.push({name:'A',id:'original'});
  const r=await executePartialPlan(p,m.client,{...options,onIssue:async()=>true});assert.equal(r.completedClips,1);
  assert(m.state.calls.filter(c=>c.command==='SpotClipsByID').every(c=>c.body.dst_track_name==='B'));
});
test('track identity replacement cannot receive spot writes',async t=>{
  const p=fixture(t);const m=mock((c,b,s)=>{if(c==='CreateAudioClips')s.tracks.find(t=>t.name==='A').id='replacement';});
  const r=await executePartialPlan(p,m.client,{...options,onIssue:async()=>true});assert.equal(r.completedClips,1);
  assert(m.state.calls.filter(c=>c.command==='SpotClipsByID').every(c=>c.body.dst_track_name==='B'));
});
for(const mode of ['disconnect','pending','session','plan'])test(mode+' uncertainty cannot be overridden or retried',async t=>{
  const p=fixture(t);let current=true,prompts=0;
  const m=mock((c,b,s)=>{if(c==='ImportAudioToClipList'){
    if(mode==='disconnect')throw new Error('Connection closed');
    if(mode==='pending')return {header:{status:'TStatus_InProgress'},body:{}};
    if(mode==='session'){s.name='Other';s.path='/test/Other.ptx';}
    if(mode==='plan')current=false;
  }});
  await assert.rejects(executePartialPlan(p,m.client,{...options,isPlanCurrent:()=>current,onIssue:async()=>{prompts++;return true;}}));
  assert.equal(prompts,0);assert.equal(m.state.calls.filter(c=>c.command==='ImportAudioToClipList').length,mode==='session'?2:1);assert.equal(m.state.tracks.length,0);
});
test('session edit during runtime approval stops instead of resuming writes',async t=>{
  const p=fixture(t),m=mock(c=>c==='ImportAudioToClipList'?fail('bad file'):null);let digest='before';
  await assert.rejects(executePartialPlan(p,m.client,{...options,snapshot:async()=>digest,onIssue:async()=>{digest='after';return true;}}),/Edit Session changed/);
  assert.equal(writes(m.state).length,1);
});
test('cancelling a runtime issue keeps completed progress and pending issue in checkpoint',async t=>{
  const p=fixture(t);let spots=0,last;
  const m=mock(c=>c==='SpotClipsByID'&&++spots===2?fail('bad clip'):null);
  await assert.rejects(executePartialPlan(p,m.client,{...options,onIssue:async()=>false,checkpoint:r=>last=structuredClone(r)}));
  assert.equal(last.cancelled,true);assert.equal(last.completedClips,1);assert.equal(last.pendingIssue.command,'SpotClipsByID');assert.equal(last.decisions[0].approved,false);
});
test('fade selection drift skips fade without touching the original track',async t=>{
  const p=fixture(t),m=mock(c=>c==='GetTimelineSelection'?ok({in_time:'99',out_time:'100'}):null);
  const r=await executePartialPlan(p,m.client,{...options,onIssue:async()=>true});assert.equal(r.completedClips,2);assert.equal(r.partial,true);
  assert.equal(m.state.calls.filter(c=>c.command==='CreateFadesBasedOnPreset').length,0);
});
test('runtime IPC ignores stale tokens and honors exact approve/cancel replies',async t=>{
  const p=fixture(t),directory=path.join(path.dirname(p.imports[0].path),'approvals');
  const approve=runtimeApproval(directory,'run');
  for(const decision of [true,false]) {
    const pending=approve({message:'test'});const req=JSON.parse(fs.readFileSync(path.join(directory,'request.json')));
    fs.writeFileSync(path.join(directory,'response.json'),JSON.stringify({runID:'run',token:'stale',approved:true}));
    let settled=false;pending.then(()=>settled=true);
    await new Promise(r=>setTimeout(r,240));assert.equal(settled,false);
    fs.writeFileSync(path.join(directory,'response.json'),JSON.stringify({...req,approved:decision}));
    assert.equal(await pending,decision);assert.equal(fs.existsSync(path.join(directory,'request.json')),false);
  }
});
test('runtime snapshot ignores export time but detects clip EDL changes',async()=>{
  const text=fs.readFileSync(new URL('./fixtures/session_info_minimal.txt',import.meta.url),'utf8');
  const capture=content=>approvalSnapshot(async (c,b)=>{assert.equal(c,'ExportSessionInfoAsText');fs.writeFileSync(b.output_path,content);return ok();});
  const a=await capture(text);assert.equal(await capture(text),a);
  assert.notEqual(await capture(text.replaceAll('DEMO_STEM','Changed')),a);
});

test('missing stereo subclip ID skips the whole clip instead of importing one channel',async t=>{
  const p=fixture(t);let once=false;
  const m=mock(c=>{if(c==='CreateAudioClips'&&!once){once=true;return ok({clip_list:[{clip_ids:['left-only']}]});}});
  const r=await executePartialPlan(p,m.client,{...options,onIssue:async()=>true});
  assert.equal(r.completedClips,1);assert(m.state.calls.filter(c=>c.command==='SpotClipsByID').every(c=>c.body.dst_track_name==='B'));
});
test('unsupported local format and absent path are skippable even when their requests cannot materialize',t=>{
  for(const code of ['unsupported-track-channel-count','missing-source-file-path']) {
    const p=fixture(t),c=p.clipGroups[0];
    if(code==='unsupported-track-channel-count'){p.createTracks[0].channel_count=7;c.channelCount=7;}
    else {delete c.sourceFilePath;c.createAudioClipRequest.clip_list[0].clip_info.forEach(i=>i.file_id_ref='missing.wav');}
    p.issues.push({code,severity:'fatal',message:'Local problem',destinationTrack:'A',timelineStartSamples:1000,timelineEndSamples:2000});
    const result=partialPreflight(p);assert.equal(result.needsSkipApproval,true);assert.equal(result.fatalIssues.length,0);assert.equal(result.summary.clipGroups,1);
  }
});

test('missing source reports an omitted whole track while keeping the other track executable after approval',t=>{
  const p=fixture(t);fs.unlinkSync(p.imports.find(i=>i.path.endsWith('A.wav')).path);
  const pre=partialPreflight(p,{includeAlternatives:true});
  assert(pre.skipIssues.some(i=>i.code==='path-not-found'&&i.fileErrorCode==='ENOENT'));
  assert(pre.skipIssues.some(i=>i.code==='empty-destination-track'&&i.destinationTrack==='A'&&i.action==='skip-track'));
  assert.equal(pre.summary.createTracks,1);
  const approved=partialPreflight(p,{approvedPolicyDigest:pre.policyDigest});
  assert(approved.okToExecute);assert.deepEqual(approved.effectivePlan.createTracks.map(t=>t.track_name),['B']);
});
test('access denial is distinguished from missing file and checked once per distinct path',t=>{
  const p=fixture(t);let checks=0;
  const pre=preparePartialPlan(p,{inspectSource:path=>{checks++;return path.endsWith('A.wav')
    ? {ok:false,code:'source-access-denied',fileErrorCode:'EPERM'}:{ok:true};}});
  assert.equal(checks,2);
  assert(pre.skipIssues.some(i=>i.code==='source-access-denied'&&i.fileErrorCode==='EPERM'));
  assert(!pre.skipIssues.some(i=>i.code==='path-not-found'));
  assert.deepEqual(pre.plan.createTracks.map(t=>t.track_name),['B']);
});

test('full track scans are limited to track creation and actual Spot writes',async t=>{
  const p=touchingCrossfadePlan(t,1100),m=mock();
  await executePartialPlan(p,m.client,options);
  const full=m.state.calls.filter(c=>c.command==='GetTrackList'&&!c.body.track_filter_list);
  assert.equal(full.length,3); // two for creation, one for the consecutive destination group
  assert.equal(m.state.calls.filter(c=>c.command==='GetSessionName').length,1);
});
for(const drift of ['id','name','sessionPath']) test(`fade ${drift} drift cannot receive a fade write`,async t=>{
  const p=fixture(t),m=mock((c,b,s)=>{
    if(c==='SetTimelineSelection') {
      if(drift==='id')s.tracks.find(t=>t.name==='A').id='replacement';
      if(drift==='name')s.tracks.find(t=>t.name==='A').name='renamed';
      if(drift==='sessionPath')s.path='/different/Edit.ptx';
    }
  });
  if(drift==='sessionPath')await assert.rejects(executePartialPlan(p,m.client,{...options,onIssue:async()=>true}),/Session changed/);
  else await executePartialPlan(p,m.client,{...options,onIssue:async()=>true});
  assert.equal(m.state.calls.filter(c=>c.command==='CreateFadesBasedOnPreset').length,0);
});

for(const stage of ['ImportAudioToClipList','SpotClipsByID']) test(`same-name different-path Session switch after ${stage} blocks the next phase`,async t=>{
  const p=fixture(t),m=mock((c,b,s)=>{if(c===stage)s.path='/other/Edit.ptx';});
  await assert.rejects(executePartialPlan(p,m.client,options),/Session changed/);
  const index=m.state.calls.findIndex(c=>c.command===stage);
  assert(m.state.calls.slice(index+1).every(c=>c.command.startsWith('Get') || (stage==='ImportAudioToClipList'&&c.command==='ImportAudioToClipList')));
});
test('a replacement Session during Clip List creation cannot receive Spot even with same track names',async t=>{
  const p=fixture(t),m=mock((c,b,s)=>{if(c==='CreateAudioClips'){s.path='/other/Edit.ptx';s.tracks=s.tracks.map(t=>({...t,id:'other-'+t.id}));}});
  await assert.rejects(executePartialPlan(p,m.client,{...options,onIssue:async()=>true}),/Session changed/);
  assert.equal(m.state.calls.filter(c=>c.command==='SpotClipsByID').length,0);
});
test('full name and path checks resume after a runtime approval pause',async t=>{
  const p=fixture(t),m=mock((c,b)=>c==='ImportAudioToClipList'&&b.file_list[0].endsWith('A.wav')?fail('bad file'):null);
  await assert.rejects(executePartialPlan(p,m.client,{...options,onIssue:async()=>{m.state.name='Changed';return true;}}),/Session changed/);
  assert.equal(m.state.calls.filter(c=>c.command==='ImportAudioToClipList').length,1);
});
test('changed plan between create and Spot still blocks without an extra Session query',async t=>{
  const p=fixture(t);let current=true;
  const m=mock(c=>{if(c==='CreateAudioClips')current=false;});
  await assert.rejects(executePartialPlan(p,m.client,{...options,isPlanCurrent:()=>current}),/Approved plan changed/);
  assert.equal(m.state.calls.filter(c=>c.command==='SpotClipsByID').length,0);
});

test('approval after a failed clip invalidates the consecutive-track identity cache',async t=>{
  const p=touchingCrossfadePlan(t,1100);let spots=0;
  const m=mock(c=>c==='SpotClipsByID'&&++spots===1?fail('bad spot'):null);
  await assert.rejects(executePartialPlan(p,m.client,{...options,onIssue:async issue=>{
    if(issue.command==='SpotClipsByID')m.state.tracks[0].id='replacement';
    return true;
  }}),/Nothing can be applied/);
  assert.equal(m.state.calls.filter(c=>c.command==='SpotClipsByID').length,1);
});
test('creation failure approval invalidates the cached pre-create track list',async t=>{
  const p=fixture(t),m=mock((c,b)=>c==='CreateNewTracks'&&b.track_name==='A'?fail('cannot create'):null);
  await assert.rejects(executePartialPlan(p,m.client,{...options,onIssue:async issue=>{
    if(issue.command==='CreateNewTracks')m.state.tracks.push({name:'B',id:'external'});
    return true;
  }}),/Nothing can be applied/);
  assert.equal(m.state.calls.filter(c=>c.command==='CreateNewTracks').length,1);
  assert.equal(m.state.calls.filter(c=>c.command==='SpotClipsByID').length,0);
});
test('returning to a previous destination starts a new verified clip group',async t=>{
  const p=fixture(t);
  const extra=structuredClone(p.clipGroups[0]);extra.name+='-again';extra.createAudioClipRequest.clip_list[0].name=extra.name;
  p.clipGroups.push(extra);
  const m=mock();await executePartialPlan(p,m.client,options);
  const spots=m.state.calls.map((c,i)=>[c,i]).filter(([c])=>c.command==='SpotClipsByID');
  assert.equal(spots.length,3);
  for(const [,i] of spots)assert.equal(m.state.calls[i-1].command,'GetTrackList');
});
