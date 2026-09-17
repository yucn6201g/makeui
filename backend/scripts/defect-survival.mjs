// Whether a defect is still there when the run ends.
//
// `fix-rates.mjs` asks a question about one pass: was this defect absent from
// the list the pass reported afterwards. This asks the question the user
// experiences: the run is over, is the defect still in the document.
//
// The two are not the same and they can disagree, because a pass is accepted or
// rejected as a whole. A defect the pass fixed goes back when the pass is thrown
// away, and a run with three passes has three chances to fix a defect and three
// chances to discard the fix. Either number alone is a partial answer; the
// exclusion list in repair-yield.ts is justified against both.
//
//   node scripts/defect-survival.mjs [days]      (from backend/, default 30)
//
// For every run with two or more repair passes it compares the defect list the
// FIRST pass was given with the list the LAST pass was given. A defect in both
// survived the whole repair loop. Runs with one pass are excluded: there is no
// "after" to compare against, and counting them would read "the loop ran once"
// as "the loop failed".
//
// Reads CloudWatch and costs nothing — no model calls, no generation. Shells out
// to the AWS CLI with an argument array and no shell, so the log group's leading
// slash survives: Git Bash rewrites `/aws/...` into a Windows path when a shell
// is involved.
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

/** requestId -> pass number -> the defect ids that pass was given. */
const byRun = new Map();
for (const r of fetchAll('Quality defects detected')) {
  if (!r.requestId || r.pass == null) continue;
  const m = byRun.get(r.requestId) ?? new Map();
  m.set(r.pass, (r.defects ?? []).map(String));
  byRun.set(r.requestId, m);
}

const multi = [...byRun.values()].filter((m) => m.size >= 2);
const first = new Map();
const survived = new Map();
let instances = 0;
let stillThere = 0;
for (const m of multi) {
  const passes = [...m.keys()].sort((a, b) => a - b);
  const start = new Set(m.get(passes[0]));
  const end = new Set(m.get(passes[passes.length - 1]));
  instances += start.size;
  for (const id of start) {
    first.set(id, (first.get(id) ?? 0) + 1);
    if (end.has(id)) {
      survived.set(id, (survived.get(id) ?? 0) + 1);
      stillThere += 1;
    }
  }
}

const rows = [...first]
  .map(([id, n]) => ({ id, n, s: survived.get(id) ?? 0, rate: (survived.get(id) ?? 0) / n }))
  .sort((a, b) => b.rate - a.rate || b.n - a.n);

console.log(`${byRun.size} runs over ${days} days, ${multi.length} of them with two or more passes`);
console.log(`${instances} defect instances at the first pass, ${stillThere} still there at the last = ${Math.round((100 * stillThere) / instances)}%\n`);
console.log('defect'.padEnd(26) + 'at pass 1'.padStart(10) + 'survived'.padStart(10) + 'rate'.padStart(7));
for (const r of rows) {
  // Under eight the rate is a coin toss with a small coin; shown, but marked.
  console.log(
    r.id.padEnd(26) + String(r.n).padStart(10) + String(r.s).padStart(10) +
    `${Math.round(r.rate * 100)}%`.padStart(7) + (r.n < 8 ? '  (thin)' : '')
  );
}

console.log('\nPaste into SURVIVAL in src/orchestration/repair-yield.ts:');
for (const r of rows) {
  if (r.n < 8) continue;
  const key = /^[a-z][\w]*$/.test(r.id) ? r.id : `'${r.id}'`;
  console.log(`  ${key}: { survived: ${r.s}, of: ${r.n} },`);
}
