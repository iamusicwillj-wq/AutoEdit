import assert from 'node:assert/strict';
import {test} from 'node:test';
import {conformManifest} from '../src/conformEngine.js';
import {buildCommandPlan} from '../src/commandPlan.js';
import {partialPreflight} from '../src/partialPlan.js';
const audio=(track,start,end,source=0,more={})=>({trackName:track,channel:1,event:1,type:'audio',isFade:false,isMuted:false,
 clipName:track+'.clip',timelineStartSamples:start,timelineEndSamples:end,durationSamples:end-start,
 sourceStartSamples:source,sourceEndSamples:source+end-start,clipListSourceStartSamples:source,clipListSourceEndSamples:source+end-start,
 sourceChannel:1,sourceFile:track+'.wav',sourceFilePath:'/audit/'+track+'.wav',sourceFileKnownEndSamples:10000,
 sourceFileOnline:true,clipIsOnline:true,...more});
const fade=(track,type,start,end,event)=>({trackName:track,channel:1,event,type,isFade:true,isMuted:false,
 clipName:'('+type+')',timelineStartSamples:start,timelineEndSamples:end,durationSamples:end-start,sourceStartSamples:null,sourceEndSamples:null});
const track=(name,events)=>({name,events,isHidden:false,isInactive:false});
const session=tracks=>({metadata:{sampleRate:48000},tracks,warnings:[]});
function fixture(){return {manifest:{sample_rate:48000,cues:[{recording_reference_track:'REF',edit_demo_track:'EDIT',target_tracks:[{recording_source_track:'REC',edit_destination_track:'OUT'}]}]},
 recordingSession:session([track('REF',[audio('REF',0,2000)]),track('REC',[audio('REC',0,4000)])]),
 demoSession:session([track('EDIT',[audio('EDIT',10000,11000,0,{sourceFile:'REF.wav'})])])};}

function run(input) {
 const conform=conformManifest({...input,partialPolicy:true});
 const commands=buildCommandPlan(conform);
 return {conform,commands,pre:partialPreflight(commands,{exists:()=>true,includeAlternatives:true})};
}
test('unrelated uncertain reference occurrence does not taint a verified mapping',()=>{
 const f=fixture();
 f.recordingSession.tracks[0].events.push(audio('REF',5000,6000,5000,{sourceFile:'other.wav',mappingUnverified:true}));
 const {pre}=run(f);
 assert.equal(pre.okToExecute,true);assert.equal(pre.summary.clipGroups,1);assert.equal(pre.summary.warnings,0);
});
test('only the interval using an uncertain reference occurrence needs review',()=>{
 const f=fixture();
 f.recordingSession.tracks[0].events.push(audio('REF',2000,3000,2000,{mappingUnverified:true,event:2}));
 f.demoSession.tracks[0].events.push(audio('EDIT',12000,12500,2200,{sourceFile:'REF.wav',event:2}));
 const {pre}=run(f);
 assert.equal(pre.summary.clipGroups,1);assert.equal(pre.importAnyway.summary.clipGroups,2);
 assert(pre.approvalIssues.every(i=>i.timelineStartSamples===12000));
});
test('missing source range outside the used recording interval does not drop any group track',()=>{
 const f=fixture();
 f.recordingSession.tracks[1].events.push(audio('REC',6000,7000,0,{sourceStartSamples:null,sourceEndSamples:null,clipListSourceStartSamples:null,clipListSourceEndSamples:null}));
 f.recordingSession.tracks.push(track('REC2',[audio('REC2',0,4000)]));
 f.manifest.cues[0].target_tracks.push({recording_source_track:'REC2',edit_destination_track:'OUT2'});
 const {pre}=run(f);assert.equal(pre.okToExecute,true);assert.equal(pre.summary.clipGroups,2);
});
test('missing source range within the used interval retains the usable take and healthy group track',()=>{
 const f=fixture();
 f.recordingSession.tracks[1].events=[audio('REC',0,500),audio('REC',500,1000,0,{sourceStartSamples:null,sourceEndSamples:null,clipListSourceStartSamples:null,clipListSourceEndSamples:null})];
 f.recordingSession.tracks.push(track('REC2',[audio('REC2',0,4000)]));
 f.manifest.cues[0].target_tracks.push({recording_source_track:'REC2',edit_destination_track:'OUT2'});
 const {pre}=run(f);assert.equal(pre.fatalIssues.length,0);assert.equal(pre.needsSkipApproval,true);
 assert.equal(pre.summary.clipGroups,2);assert(pre.approvalIssues.every(i=>i.destinationTrack==='OUT'));
});
for (const empty of [true,false]) test(`unusable target is isolated even with reference fades (empty=${empty})`,()=>{
 const f=fixture();
 f.demoSession.tracks[0].events=[fade('EDIT','fade-in',9900,10000,1),audio('EDIT',10000,11000,0,{event:2,sourceFile:'REF.wav',clipListSourceEndSamples:1100})];
 f.recordingSession.tracks.push(track('EMPTY',empty?[]:[audio('EMPTY',6000,7000)]));
 f.manifest.cues[0].target_tracks.push({recording_source_track:'EMPTY',edit_destination_track:'OUT_EMPTY'});
 const {pre}=run(f);assert.equal(pre.fatalIssues.length,0);assert.equal(pre.summary.clipGroups,1);assert.equal(pre.summary.fadeGroups,1);
 assert.equal(pre.needsSkipApproval,true);assert(pre.approvalIssues.some(i=>i.destinationTrack==='OUT_EMPTY'));
});
test('verified crossfade prefix with unused parent tail retains audio without approval',()=>{
 const f=fixture();f.recordingSession.tracks[0].events=[audio('REF',0,6000)];
 f.demoSession.tracks[0].events=[audio('EDIT',10000,11000,0,{sourceFile:'REF.wav',clipListSourceEndSamples:1100}),
 fade('EDIT','crossfade',11000,11100,2),audio('EDIT',11100,12100,2000,{event:3,sourceFile:'REF.wav',clipListSourceEndSamples:4000})];
 const {pre}=run(f);assert.equal(pre.okToExecute,true);assert.equal(pre.summary.clipGroups,2);
 assert.equal(pre.effectivePlan.clipGroups[1].timelineEndSamples,12100);
 assert.equal(pre.effectivePlan.fadeGroups[0].requiredClipNames.length,2);
});
test('an uncertain predecessor still propagates uncertainty through its crossfade',()=>{
 const f=fixture();f.recordingSession.tracks[0].events=[audio('REF',0,6000)];
 f.demoSession.tracks[0].events=[audio('EDIT',10000,11000,0,{sourceFile:'REF.wav',mappingUnverified:true,clipListSourceEndSamples:1100}),
 fade('EDIT','crossfade',11000,11100,2),audio('EDIT',11100,12100,2000,{event:3,sourceFile:'REF.wav',clipListSourceEndSamples:4000})];
 const {pre}=run(f);assert.equal(pre.okToExecute,false);assert.equal(pre.summary.clipGroups,0);assert.equal(pre.importAnyway.summary.clipGroups,2);
});
test('duplicate fade/audio gaps are one approval issue while raw evidence stays available',()=>{
 const f=fixture();
 f.demoSession.tracks[0].events=[fade('EDIT','fade-in',9900,10000,1),audio('EDIT',10000,11000,0,{event:2,sourceFile:'REF.wav',clipListSourceEndSamples:1100})];
 f.recordingSession.tracks[1].events=[audio('REC',50,4000,0)];
 const {conform,pre}=run(f);
 assert(conform.mappingDiagnostics.some(i=>i.code==='reference-fade-coverage'));
 assert.equal(pre.approvalIssues.length,1);assert.equal(pre.approvalIssues[0].code,'position-gap');
});
