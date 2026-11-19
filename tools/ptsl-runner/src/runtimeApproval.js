import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

// Files reside in a fresh per-run directory owned by the app. Every reply is bound to
// both the run and the issue token; stale replies never authorize a later command.
export function runtimeApproval(directory, runID) {
  if(!directory || !runID) return async()=>false;
  fs.mkdirSync(directory,{recursive:true});
  return async issue=>{
    const token=crypto.randomUUID();
    const request=path.join(directory,'request.json'),response=path.join(directory,'response.json');
    fs.rmSync(response,{force:true});
    const temp=request+'.tmp';
    fs.writeFileSync(temp,JSON.stringify({runID,token,issue}));fs.renameSync(temp,request);
    try {
      while(true) {
        if(fs.existsSync(response)) {
          let value;
          try{value=JSON.parse(fs.readFileSync(response,'utf8'));}catch{}
          if(value?.runID===runID&&value?.token===token) return value.approved===true;
        }
        await new Promise(resolve=>setTimeout(resolve,200));
      }
    } finally {fs.rmSync(request,{force:true});fs.rmSync(response,{force:true});}
  };
}
