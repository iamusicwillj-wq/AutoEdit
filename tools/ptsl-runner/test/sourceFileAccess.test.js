import assert from 'node:assert/strict';
import test from 'node:test';
import {inspectSourceFile} from '../src/sourceFileAccess.js';
for(const [error,code] of [['ENOENT','path-not-found'],['ENOTDIR','path-not-found'],['EPERM','source-access-denied'],['EACCES','source-access-denied'],['EIO','source-read-failed']]) {
  test(`source inspection preserves ${error}`,()=>{
    const result=inspectSourceFile('/test/audio.wav',{statSync:()=>({isFile:()=>true}),accessSync:()=>{throw Object.assign(new Error('error'),{code:error});}});
    assert.deepEqual(result,{ok:false,code,fileErrorCode:error});
  });
}
test('directories cannot be treated as audio and readable files are accepted',()=>{
  assert.equal(inspectSourceFile('/folder',{statSync:()=>({isFile:()=>false})}).code,'source-not-file');
  assert.deepEqual(inspectSourceFile('/audio',{statSync:()=>({isFile:()=>true}),accessSync:()=>{}}),{ok:true});
});
