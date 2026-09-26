// How often each defect is actually fixed by a repair pass.
//
// The table in src/orchestration/repair/repair-yield.ts decides which defects the loop
// spends calls on, and a table like that rots: the pipeline changes and the
// rates move with it. `preset-drift` reads 100% because the conformance repair
// was rewritten to work on the stylesheet; before that it was 0%.
//
// So the table is re-derivable. This reads CloudWatch and costs nothing — no
// model calls, no generation.
//
//   node scripts/fix-rates.mjs [days]      (from backend/, default 30)
//
// For every accepted pass it compares the defect list the pass was given with
// the `remaining` list it reported. A defect absent afterwards was fixed; one
// still there was not. Passes that were REJECTED are excluded on purpose: their
// document was discarded, so nothing in them was fixed or not fixed — counting
// them would read a thrown-away attempt as a failure to fix.
//
// Shells out to the AWS CLI, which the project already requires, rather than
// adding an SDK dependency for a script nothing ships. `execFileSync` with an
// argument array and no shell, so the log group's leading slash survives — Git
// Bash rewrites `/aws/...` into a Windows path when a shell is involved.
import { runtimeLogGroup } from './lib/aws-env.mjs';
import { execFileSync } from 'node:child_process';

const GROUP = runtimeLogGroup();
const REGION = 'ap-northeast-1';
const days = Number(process.argv[2] ?? 30);

function fetchAll(pattern) {
  const out = [];
  let token;
  do {
    const args = [
      'logs', 'filter-log-events',
      '--region', REGION,
      '--log-group-name', GROUP,
      '--filter-pattern', `"${pattern}"`,
      '--start-time', String(Date.now() - days * 86400_000),
      '--query', '{events: events[].message, next: nextToken}',
      '--output', 'json',
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

const passes = fetchAll('Quality defects detected');
const accepted = fetchAll('Interaction repair accepted');

/** (requestId, pass) -> the defect ids the pass was handed. */
const given = new Map();
for (const r of passes) {
  if (r.requestId && r.pass != null) given.set(`${r.requestId}#${r.pass}`, (r.defects ?? []).map(String));
}

const fixed = new Map();
const of = new Map();
let paired = 0;
for (const r of accepted) {
  const before = given.get(`${r.requestId}#${r.pass}`);
  if (!before || r.remaining == null) continue;
  paired += 1;
  const remaining = new Set((r.remaining ?? []).map(String));
  for (const id of before) {
    of.set(id, (of.get(id) ?? 0) + 1);
    if (!remaining.has(id)) fixed.set(id, (fixed.get(id) ?? 0) + 1);
  }
}

const rows = [...of]
  .map(([id, n]) => ({ id, n, fixed: fixed.get(id) ?? 0, rate: (fixed.get(id) ?? 0) / n }))
  .sort((a, b) => a.rate - b.rate || b.n - a.n);

const instances = [...of.values()].reduce((a, b) => a + b, 0);
console.log(`${paired} accepted passes over ${days} days, ${instances} defect instances\n`);
console.log('defect'.padEnd(26) + 'n'.padStart(6) + 'fixed'.padStart(7) + 'rate'.padStart(8));
for (const r of rows) {
  // Below ten the rate is a coin toss with a small coin; shown, but marked.
  console.log(r.id.padEnd(26) + String(r.n).padStart(6) + String(r.fixed).padStart(7) +
    `${Math.round(r.rate * 100)}%`.padStart(8) + (r.n < 10 ? '  (thin)' : ''));
}

console.log('\nPaste into FIX_RATE in src/orchestration/repair/repair-yield.ts:');
for (const r of rows) {
  if (r.n < 10) continue;
  const key = /^[a-z][\w]*$/.test(r.id) ? r.id : `'${r.id}'`;
  console.log(`  ${key}: { fixed: ${r.fixed}, of: ${r.n} },`);
}
