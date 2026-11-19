import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { executionPolicy, planDigest, verifyPlanApproval } from '../src/executionPolicy.js';
import { preflightCommandPlan, executeCommandPlan } from '../src/applyEngine.js';
import { buildCommandPlan } from '../src/commandPlan.js';
const position = { severity: 'warning', code: 'position-gap', message: 'OUT: samples 100–200 uncovered', destinationTrack:'OUT', timelineStartSamples:100,timelineEndSamples:200 };
const review = { severity: 'review', code: 'shortened-fade', message: 'Shortened OUT fade-in' };
const blank = issues => ({ issues, imports: [], createTracks: [], clipGroups: [], fadeGroups: [] });

test('automatic checks pass clean plans and known review notes without approval', () => {
  const result = preflightCommandPlan(blank([review, {severity:'warning',code:'inactive-source-track',message:'Inactive'}]), {automaticPolicy:true});
  assert.equal(result.okToExecute,true);
  assert.equal(result.reviewIssues.length,2);
  assert.equal(result.needsPositionApproval,false);
});
test('position warnings wait for approval and retain exact locations in both reports', () => {
  for (const approvePositionWarnings of [false,true]) {
    const result=preflightCommandPlan(blank([position,review]),{automaticPolicy:true,approvePositionWarnings});
    assert.equal(result.okToExecute,approvePositionWarnings);
    assert.equal(result.needsPositionApproval,!approvePositionWarnings);
    assert.deepEqual(result.positionWarnings,[position]);
    assert.deepEqual(result.reviewIssues,[review]);
  }
});
test('position approval and legacy allow-warnings never bypass fatal or unknown automatic issues', () => {
  for (const issue of [
    {severity:'fatal',code:'position-gap',message:'Fatal'},
    {severity:'fatal',code:'unresolved-fade',message:'Unsafe fade'},
    {severity:'warning',code:'new-warning',message:'Unknown'},
    {severity:'review',code:'new-review',message:'Unknown review'},
    {severity:'unexpected',code:'shortened-fade',message:'Bad severity'}
  ]) {
    const result=preflightCommandPlan(blank([position,issue]), {automaticPolicy:true,approvePositionWarnings:true,allowWarnings:true});
    assert.equal(result.okToExecute,false);
    assert.deepEqual(result.fatalIssues,[issue]);
    assert.equal(result.needsPositionApproval,false);
  }
});
test('rejected preflight performs zero Pro Tools commands', async () => {
  const commands=[];
  const client={send:async(name)=>{commands.push(name);throw Error('Unexpected request');}};
  await assert.rejects(executeCommandPlan(blank([position]),client,{automaticPolicy:true}),/blocked/);
  await assert.rejects(executeCommandPlan(blank([{severity:'fatal',code:'unresolved-fade',message:'Unsafe'}]),client,{automaticPolicy:true,approvePositionWarnings:true}),/blocked/);
  assert.deepEqual(commands,[]);
});
test('missing source remains fatal after position approval', () => {
  const result=preflightCommandPlan({...blank([position]),imports:[{path:'/nonexistent-autoedit-test/source.wav'}]}, {automaticPolicy:true,approvePositionWarnings:true});
  assert.equal(result.okToExecute,false);
  assert.equal(result.fatalIssues[0].code,'path-not-found');
});
test('approval applies only to the exact plan bytes', () => {
  const bytes=Buffer.from(JSON.stringify(blank([position])));
  assert.equal(verifyPlanApproval(bytes),false);
  assert.equal(verifyPlanApproval(bytes,planDigest(bytes)),true);
  assert.throws(()=>verifyPlanApproval(Buffer.concat([bytes,Buffer.from('\n')]),planDigest(bytes)),/plan changed/);
});
test('command plan preserves structured partial-reference warnings and blocks unclassified warnings', () => {
  const mapping={...position,code:'position-reference-partial',message:'Partial reference'};
  const plan=buildCommandPlan({clips:[],gaps:[position],warnings:['Partial reference','Unknown mapping error'],mappingDiagnostics:[mapping]});
  assert.ok(plan.issues.some(i=>i.code==='position-reference-partial'&&i.destinationTrack==='OUT'));
  assert.ok(plan.issues.some(i=>i.code==='position-gap'));
  const result=executionPolicy(plan.issues,{approvePositionWarnings:true});
  assert.equal(result.fatalIssues.length,1);
  assert.equal(result.fatalIssues[0].message,'Unknown mapping error');
});
test('CLI inspect writes blocked report successfully; stale approval fails before connecting', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'autoedit-policy-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const plan=path.join(root,'plan.json'),report=path.join(root,'report.json');
  fs.writeFileSync(plan,JSON.stringify(blank([position])));
  const cli=fileURLToPath(new URL('../src/applyCommandPlan.js',import.meta.url));
  const result=spawnSync(process.execPath,[cli,'--command-plan',plan,'--automatic-policy','--inspect','--report',report],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(report)).preflight.needsPositionApproval,true);
  const rejected=spawnSync(process.execPath,[cli,'--command-plan',plan,'--execute','--expected-session','UNUSED','--automatic-policy','--approved-plan-sha256','stale'],{encoding:'utf8'});
  assert.notEqual(rejected.status,0);
  assert.match(rejected.stderr,/Approved plan changed/);
});
