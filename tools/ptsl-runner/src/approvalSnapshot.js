import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionReader } from './sessionReadWorkflow.js';
import { parseSessionInfoFile } from './sessionInfoParser.js';
import { planDigest } from './executionPolicy.js';

// Read only, used only around a runtime approval pause. Ignore changing export timestamps.
export async function approvalSnapshot(read) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'autoedit-approval-'));
  try {
    const file=path.join(directory,'session.txt');
    const reader=new SessionReader({});
    reader.read=read;
    await reader.exportInfo(file);
    const parsed=parseSessionInfoFile(file);
    if(!parsed.metadata.sessionName || (parsed.metadata.audioTrackCount>0 && !parsed.tracks.length))
      throw new Error('Cannot verify Edit Session content before resuming.');
    return planDigest(JSON.stringify({tracks:parsed.tracks,clips:parsed.onlineClips,files:parsed.onlineFiles}));
  } finally { fs.rmSync(directory,{recursive:true,force:true}); }
}
