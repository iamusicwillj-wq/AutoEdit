import { fadeUsesClip } from './fadeDependencies.js';
import { approvalSnapshot } from './approvalSnapshot.js';
import { inspectAudioFile } from './audioFileFormat.js';
import { partialPreflight, skipIssue } from './partialPlan.js';
import { CommandPlanExecutionError, buildSmartImportBatches, commandTrackRequest, importedFileIds,
  importFailureMessage, createdClipIds, materializeCreateAudioClipRequest, materializeSpotRequest,
  resolveTrackInsertionAnchor, reportImportStrategy } from './applyEngine.js';

const completed=r=>['TStatus_Completed','Completed',3].includes(r?.header?.status);
const failedStatus=r=>['TStatus_Failed','Failed',4].includes(r?.header?.status);
const warning=e=>(e?.is_warning??e?.isWarning)===true;
const errorType=e=>{
  const type=e?.command_error_type??e?.commandErrorType;
  return typeof type==='string'?type.replace(/^CEType_/,''):type;
};
// The SDK defines PT_Info as information, not an error or warning. Its
// is_warning flag may therefore be absent/false without indicating failure.
const information=e=>['PT_Info',200].includes(errorType(e));
const failed=r=>failedStatus(r) || (r?.errors?.errors??[]).some(e=>!warning(e)&&!information(e));
const scope=c=>({destinationTrack:c.destinationTrack,clipName:c.name,timelineStartSamples:c.timelineStartSamples,timelineEndSamples:c.timelineEndSamples});
const trackId=t=>t?.id??t?.track_id;
const sessionPath=r=>r.body?.session_path?.path??r.body?.sessionPath?.path;
// PTSL CommandError.is_warning explicitly allows successful completion. Never
// scan serialized JSON: "UnknownError" followed by "session" in another field
// previously matched /no.*session/, even for a completed, valid import.
const unavailableErrorTypes=new Set([
  'OS_NoSessionFound','OS_ProToolsIsNotAvailable','PT_NoOpenedSession',
  'PT_CommandTimeout','SDK_SessionIdParseError','SDK_GrpcGeneric',
  3,10,106,137,403,501
]);
function unavailableError(error) {
  if(warning(error)||information(error)) return false;
  if(unavailableErrorTypes.has(errorType(error))) return true;
  // Some hosts return a generic error code. Match a fault statement at the
  // start of that message, never a filename or words embedded in file errors.
  const message=String(error?.command_error_message??error?.commandErrorMessage??'').trim();
  return /^(?:(?:error|ptsl|grpc)\s*:\s*)?(?:(?:connection|transport|server)\s+(?:(?:is|was|has been)\s+)?(?:lost|closed|disconnected|unavailable|reset|refused)|no\s+(?:(?:open|opened|active|current)\s+)?session|session\s+(?:(?:is|was|has been)\s+)?(?:closed|not\s+(?:currently\s+)?open(?:ed)?)|(?:(?:command|request|operation)\s+)?(?:disconnected|timeout|timed?\s+out|deadline\s+exceeded|cancelled|canceled|unauthori[sz]ed|not\s+registered)|registration\s+required|registerconnection\s+required)(?=$|[\s:;]|[.!]\s*$)/i.test(message);
}

// Transport exceptions propagate from client.send. A nonterminal status is
// uncertain even when accompanied by an error entry; it is never retried.
function uncertain(r) {
  return (!completed(r)&&!failedStatus(r)) || (r?.errors?.errors??[]).some(unavailableError);
}

export async function executePartialPlan(original, client, {
  expectedSession, approvedPolicyDigest, onIssue, audioOperation='AOperations_ConvertAudio', uncertainAudio='skip',
  isPlanCurrent=()=>true, checkpoint=()=>{}, snapshot=approvalSnapshot
}={}) {
  const preflight=partialPreflight(original,{approvedPolicyDigest,uncertainAudio});
  if(!preflight.okToExecute) throw new CommandPlanExecutionError('Check Failed', {preflight,results:[],skipIssues:preflight.skipIssues});
  if(!expectedSession) throw new Error('Expected Session is required.');
  const plan=preflight.effectivePlan;
  delete preflight.effectivePlan;
  const results=[], skipIssues=[...preflight.skipIssues], failedClips=[], disabledTracks=new Set();
  const createdTracks=new Map(), fileIds=new Map(), createdClipIdsByName=new Map();
  let pendingIssue=null, failedCommands=0; const decisions=[];
  const record=r=>{results.push(r);if(failed(r))failedCommands++;};
  let completedClips=0, importStrategy=null, anchor=null, baselinePath=null;
  let phase=null, cachedTracks=null, activeClipTrack=null, verifiedPathResponse=null;
  function invalidateChecks() { phase=null;cachedTracks=null;activeClipTrack=null; }
  const report=()=>({execute:true,preflight,results,skipIssues,reviewIssues:preflight.reviewIssues,
    partial:skipIssues.length>0,completedClips,pendingIssue,decisions,effectivePlan:plan,createdClipIdsByName:Object.fromEntries(createdClipIdsByName),
    createdTracks:Object.fromEntries(createdTracks),importStrategy:reportImportStrategy(importStrategy),failedCommands});
  const save=()=>checkpoint(report());
  async function read(name,body={}) {
    const r=await client.send(name,body);record(r);
    if(!completed(r) || failed(r)) throw new Error(`Cannot verify current Pro Tools state: ${name}: ${JSON.stringify(r.errors)}`);
    return r;
  }
  function verifyPlan() {
    if(!isPlanCurrent()) throw new Error('Approved plan changed. Run Apply again to review the new plan.');
  }
  async function verifySession({full=false}={}) {
    verifyPlan();
    // Establish both name and path initially and after an approval pause.
    // Within an uninterrupted run the exact .ptx path identifies the Session;
    // querying its name again cannot add identity information.
    if (baselinePath===null || full) {
      const n=await read('GetSessionName');
      if(n.body?.session_name!==expectedSession) throw new Error('Current Session changed. Run Apply again.');
    }
    verifiedPathResponse=await read('GetSessionPath');
    const p=sessionPath(verifiedPathResponse);
    if(!p || (baselinePath!==null&&p!==baselinePath)) throw new Error('Current Session changed. Run Apply again.');
    baselinePath=p;
  }
  async function enterPhase(next) {
    if(phase!==next) {await verifySession();phase=next;cachedTracks=null;activeClipTrack=null;}
  }
  async function tracks() {
    const r=await read('GetTrackList',{track_filter:'',pagination_request:{limit:0,offset:0}});
    const list=r.body?.track_list??r.body?.trackList;
    if(!Array.isArray(list)) throw new Error('Could not verify destination track identities.');
    return list;
  }
  async function ownedTrack(name) {
    const list=await tracks(), matches=list.filter(t=>t.name===name);
    if(matches.length!==1 || !createdTracks.has(name) || trackId(matches[0])!==createdTracks.get(name)) return false;
    return true;
  }
  async function ask(issue) {
    invalidateChecks();
    pendingIssue=issue;save();
    await verifySession({full:true});
    const before=await snapshot(read);
    const approved=onIssue ? await onIssue(issue,report()) : false;
    decisions.push({issue,approved,at:new Date().toISOString()});save();
    if(!approved) { const e=new Error('Apply cancelled. Completed Pro Tools changes were not undone.');e.cancelled=true;throw e; }
    await verifySession({full:true}); // Never resume on the basis of an approval given in a different Session.
    if(before!==await snapshot(read)) throw new Error('Edit Session changed. Read the Edit Session and run Apply again.');
    invalidateChecks();
    pendingIssue=null;skipIssues.push(issue);save();
  }
  async function write(name,body,context,action,{sessionVerified=false}={}) {
    verifyPlan();
    if (!sessionVerified) await verifySession();
    const r=await client.send(name,body);record(r);save();
    if(uncertain(r)) throw new Error(`Pro Tools write status is uncertain: ${name}: ${JSON.stringify(r.errors)}`);
    if(failed(r)) {await ask(skipIssue('command-failed',`${name} failed: ${JSON.stringify(r.errors)}`,{...context,command:name},action));return null;}
    return r;
  }
  async function checkTrack(name) {
    if(disabledTracks.has(name)) return false;
    if(await ownedTrack(name)) return true;
    await ask(skipIssue('target-track-unverified','The target track is no longer the track created by this run. Skip this track.',{destinationTrack:name},'skip-track'));
    disabledTracks.add(name);return false;
  }
  try {
    await verifySession();
    phase='import';
    // Preserve the user's initial insertion selection before any track-selection commands.
    anchor=await resolveTrackInsertionAnchor({send:read},plan);
    let batches=[{operation:'AOperations_AddAudio',items:plan.imports}];
    if(audioOperation==='AOperations_ConvertAudio') {
      const inspectionErrors=[];
      importStrategy=await buildSmartImportBatches({send:read},plan.imports,file=>{
        try {return inspectAudioFile(file);}
        catch(error) {
          if(!['ENOENT','EACCES','EIO','EPERM','EINVAL'].includes(error.code)) throw error;
          inspectionErrors.push({file,error});return null;
        }
      }, {verifiedPathResponse});
      for(const {file,error} of inspectionErrors) await ask(skipIssue('source-read-failed',error.message,{sourcePath:file},'skip-file'));
      batches=importStrategy.batches.map(b=>({...b,items:b.items.filter(i=>!inspectionErrors.some(e=>e.file===i.path))}));
    } else if(audioOperation!=='AOperations_AddAudio') throw new Error('Unsupported audio operation.');
    // Import one file at a time so an explicit failure has a precise dependency scope.
    for(const batch of batches) for(const item of batch.items) {
      await enterPhase('import');
      const context={sourcePath:item.path};
      const response=await write('ImportAudioToClipList',{file_list:[item.path],audio_operations:batch.operation,
        ...(batch.operation==='AOperations_AddAudio'?{}:{destination_path:importStrategy.session.audioFilesPath})},context,'skip-file',{sessionVerified:true});
      if(!response) continue;
      const ids=importedFileIds(response,item.path);
      if(!ids.length || ids.some(id=>typeof id!=='string') || new Set(ids).size!==ids.length || importFailureMessage(response)) {
        await ask(skipIssue('import-no-file',importFailureMessage(response)||'Import returned no usable file ID; dependent clips will be skipped.',context,'skip-file'));continue;
      }
      fileIds.set(item.path,ids);
    }
    for(const clip of plan.clipGroups) if(!fileIds.has(clip.sourceFilePath)) {
      failedClips.push(clip);
      skipIssues.push(skipIssue('dependent-clip','Skip this clip because its source file was not imported.',scope(clip)));
    }
    const usable=plan.clipGroups.filter(c=>!failedClips.includes(c));
    if(!usable.length) throw new Error('Nothing can be applied after skipping the affected items.');
    for(const track of plan.createTracks) {
      const name=track.track_name;
      if(!usable.some(c=>c.destinationTrack===name))continue;
      await enterPhase('create-tracks');
      cachedTracks ??= await tracks();
      if(cachedTracks.some(t=>t.name.toLowerCase()===name.toLowerCase())) {
        await ask(skipIssue('target-track-exists','A destination track appeared after preparation; skip this track without modifying it.',{destinationTrack:name},'skip-track'));
        disabledTracks.add(name);continue;
      }
      const request=commandTrackRequest(track);
      request.insertion_point_position=anchor?'TIPoint_After':'TIPoint_Last';
      if(anchor) request.insertion_point_track_name=anchor.name;
      const response=await write('CreateNewTracks',request,{destinationTrack:name},'skip-track',{sessionVerified:true});
      if(!response){disabledTracks.add(name);continue;}
      cachedTracks=await tracks();
      const matches=cachedTracks.filter(t=>t.name===name);
      if(matches.length!==1 || !trackId(matches[0])) {
        await ask(skipIssue('target-track-unverified','Could not verify the newly created track identity. Skip this track.',{destinationTrack:name},'skip-track'));
        disabledTracks.add(name);continue;
      }
      createdTracks.set(name,trackId(matches[0]));
      if(anchor)anchor={name};save();
    }
    for(const group of usable) {
      // Reuse identity only for uninterrupted consecutive clips on this track.
      // An approval/error or track change invalidates the entire group cache.
      if(disabledTracks.has(group.destinationTrack)) {failedClips.push(group);continue;}
      await enterPhase('clips:'+group.destinationTrack);
      let request;
      try { request=materializeCreateAudioClipRequest(group,fileIds); }
      catch(error) {await ask(skipIssue('missing-channels',error.message,scope(group)));failedClips.push(group);continue;}
      const created=await write('CreateAudioClips',request,scope(group),'skip-clip',{sessionVerified:true});
      if(!created){failedClips.push(group);continue;}
      const ids=createdClipIds(created);
      if(ids.length!==group.channelCount || ids.some(id=>typeof id!=='string') || new Set(ids).size!==ids.length){await ask(skipIssue('clip-no-id','Clip creation returned no usable clip ID.',scope(group)));failedClips.push(group);continue;}
      createdClipIdsByName.set(group.name,ids);
      if(activeClipTrack!==group.destinationTrack) {
        if(!await checkTrack(group.destinationTrack)){failedClips.push(group);continue;}
        activeClipTrack=group.destinationTrack;
      }
      const spotted=await write('SpotClipsByID',materializeSpotRequest(group,ids),scope(group),'skip-clip',{sessionVerified:true});
      if(!spotted){failedClips.push(group);continue;}
      completedClips++;save();
    }
    for(const group of plan.fadeGroups) {
      if(disabledTracks.has(group.destinationTrack) || failedClips.some(c=>fadeUsesClip(group,c))) {
        skipIssues.push(skipIssue('dependent-fade','Skip this fade because a required clip or track was skipped.',scope(group),'skip-fade'));continue;
      }
      // Selecting by name does not modify audio. The fresh selected-track ID
      // and timeline checks below guard the actual fade write, even if a track
      // is deleted/replaced during selection. No full track-list read needed.
      for(const [name,request] of [['SelectTracksByName',group.selectTracksByNameRequest],['SetTimelineSelection',group.setTimelineSelectionRequest],['CreateFadesBasedOnPreset',group.createFadesBasedOnPresetRequest]]) {
        // Selection failure must never fall through to a fade write on another track.
        if(name==='CreateFadesBasedOnPreset') {
          await verifySession();
          const selected=await read('GetTrackList',{track_filter_list:[{filter:'SelectedExplicitly',is_inverted:false}],is_filter_list_additive:true,pagination_request:{limit:0,offset:0}});
          const list=selected.body?.track_list??selected.body?.trackList;
          const selection=await read('GetTimelineSelection',{location_type:'TLType_Samples'});
          if(!Array.isArray(list)||list.length!==1||list[0].name!==group.destinationTrack||trackId(list[0])!==createdTracks.get(group.destinationTrack)
            || Number(selection.body?.in_time)!==group.timelineStartSamples || Number(selection.body?.out_time)!==group.timelineEndSamples) {
            await ask(skipIssue('fade-selection-changed','Track selection changed before creating the fade; skip this fade.',scope(group),'skip-fade'));break;
          }
        }
        if(!await write(name,request,scope(group),'skip-fade',{sessionVerified:true}))break;
      }
    }
    if(!completedClips) throw new Error('Nothing can be applied after skipping the affected items.');
    save();return report();
  } catch(error) {
    const result={...report(),cancelled:Boolean(error.cancelled),error:error.message};checkpoint(result);
    throw new CommandPlanExecutionError(error.message,result);
  }
}
