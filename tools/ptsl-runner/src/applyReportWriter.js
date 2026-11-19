import fs from 'node:fs';

// Each response is serialized once into the journal; a complete, compatible
// report is materialized only on completion/failure. If the process is killed,
// the initial report and append-only journal retain every completed checkpoint.
export function createApplyReportWriter(reportPath, context = {}) {
  const journalPath = reportPath + '.journal.jsonl';
  const atomicWrite = value => {
    fs.writeFileSync(reportPath + '.tmp', JSON.stringify(value, null, 2));
    fs.renameSync(reportPath + '.tmp', reportPath);
  };
  fs.writeFileSync(journalPath, '');
  atomicWrite({...context, execute:true, inProgress:true, journal:journalPath});
  let initialized = false;
  const cursors = {results:0, skipIssues:0, decisions:0};
  const known = {createdTracks:new Set(), createdClipIdsByName:new Set()};
  let finished = false;
  function checkpoint(report) {
    if (finished) throw new Error('Cannot append to a completed apply report.');
    const entry = {kind:'checkpoint', at:new Date().toISOString(),
      completedClips:report.completedClips, partial:report.partial,
      pendingIssue:report.pendingIssue, failedCommands:report.failedCommands,
      error:report.error, cancelled:report.cancelled};
    if (!initialized) Object.assign(entry, {context, preflight:report.preflight,
      effectivePlan:report.effectivePlan, reviewIssues:report.reviewIssues, importStrategy:report.importStrategy});
    for (const key of Object.keys(cursors)) entry[key] = (report[key] ?? []).slice(cursors[key]);
    for (const key of Object.keys(known)) entry[key] = Object.fromEntries(
      Object.entries(report[key] ?? {}).filter(([id])=>!known[key].has(id)));
    fs.appendFileSync(journalPath, JSON.stringify(entry) + '\n');
    // Advance only after a successful write. A failed append must not lose
    // data from a subsequent error checkpoint or final report.
    for (const key of Object.keys(cursors)) cursors[key] = report[key]?.length ?? 0;
    for (const key of Object.keys(known)) for (const id of Object.keys(entry[key])) known[key].add(id);
    initialized = true;
    // A small atomic status file preserves cancellation UI compatibility.
    // Large response history and effectivePlan live only in the journal until
    // finish; hard termination never leaves a truncated status JSON.
    atomicWrite({...context, execute:true, inProgress:true, journal:journalPath,
      completedClips:report.completedClips, partial:report.partial, failedCommands:report.failedCommands,
      pendingIssue:report.pendingIssue, error:report.error, cancelled:report.cancelled,
      skipIssues:report.skipIssues, reviewIssues:report.reviewIssues});
  }
  function finish(report) {
    checkpoint(report);
    atomicWrite({...context, ...report, inProgress:false, journal:journalPath});
    finished = true;
  }
  return {checkpoint, finish, journalPath};
}
