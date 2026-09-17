// What does dropping a defect from a repair pass actually buy?
//
// The retry floor in repair-yield.ts was justified on repair QUALITY, not on
// tokens — an earlier estimate put the saving at 0.3% and it was set aside as a
// token measure. This prices it properly, because that estimate rested on a
// claim that turns out to be false: "dropping a defect from a pass does not stop
// the pass, so it does not remove a call."
//
// It does remove calls. The planner names roughly 1.6 files per defect it is
// handed — measured WITHIN a run, where the file inventory is held still, so it
// is not the confound that a big broken project has more of both. What the floor
// does not do is remove passes: over 45 days it would have emptied 2 of them.
//
// Measured 2026-09-04, 45 days, 247 runs: 220 instances dropped, ~348 per-file
// calls, ~2.8k tokens of a 292k run. About 1%, which is inside the score's own
// 11-point noise. Re-run it if the floor list changes; costs nothing.
//
//   node scripts/retry-cost.mjs      (from backend/)
import { runtimeLogGroup } from './lib/aws-env.mjs';
import { execFileSync } from 'node:child_process';

const GROUP = runtimeLogGroup();
const REGION = 'ap-northeast-1';
const days = Number(process.argv[2] ?? 45);

/** Keep this in step with NOT_WORTH_RETRYING in src/orchestration/repair-yield.ts. */
const NOT_WORTH_RETRYING = new Set([
  'action-dead-runtime',
  'nav-dead-runtime',
  'input-sizing',
  'imagery-missing',
]);

function fetchAll(pattern) {
  const out = [];
  let token;
  do {
    const args = [
      'logs', 'filter-log-events', '--region', REGION, '--log-group-name', GROUP,
      '--filter-pattern', `"${pattern}"`, '--start-time', String(Date.now() - days * 86400_000),
      '--query', '{events: events[].{m: message, t: timestamp}, next: nextToken}', '--output', 'json',
    ];
    if (token) args.push('--next-token', token);
    const res = JSON.parse(execFileSync('aws', args, { encoding: 'utf8', maxBuffer: 1 << 28 }));
    for (const e of res.events ?? []) {
      try { const j = JSON.parse(e.m); j._t = e.t; out.push(j); } catch { /* not one of ours */ }
    }
    token = res.next;
  } while (token);
  // `Per-file repair planned` carries no pass number, so passes are paired with
  // plans by order within a run. That only works in timestamp order.
  return out.sort((a, b) => a._t - b._t);
}

const push = (map, key, value) => (map.get(key) ?? map.set(key, []).get(key)).push(value);

const defectsOf = new Map();
for (const r of fetchAll('Quality defects detected')) {
  if (r.requestId && r.pass != null) push(defectsOf, r.requestId, (r.defects ?? []).map(String));
}
const plansOf = new Map();
for (const r of fetchAll('Per-file repair planned')) {
  if (r.requestId) push(plansOf, r.requestId, (r.files ?? []).length);
}
const callsOf = new Map();
for (const [rid, sizes] of plansOf) callsOf.set(rid, sizes.reduce((a, b) => a + b, 0));

// --- what the floor drops -------------------------------------------------------------
let instances = 0, dropped = 0, emptied = 0, allCalls = 0;
for (const [rid, passes] of defectsOf) {
  const attempted = new Set();
  allCalls += callsOf.get(rid) ?? 0;
  passes.forEach((defects, i) => {
    const keep = defects.filter((id) => !attempted.has(id) || !NOT_WORTH_RETRYING.has(id));
    instances += defects.length;
    dropped += defects.length - keep.length;
    if (i > 0 && keep.length === 0) emptied += 1;
    for (const id of defects) attempted.add(id);
  });
}

// --- and what a dropped defect is worth, within a run ----------------------------------
const deltas = [];
for (const [rid, passes] of defectsOf) {
  const sizes = plansOf.get(rid) ?? [];
  for (let i = 1; i < passes.length; i += 1) {
    if (sizes[i] == null || sizes[i - 1] == null) continue;
    deltas.push([passes[i].length - passes[i - 1].length, sizes[i] - sizes[i - 1]]);
  }
}
function slopeOf(pairs) {
  const n = pairs.length;
  const mx = pairs.reduce((a, [x]) => a + x, 0) / n;
  const my = pairs.reduce((a, [, y]) => a + y, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  return { slope: sxy / sxx, r: sxy / Math.sqrt(sxx * syy), mx, my, n };
}
const files = slopeOf(deltas);

// --- and what a call costs -------------------------------------------------------------
const runs = [];
for (const r of fetchAll('Token usage: generateUI')) {
  if (r.requestId && r.totalTokens) runs.push([callsOf.get(r.requestId) ?? 0, r.totalTokens]);
}
const cost = slopeOf(runs);

const savedCalls = dropped * files.slope;
const savedTokens = (savedCalls * cost.slope) / runs.length;
console.log(`${defectsOf.size} runs over ${days} days, ${instances} defect instances handed to a pass`);
console.log(`  the floor drops              : ${dropped} instances (${(dropped / instances * 100).toFixed(1)}%)`);
console.log(`  passes it empties entirely   : ${emptied}`);
console.log(`\nfiles planned per defect handed, measured within a run (${files.n} pass pairs)`);
console.log(`  ${files.slope.toFixed(2)} files per defect   (r = ${files.r.toFixed(2)})`);
console.log(`\ntokens per per-file repair call (${cost.n} runs, mean ${cost.mx.toFixed(1)} calls / ${Math.round(cost.my)} tokens)`);
console.log(`  ${Math.round(cost.slope)} tokens per call   (r = ${cost.r.toFixed(2)})`);
console.log(`\nso the floor is worth about ${Math.round(savedCalls)} calls of ${allCalls},`);
console.log(`  ${Math.round(savedTokens / 100) / 10}k tokens per run of ${Math.round(cost.my / 1000)}k  —  ${(savedTokens / cost.my * 100).toFixed(1)}%`);
console.log(`\nThe score's own run-to-run spread is 11 points. This is not a token measure.`);
