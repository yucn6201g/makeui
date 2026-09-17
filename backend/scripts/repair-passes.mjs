// What does each repair pass actually buy?
//
// Asked because the plan was to cut the pass count, and a cap is a thing you
// choose from a distribution rather than from a hunch. Costs nothing; reads
// CloudWatch.
//
//   node scripts/repair-passes.mjs      (from backend/)
//
// MEASURED over 45 days, 2026-09-03:
//
//   pass  reached  accepted  rejected  accept%   defects before->after
//      1      244       125       121     51%    8.7 -> 6.8
//      2      119        47        72     39%    7.0 -> 5.8
//      3       45        19        26     42%    5.7 -> 4.7
//
// Expected defects removed per attempt: 0.97, 0.47, 0.42. There is no cliff.
// Capping at two would save about 45 attempts and lose about 19 defects fixed,
// at roughly 1.9x the cost per defect of pass one — a trade, not an improvement,
// so the cap was NOT taken.
//
// The waste is not the third pass, it is the rejections: 219 of 415 attempts,
// 53%. And they are not judging errors. Of 148 rejected for 「no improvement」
// with convergent counts recorded, 59 left the document WORSE, 89 left it
// unchanged, and 0 had actually improved — so the loop is paying for passes that
// do not help, which is a different problem from paying for too many of them.
import { runtimeLogGroup } from './lib/aws-env.mjs';
import { execFileSync } from 'node:child_process';
const G = runtimeLogGroup();
const q = (p, days = 45) => {
  const o = execFileSync('aws', ['logs', 'filter-log-events', '--region', 'ap-northeast-1', '--log-group-name', G,
    '--filter-pattern', `"${p}"`, '--start-time', String(Date.now() - days * 86400000),
    '--query', 'events[].[timestamp,message]', '--output', 'json'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  return (JSON.parse(o) || []).map(([t, m]) => { try { return { t, ...JSON.parse(m) }; } catch { return null; } }).filter(Boolean);
};
const detected = q('Quality defects detected');
const accepted = q('Interaction repair accepted');
const rejected = q('Interaction repair rejected');

const byPass = {};
for (const r of detected) (byPass[r.pass] ??= { detected: 0, accepted: 0, rejected: 0, before: 0, after: 0, reasons: {} }).detected++;
for (const r of accepted) {
  const b = (byPass[r.pass] ??= { detected: 0, accepted: 0, rejected: 0, before: 0, after: 0, reasons: {} });
  b.accepted++; b.before += r.before ?? 0; b.after += r.after ?? 0;
}
for (const r of rejected) {
  const b = (byPass[r.pass] ??= { detected: 0, accepted: 0, rejected: 0, before: 0, after: 0, reasons: {} });
  b.rejected++; b.reasons[r.reason ?? '?'] = (b.reasons[r.reason ?? '?'] ?? 0) + 1;
}
console.log('pass  reached  accepted  rejected  accept%  defects before->after (accepted only)');
for (const p of Object.keys(byPass).sort((a, b) => a - b)) {
  const b = byPass[p];
  const tries = b.accepted + b.rejected;
  console.log(String(p).padStart(4) + String(b.detected).padStart(9) + String(b.accepted).padStart(10) +
    String(b.rejected).padStart(10) + (tries ? `${Math.round(b.accepted / tries * 100)}%` : '-').padStart(9) +
    (b.accepted ? `   ${(b.before / b.accepted).toFixed(1)} -> ${(b.after / b.accepted).toFixed(1)}` : ''));
}
console.log('\nrejection reasons by pass:');
for (const p of Object.keys(byPass).sort((a, b) => a - b)) {
  const r = byPass[p].reasons;
  if (Object.keys(r).length) console.log(`  pass ${p}: ` + Object.entries(r).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
}
