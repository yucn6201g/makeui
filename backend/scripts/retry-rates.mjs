// Is a second attempt at the same defect worth a call? A third?
//
// The yield gate in repair-yield.ts asks whether a defect id is ever worth
// repairing. This asks a different question: whether it is worth repairing
// AGAIN, in the same run, after a pass has already been given it and left it
// standing.
//
// It exists because two generations on 2026-09-04 handed `emoji`,
// `action-dead-runtime` and `palette-size` to every pass they ran, fixed none of
// them, and spent the repair budget doing it — one run finished with fourteen
// files unrepaired because there was nothing left to spend.
//
// Costs nothing; reads CloudWatch. Re-derive before trusting the table in
// repair-yield.ts, the same way scripts/fix-rates.mjs is used for the other one.
//
//   node scripts/retry-rates.mjs [days]      (from backend/, default 45)
import { runtimeLogGroup } from './lib/aws-env.mjs';
import { execFileSync } from 'node:child_process';

const GROUP = runtimeLogGroup();
const REGION = 'ap-northeast-1';
const days = Number(process.argv[2] ?? 45);

function fetchAll(pattern) {
  const out = [];
  let token;
  do {
    const args = [
      'logs', 'filter-log-events', '--region', REGION, '--log-group-name', GROUP,
      '--filter-pattern', `"${pattern}"`, '--start-time', String(Date.now() - days * 86400_000),
      '--query', '{events: events[].message, next: nextToken}', '--output', 'json',
    ];
    if (token) args.push('--next-token', token);
    const res = JSON.parse(execFileSync('aws', args, { encoding: 'utf8', maxBuffer: 1 << 28 }));
    for (const m of res.events ?? []) {
      try { out.push(JSON.parse(m)); } catch { /* not one of ours */ }
    }
    token = res.next;
  } while (token);
  return out;
}

/**
 * Ids the loop refuses to spend a call on — `NOT_WORTH_REPAIRING` in
 * repair-yield.ts, kept in step by hand because this script must run without
 * building the TypeScript.
 *
 * They have to come out, and leaving them in is what this script did. What is
 * logged is the defect set a pass was HANDED; `worthRepairing` then splits that
 * into what it attempts and what it skips. A refused id stays in the handed set,
 * is never attempted, and is therefore never cleared — so it scored a retry rate
 * near zero for the reason that nobody retried it. `visual-spacing` reported
 * 3/54 that way, and 54 second attempts at it were never made.
 *
 * That mattered beyond the three rows: the table's argument for RETRY_FLOOR is
 * a wide empty gap between 18% and 50%, and three of the eight ids under the
 * floor were ids with no attempts behind them. The gap survives without them —
 * emoji at 21% is still the highest of what remains — but it has to be made of
 * measurements of the thing it claims to measure.
 */
const NOT_ATTEMPTED = new Set(['visual-spacing', 'visual-alignment', 'visual-hierarchy']);

/** (requestId, pass) -> the defect ids that pass was handed AND could attempt. */
const given = new Map();
for (const r of fetchAll('Quality defects detected')) {
  if (r.requestId && r.pass != null) {
    given.set(`${r.requestId}#${r.pass}`,
      (r.defects ?? []).map(String).filter((id) => !NOT_ATTEMPTED.has(id)));
  }
}
/** (requestId, pass) -> what was still there after an ACCEPTED pass. */
const after = new Map();
for (const r of fetchAll('Interaction repair accepted')) {
  if (r.requestId && r.pass != null && r.remaining) after.set(`${r.requestId}#${r.pass}`, r.remaining.map(String));
}

// How many times this run had already handed this defect to a pass, and whether
// this attempt cleared it. A rejected pass is skipped: its document was thrown
// away, so nothing in it was fixed or not fixed.
const byAttempt = new Map();
const byId = new Map();
for (const [key, before] of given) {
  const [rid, passStr] = key.split('#');
  const pass = Number(passStr);
  const remaining = after.get(key);
  if (!remaining) continue;
  const seen = new Set(remaining);
  for (const id of before) {
    let earlier = 0;
    for (let p = 1; p < pass; p += 1) if ((given.get(`${rid}#${p}`) ?? []).includes(id)) earlier += 1;
    const nth = earlier + 1;
    const a = byAttempt.get(nth) ?? { n: 0, fixed: 0 };
    a.n += 1; if (!seen.has(id)) a.fixed += 1;
    byAttempt.set(nth, a);
    if (nth >= 2) {
      const e = byId.get(id) ?? { n: 0, fixed: 0 };
      e.n += 1; if (!seen.has(id)) e.fixed += 1;
      byId.set(id, e);
    }
  }
}

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '-');
console.log('attempt at the same defect, in the same run\n');
console.log('  nth' + 'handed'.padStart(9) + 'fixed'.padStart(8) + 'rate'.padStart(8));
for (const [nth, a] of [...byAttempt].sort((x, y) => x[0] - y[0])) {
  console.log(String(nth).padStart(5) + String(a.n).padStart(9) + String(a.fixed).padStart(8) + pct(a.fixed, a.n).padStart(8));
}

console.log('\nsecond and later attempts, by defect:');
console.log('  defect'.padEnd(28) + 'n'.padStart(5) + 'fixed'.padStart(7) + 'rate'.padStart(7));
for (const [id, e] of [...byId].sort((a, b) => a[1].fixed / a[1].n - b[1].fixed / b[1].n || b[1].n - a[1].n)) {
  console.log('  ' + id.padEnd(26) + String(e.n).padStart(5) + String(e.fixed).padStart(7) + pct(e.fixed, e.n).padStart(7) +
    (e.n < 10 ? '  (thin)' : ''));
}
