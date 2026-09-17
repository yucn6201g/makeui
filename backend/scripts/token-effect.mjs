// Did the token work reduce what a run spends, and can that be told apart from
// noise?
//
// Reads the per-stage ledger out of CloudWatch and splits it at the first run
// that shows a cache read — the first of the five changes to deploy. Costs
// nothing; no model calls.
//
//   node scripts/token-effect.mjs      (from backend/)
//
// MEASURED 2026-09-03, before n=17 (2026-08-27..28) and after n=13:
//
//   spend median 270,340 -> 257,354      5% lower
//   repair calls median 30 -> 27        10% lower
//
// and per stage, where it actually moved:
//
//   design:interaction-designer  20k -> 10k    prompt caching
//   design:content-strategist    18k ->  8k
//   design:style-expert          20k -> 11k
//   repair:preset-conformance    24k ->  6k    the stylesheet-scoped repair
//   repair:per-file             109k -> 71k    the yield gate and the budget
//
// The per-stage effects are real and each is larger than the group difference
// they add up to. That is the finding: 5% at the median is INSIDE the noise. The
// same brief run three times on identical input spent 187k, 204k and 336k
// (test/score-variance.probe.mjs), so a 5% difference between two groups of
// seventeen and thirteen runs of DIFFERENT briefs cannot be called a reduction.
//
// Where the savings went is visible in the same table: `build:per-file`
// disappears and `repair:whole-document` appears, so some runs took the more
// expensive route through the pipeline. Whether that is the changes' doing or
// the brief mix, this data cannot say.
import { runtimeLogGroup } from './lib/aws-env.mjs';
import { execFileSync } from 'node:child_process';
const G = runtimeLogGroup();
const o = execFileSync('aws', ['logs', 'filter-log-events', '--region', 'ap-northeast-1', '--log-group-name', G,
  '--filter-pattern', '"Token ledger"', '--start-time', String(Date.now() - 45 * 86400000),
  '--query', 'events[].[timestamp,message]', '--output', 'json'], { encoding: 'utf8', maxBuffer: 1 << 28 });
const all = (JSON.parse(o) || []).map(([t, m]) => { try { return { t, ...JSON.parse(m) }; } catch { return null; } })
  .filter(Boolean).sort((a, b) => a.t - b.t);

// A generation, not a plan or an edit: those spend a fifth as much and would
// drag whichever group holds more of them.
const gen = all.filter((r) => (r.stages || []).some((s) => s.stage.startsWith('build:')));
const spend = (r) => r.processed ?? r.total;          // caching hides tokens in `total`
const repairCalls = (r) => (r.stages || []).filter((s) => s.stage.startsWith('repair:')).reduce((a, s) => a + s.calls, 0);
const repairTok = (r) => (r.stages || []).filter((s) => s.stage.startsWith('repair:')).reduce((a, s) => a + s.in + s.out, 0);

// The cut is the first run that shows a cache read, not a date: prompt caching
// was the first of the five to deploy, and a run of 2026-09-02 already had it.
// A calendar boundary would have put that one on the wrong side.
const CUT = gen.find((r) => (r.cacheRead ?? 0) > 0)?.t ?? Infinity;
const before = gen.filter((r) => r.t < CUT);
const after = gen.filter((r) => r.t >= CUT);

const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const show = (name, g) => {
  const t = g.map(spend), c = g.map(repairCalls), rt = g.map(repairTok);
  console.log(`${name.padEnd(8)} n=${String(g.length).padStart(2)}  spend median ${String(Math.round(med(t))).padStart(7)}` +
    `  range ${Math.min(...t)}-${Math.max(...t)}` +
    `  repair calls median ${String(med(c)).padStart(3)}` +
    `  repair tokens median ${String(Math.round(med(rt))).padStart(7)}` +
    `  repair share ${(med(rt) / med(t) * 100).toFixed(0)}%`);
};
show('before', before);
show('after', after);
console.log(`\nspend: ${((1 - med(after.map(spend)) / med(before.map(spend))) * 100).toFixed(0)}% lower at the median`);
console.log(`repair calls: ${((1 - med(after.map(repairCalls)) / med(before.map(repairCalls))) * 100).toFixed(0)}% lower`);

// Per stage, to see WHERE it moved rather than only that it did.
const byStage = (g) => {
  const m = new Map();
  for (const r of g) for (const s of r.stages || []) {
    const e = m.get(s.stage) ?? { calls: 0, tok: 0, runs: 0 };
    e.calls += s.calls; e.tok += s.in + s.out; e.runs += 1;
    m.set(s.stage, e);
  }
  return m;
};
const b = byStage(before), a = byStage(after);
console.log('\nstage                     before/run        after/run');
for (const stage of new Set([...b.keys(), ...a.keys()])) {
  const x = b.get(stage), y = a.get(stage);
  const per = (e, n) => (e ? `${(e.tok / n / 1000).toFixed(0)}k in ${(e.calls / n).toFixed(1)} calls` : '—');
  console.log('  ' + stage.padEnd(24) + per(x, before.length).padEnd(18) + per(y, after.length));
}
