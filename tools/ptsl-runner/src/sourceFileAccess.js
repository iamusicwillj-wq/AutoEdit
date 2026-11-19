import fs from 'node:fs';

// Preserve OS error codes; existsSync conflates absence and access denial.
export function inspectSourceFile(path, io = fs) {
  try {
    if (!path) return {ok:false, code:'path-not-found', fileErrorCode:'ENOENT'};
    if (!io.statSync(path).isFile()) return {ok:false, code:'source-not-file', fileErrorCode:'EISDIR'};
    io.accessSync(path, fs.constants.R_OK);
    return {ok:true};
  } catch (error) {
    const fileErrorCode = error.code ?? 'UNKNOWN';
    const code = ['ENOENT','ENOTDIR'].includes(fileErrorCode) ? 'path-not-found'
      : ['EACCES','EPERM'].includes(fileErrorCode) ? 'source-access-denied' : 'source-read-failed';
    return {ok:false, code, fileErrorCode};
  }
}
