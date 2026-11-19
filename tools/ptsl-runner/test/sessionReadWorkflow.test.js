import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionReader, exportSession } from '../src/sessionReadWorkflow.js';

const ok = body => ({ header: { status: 'TStatus_Completed' }, body, errors: {} });
const fail = message => ({ header: { status: 'Failed' }, body: {}, errors: { errors: [{ command_error_message: message }] } });
function mock(responses, sessionId = 'cached') {
  const calls = [];
  const client = {
    sessionId, calls,
    async register() { calls.push('RegisterConnection'); this.sessionId = 'new'; return ok({session_id:'new'}); },
    async send(command, body) {
      calls.push(command);
      const next = responses.shift();
      if (!next) throw new Error(`Unexpected call ${command}`);
      return typeof next === 'function' ? next(command, body) : next;
    }
  };
  return client;
}
const snapshotResponses = () => [ok({session_name:'Test'}),ok({track_list:Array.from({length:300}, (_,i)=>({name:`Track ${i}`}))})];

test('snapshot reuses credentials and reads all tracks with just two sequential commands', async () => {
  const client = mock(snapshotResponses());
  const result = await new SessionReader(client).snapshot();
  assert.equal(result.track_list.length,300);
  assert.deepEqual(client.calls,['GetSessionName','GetTrackList']);
});
test('first snapshot registers only once', async () => {
  const client = mock(snapshotResponses(),'');
  await new SessionReader(client).snapshot();
  assert.deepEqual(client.calls,['RegisterConnection','GetSessionName','GetTrackList']);
});
test('empty protobuf lists support blank Sessions and no selected tracks', async () => {
  const reader = new SessionReader(mock([ok({session_name:'Empty'}), ok({}), ok({}), ok({}), ok({})]));
  assert.deepEqual((await reader.snapshot()).track_list, []);
  assert.deepEqual((await reader.selectedTracks()).track_list, []);
  const metadata = await reader.exportMetadata();
  assert.deepEqual(metadata.clips, []);
  assert.deepEqual(metadata.file_locations, []);
});
test('malformed lists are rejected rather than silently losing tracks', async () => {
  await assert.rejects(new SessionReader(mock([ok({track_list:{}})])).selectedTracks(), /Invalid track_list/);
});
test('expired credentials recover once using actual host refusal text', async () => {
  const client=mock([fail('Request refused. Use the RegisterConnection command first.'),...snapshotResponses()]);
  await new SessionReader(client).snapshot();
  assert.deepEqual(client.calls,['GetSessionName','RegisterConnection','GetSessionName','GetTrackList']);
});
test('persistent registration rejection stops after one retry', async () => {
  const client=mock([fail('session_id'),fail('session_id')]);
  await assert.rejects(new SessionReader(client).snapshot(),/did not complete/);
  assert.deepEqual(client.calls,['GetSessionName','RegisterConnection','GetSessionName']);
});
test('no open Session and busy host errors do not cause registration or retries', async () => {
  for(const message of ['There is no open session.','Pro Tools is busy']) {
    const client=mock([fail(message)]);
    await assert.rejects(new SessionReader(client).snapshot(),/did not complete/);
    assert.deepEqual(client.calls,['GetSessionName']);
  }
});
test('write commands cannot enter the read retry path', async () => {
  const client=mock([]);
  await assert.rejects(new SessionReader(client).read('CreateNewTracks'),/Not a Session read command/);
  assert.deepEqual(client.calls,[]);
});
test('selected track reads stay fresh and preserve the explicit-selection filter', async () => {
  const client=mock([(_command,body)=>{
    assert.equal(body.track_filter_list[0].filter,'SelectedExplicitly');
    return ok({track_list:[{name:'A'}]});
  },ok({track_list:[{name:'B'}]})]);
  const reader=new SessionReader(client);
  assert.equal((await reader.selectedTracks()).track_list[0].name,'A');
  assert.equal((await reader.selectedTracks()).track_list[0].name,'B');
  assert.deepEqual(client.calls,['GetTrackList','GetTrackList']);
});
test('metadata pages keep all 1200 clips and accept legacy response keys', async () => {
  const offsets=[];
  const page=(count,alias=false)=>(_command,body)=>{
    offsets.push(body.pagination_request.offset);
    return ok({[alias?'clip_list':'clips']:Array.from({length:count},(_,i)=>i+body.pagination_request.offset)});
  };
  const client=mock([page(500),page(500,true),page(200),ok({fileLocations:[{path:'/tmp/a.wav'}]})]);
  const output=await new SessionReader(client).exportMetadata();
  assert.equal(output.clips.length,1200);
  assert.equal(new Set(output.clips).size,1200);
  assert.deepEqual(offsets,[0,500,1000]);
  assert.equal(output.file_locations.length,1);
});
test('failed metadata page stops instead of exporting partial data', async () => {
  const client=mock([ok({clips:Array(500).fill({})}),fail('Host busy')]);
  await assert.rejects(new SessionReader(client).exportMetadata(),/Host busy/);
  assert.deepEqual(client.calls,['GetClipList','GetClipList']);
});
test('exports sequentially on one client and checks Session before publishing', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'autoedit-read-test-'));
  const paths=Object.fromEntries(['info','metadata','parsed'].map(k=>[k,path.join(dir,k)]));
  const parsed={metadata:{sessionName:'Test',audioTrackCount:1},tracks:[{events:[]}],onlineFiles:[],onlineClips:[],markers:[],warnings:[]};
  try {
    for (const changed of [false,true]) {
      const client=mock([...snapshotResponses(),ok({}),ok({clips:[]}),ok({file_locations:[]}),ok({session_name:changed?'Other':'Test'})]);
      fs.writeFileSync(paths.metadata,'original');
      if(changed) {
        await assert.rejects(exportSession(new SessionReader(client),paths,()=>parsed),/Session changed/);
        assert.equal(fs.readFileSync(paths.metadata,'utf8'),'original');
      } else {
        const result=await exportSession(new SessionReader(client),paths,()=>parsed);
        assert.equal(result.summary.tracks,1);
        assert.deepEqual(JSON.parse(fs.readFileSync(paths.metadata)).clips,[]);
      }
      assert.deepEqual(client.calls,['GetSessionName','GetTrackList','ExportSessionInfoAsText','GetClipList','GetFileLocation','GetSessionName']);
    }
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
