import { buildReviewPlan } from '../mcp/src/review-plan.js';

function assert(value, message) { if (!value) throw new Error(message); }

const report = {
  deltas: [
    { name: 'A', field: 'fontSize', kind: 'typography', severity: 'med', a: 12, b: 14,
      testid: 'a', sourceFile: 'src/Shared.tsx', sourceLine: 20 },
    { name: 'B', field: 'fontSize', kind: 'typography', severity: 'med', a: 12, b: 14,
      testid: 'b', sourceFile: 'src/Shared.tsx', sourceLine: 28 },
    { name: 'Focus', field: 'state', kind: 'state', severity: 'high', a: 'on', b: 'off',
      testid: 'focus', sourceCandidates: [{ file: 'src/Old.tsx' }, { file: 'src/New.tsx' }] },
  ],
  coverage: {
    wholeScreenCertified: false, unpairedNodes: { mockup: 9, app: 11 },
    unmeasured: [{ name: 'C', field: 'width' }], stateMismatched: [{ name: 'Focus' }],
    provisionalPairs: [{ mockupId: '1:9', appTestid: 'c', deltas: [
      { name: 'C', field: 'width', kind: 'spacing', severity: 'low', a: 100, b: 110,
        sourceFile: 'src/Shared.tsx', sourceLine: 35 },
    ] }],
  },
};

const plan = buildReviewPlan(report);
assert(plan.measured.length === 1 && plan.measured[0].occurrences.length === 2,
  'same source and value drift should form one measured issue');
assert(plan.measured[0].sourceFile === 'src/Shared.tsx' && plan.measured[0].field === 'fontSize',
  'group must retain exact source and field');
assert(plan.provisional.length === 1 && plan.provisional[0].field === 'width',
  'suggested mapping deltas must remain outside measured issues');
assert(plan.unresolved.length === 1 && plan.unresolved[0].sourceCandidates.length === 2,
  'ambiguous source owners must remain explicit');
assert(plan.blocked.unpairedNodes.mockup === 9 && plan.blocked.unmeasuredFields === 1 &&
  plan.blocked.stateMismatches === 1 && !plan.wholeScreenCertified,
  'coverage blockers must remain visible');
console.log('PASS  review plan grouping (5 assertions).');
