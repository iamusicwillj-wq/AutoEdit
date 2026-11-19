import crypto from 'node:crypto';

export function planDigest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function verifyPlanApproval(bytes, approvedDigest) {
  if (!approvedDigest) return false;
  if (approvedDigest !== planDigest(bytes)) throw new Error('Approved plan changed. Run Apply again to review the new plan.');
  return true;
}

// Closed lists: new/unknown warnings cannot silently acquire approval privileges.
export function executionPolicy(issues, { approvePositionWarnings = false } = {}) {
  const positionCodes = new Set(['position-gap', 'position-reference-partial']);
  const reviewCodes = new Set(['inactive-source-track', 'shortened-fade', 'recovered-fade-boundary']);
  const fatalIssues = issues.filter(i => i.severity === 'fatal'
    || (!['warning', 'review', 'info'].includes(i.severity))
    || (['warning', 'review'].includes(i.severity) && !reviewCodes.has(i.code)
      && !(i.severity === 'warning' && positionCodes.has(i.code))));
  const positionWarnings = issues.filter(i => i.severity === 'warning' && positionCodes.has(i.code));
  const reviewIssues = issues.filter(i => i.severity !== 'fatal' && reviewCodes.has(i.code));
  return {
    fatalIssues, positionWarnings, reviewIssues,
    blockers: [...fatalIssues, ...(approvePositionWarnings ? [] : positionWarnings)],
    needsPositionApproval: fatalIssues.length === 0 && positionWarnings.length > 0 && !approvePositionWarnings
  };
}
