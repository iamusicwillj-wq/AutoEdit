import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createApplyReportWriter} from '../src/applyReportWriter.js';
function setup(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'autoedit-journal-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'apply.json');
 return {file,writer:createApplyReportWriter(file,{sessionCheck:{sessionName:'Edit'}})};
}
const report=()=>({execute:true,preflight:{okToExecute:true},effectivePlan:{clipGroups:[{name:'A'}]},results:[],skipIssues:[],decisions:[],
 reviewIssues:[],createdTracks:{},createdClipIdsByName:{},completedClips:0,failedCommands:0,pendingIssue:null,partial:false});
test('journal preserves every response once and final report retains the complete schema',t=>{
 const {file,writer}=setup(t),r=report();
 for(let i=0;i<20;i++) {
  r.results.push({commandName:'GetTrackList',body:{track_list:[{id:'t'+i,name:'T'+i}]},raw:{response_body_json:'original-'+i}});
  r.createdClipIdsByName['clip'+i]=['id'+i];r.completedClips++;
  writer.checkpoint(r);
 }
 writer.finish(r);
 const final=JSON.parse(fs.readFileSync(file));
 for(const [k,v] of Object.entries(r))assert.deepEqual(final[k],v);
 assert.equal(final.inProgress,false);
 const lines=fs.readFileSync(writer.journalPath,'utf8').trim().split('\n').map(JSON.parse);
 assert.deepEqual(lines.flatMap(l=>l.results),r.results);
 assert.equal(lines.filter(l=>l.effectivePlan).length,1);
 assert.deepEqual(Object.assign({},...lines.map(l=>l.createdClipIdsByName)),r.createdClipIdsByName);
});
test('interrupted run has readable progress and a journal of approvals and pending work',t=>{
 const {file,writer}=setup(t),r=report();
 r.completedClips=2;r.pendingIssue={message:'failed clip'};r.results.push({commandName:'SpotClipsByID',header:{status:'Failed'}});
 writer.checkpoint(r);
 r.decisions.push({approved:false});r.cancelled=true;writer.checkpoint(r);
 const state=JSON.parse(fs.readFileSync(file));assert.equal(state.completedClips,2);assert.equal(state.cancelled,true);
 assert.deepEqual(state.pendingIssue,r.pendingIssue);assert.equal(state.inProgress,true);
 const entries=fs.readFileSync(writer.journalPath,'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(entries.flatMap(x=>x.results).length,1);assert.equal(entries.flatMap(x=>x.decisions)[0].approved,false);
 writer.finish({...r,error:'cancelled'});
 assert.equal(JSON.parse(fs.readFileSync(file)).error,'cancelled');
});
test('journal payload grows linearly instead of serializing the whole response history repeatedly',t=>{
 const {file,writer}=setup(t),r=report();let oldBytes=0;
 for(let i=0;i<100;i++) {
  r.results.push({commandName:'GetTrackList',body:{payload:'x'.repeat(10000)}});
  oldBytes+=Buffer.byteLength(JSON.stringify(r,null,2));writer.checkpoint(r);
 }
 writer.finish(r);
 const newBytes=fs.statSync(file).size+fs.statSync(writer.journalPath).size;
 assert(newBytes<oldBytes/10,`${newBytes} vs ${oldBytes}`);
});
