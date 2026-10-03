// Compact source-backed triage of an already measured structured diff.
// This groups repeated symptoms without changing the comparison verdict.
const rank = { high: 3, med: 2, low: 1 };

function grouped(deltas, provisional = false) {
  const byCause = new Map();
  for (const delta of deltas) {
    if (!delta.sourceFile) continue;
    const key = JSON.stringify([delta.sourceFile, delta.kind, delta.field, delta.a, delta.b]);
    let issue = byCause.get(key);
    if (!issue) {
      issue = { sourceFile: delta.sourceFile, kind: delta.kind, field: delta.field,
        expected: delta.a, actual: delta.b, severity: delta.severity,
        provisional, occurrences: [] };
      byCause.set(key, issue);
    }
    issue.occurrences.push({ name: delta.name, testid: delta.testid || null,
      sourceLine: delta.sourceLine || null,
      codeChange: delta.codeChange || null,
      mockupId: delta.mockupId || null });
  }
  return [...byCause.values()].sort((a, b) =>
    (rank[b.severity] || 0) - (rank[a.severity] || 0) ||
    b.occurrences.length - a.occurrences.length ||
    a.sourceFile.localeCompare(b.sourceFile));
}

export function buildReviewPlan(report) {
  const measured = report.deltas || [];
  const provisional = (report.coverage?.provisionalPairs || []).flatMap(pair =>
    pair.deltas.map(delta => ({ ...delta, mockupId: pair.mockupId })));
  return {
    wholeScreenCertified: report.coverage?.wholeScreenCertified === true,
    measured: grouped(measured),
    provisional: grouped(provisional, true),
    unresolved: measured.filter(d => !d.sourceFile).map(d => ({
      name: d.name, testid: d.testid || null, kind: d.kind, field: d.field,
      expected: d.a, actual: d.b, severity: d.severity,
      sourceCandidates: d.sourceCandidates || [],
    })),
    blocked: {
      unpairedNodes: report.coverage?.unpairedNodes || null,
      unmeasuredFields: report.coverage?.unmeasured?.length || 0,
      stateMismatches: report.coverage?.stateMismatched?.length || 0,
      unmatchedAnchors: report.coverage?.unmatched?.length || 0,
    },
  };
}
