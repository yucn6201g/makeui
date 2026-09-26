// How much of a file a repair or an edit actually changes, and what the reply cost.
//
// Output is most of a generation's cost, and both paths used to return the
// COMPLETE file. This script answered whether a search-and-replace format was
// worth building; it was built, and the question has moved on to whether it is
// being asked for in the right places. Both paths now log the form they asked
// for and the characters the reply actually came to, so the saving below is
// MEASURED wherever those fields are present and modelled only for the older
// records that predate them.
//
// What the rule under test is (repair-files.ts, patch-reply.ts): blocks for a
// file of at least MIN_PATCH_CHARS whose every defect changes a measured tenth
// of a file or less, and for any stylesheet above that floor; a whole file for
// everything else. The two tables it rests on are the change share by defect,
// printed at the bottom, and the reply cost by change band, printed per path.
//
//   node scripts/repair-change-size.mjs [days]      (from backend/, default 7)
//
// Reported per path and by defect id, because the answer is unlikely to be one
// number: adding an import changes three lines, extracting a component rewrites
// most of a file, and a patch format that suits one is wrong for the other.
//
// Shells out to the AWS CLI with an argument array and no shell, so the log
// group's leading slash survives Git Bash.
import { runtimeLogGroup } from './lib/aws-env.mjs';
import { execFileSync } from 'node:child_process';

const GROUP = runtimeLogGroup();
const days = Number(process.argv[2] ?? 7);

function fetchAll(pattern) {
  const out = [];
  let token;
  do {
    const args = [
      'logs', 'filter-log-events', '--region', 'ap-northeast-1', '--log-group-name', GROUP,
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

const pct = (xs, p) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const fmt = (x) => (Number.isNaN(x) ? '  —' : `${Math.round(x * 100)}%`.padStart(4));

/*
 * What a replace block would emit for one file, as a share of the whole file.
 *
 * Not `changedShare`: a block carries the lines it replaces as well as the new
 * ones, and enough unchanged context to be found — so twice the change, plus
 * three lines either side. Without this the first run's eight files read as "a
 * patch would emit 5%", which is the share of lines that differ, not the size
 * of anything a model would write.
 */
const CONTEXT_LINES = 6;
function patchShare(r) {
  const lines = Math.max(r.afterLines ?? 1, 1);
  return r.changedShare === 0 ? 0 : Math.min(1, 2 * r.changedShare + CONTEXT_LINES / lines);
}

/*
 * The decision this script exists for, written down before the data arrives so
 * the data cannot choose the threshold.
 *
 * A replace-block format is not free: a block whose search text does not match
 * the file is a failed repair, and the fallback is today's whole-file rewrite on
 * top of the patch that failed. So it has to remove most of the output to be
 * worth the new failure mode, not merely some of it.
 *
 *   - under 30 files: no verdict. One run on 2026-09-13 gave eight files
 *     changing 0–19%; eight files from one project is not a distribution.
 *   - a patch would still emit 40% or less of today's output: build it.
 *   - 70% or more: do not; the saving is smaller than one failed patch costs.
 *   - between: build it only for the defect ids whose median is under 20%.
 */
const MIN_FILES = 30;
const BUILD_AT = 0.4;
const SKIP_AT = 0.7;

function verdict(rows) {
  if (rows.length < MIN_FILES) return `no verdict yet: ${rows.length} of the ${MIN_FILES} files needed`;
  const outChars = rows.reduce((a, r) => a + (r.outChars ?? 0), 0);
  const kept = rows.reduce((a, r) => a + (r.outChars ?? 0) * patchShare(r), 0) / Math.max(outChars, 1);
  if (kept <= BUILD_AT) return `BUILD the patch format: it would still emit ${Math.round(kept * 100)}% (<= ${BUILD_AT * 100}%)`;
  if (kept >= SKIP_AT) return `DO NOT build it: it would still emit ${Math.round(kept * 100)}% (>= ${SKIP_AT * 100}%)`;
  return `PER DEFECT only: ${Math.round(kept * 100)}% overall — use it for the ids below whose median is under 20%`;
}

/*
 * The bands the rule is drawn on, and the floor it is drawn at.
 *
 * Measured 2026-09-18 over 60 days on the 98 files production had patched: at a
 * twentieth of a file the reply is 14% of it, at a fifth it is 173% — a patch
 * carries the lines it replaces as well as the lines replacing them, so past
 * roughly half the change it is longer than the file it changes.
 */
const BANDS = [
  ['changed <= 5%', (s) => s <= 0.05],
  ['changed 5-15%', (s) => s > 0.05 && s <= 0.15],
  ['changed 15-30%', (s) => s > 0.15 && s <= 0.3],
  ['changed > 30%', (s) => s > 0.3],
];
const MIN_PATCH_CHARS = 2000;

/** Reply characters against the file they rewrote — the measurement, not the model. */
function cost(rows) {
  const have = rows.filter((r) => Number.isFinite(r.replyChars) && r.outChars > 0);
  if (have.length === 0) return null;
  return {
    n: have.length,
    share: have.reduce((a, r) => a + r.replyChars, 0) / have.reduce((a, r) => a + r.outChars, 0),
  };
}

function report(label, rows) {
  if (rows.length === 0) {
    console.log(`${label}: no records yet`);
    return;
  }
  const shares = rows.map((r) => r.changedShare);
  const outChars = rows.reduce((a, r) => a + (r.outChars ?? 0), 0);
  // What a replace-block format would still have to emit, as a share of today's.
  const kept = rows.reduce((a, r) => a + (r.outChars ?? 0) * patchShare(r), 0);
  console.log(`${label}: ${rows.length} files`);
  console.log(`  changed share  p25 ${fmt(pct(shares, 0.25))}  median ${fmt(pct(shares, 0.5))}  p75 ${fmt(pct(shares, 0.75))}  p90 ${fmt(pct(shares, 0.9))}`);
  console.log(`  output a patch format would still emit: ~${Math.round((kept / Math.max(outChars, 1)) * 100)}% of today's`);
  console.log(`  (estimated counts: ${rows.filter((r) => r.estimated).length}, which over-state the change)`);
  console.log(`  verdict: ${verdict(rows)}`);

  /*
   * What the replies actually cost, which is the only number that can say
   * whether the rule is asking for the right form. A share above 100% is a
   * patch that cost more than sending the file would have.
   */
  const byFormat = new Map();
  for (const r of rows) {
    const f = r.format ?? 'unrecorded';
    byFormat.set(f, [...(byFormat.get(f) ?? []), r]);
  }
  const overall = cost(rows);
  if (overall) {
    console.log(`  measured reply cost: ${Math.round(overall.share * 100)}% of the files rewritten (${overall.n} replies)`);
    for (const [f, rs] of [...byFormat].sort()) {
      const c = cost(rs);
      if (c) console.log(`    ${f.padEnd(11)} n=${String(c.n).padStart(3)}  ${Math.round(c.share * 100)}%`);
    }
    for (const [name, inBand] of BANDS) {
      const c = cost(rows.filter((r) => r.format === 'patch' && inBand(r.changedShare ?? 0)));
      if (c) console.log(`    patch, ${name.padEnd(15)} n=${String(c.n).padStart(3)}  ${Math.round(c.share * 100)}%`);
    }
    const under = rows.filter((r) => r.format === 'patch' && (r.outChars ?? 0) < MIN_PATCH_CHARS);
    if (under.length > 0) {
      const c = cost(under);
      console.log(`    patched under the ${MIN_PATCH_CHARS}-character floor: ${under.length} files at ${Math.round(c.share * 100)}% — these should not be patched`);
    }
  }
}

const repairs = fetchAll('File repair change size');
const edits = fetchAll('File edit change size');
console.log(`${days} days\n`);
report('repair:per-file', repairs);
console.log();
report('edit:per-file', edits);

// By defect, for repairs: a format decision may be per defect rather than global.
const byDefect = new Map();
for (const r of repairs) for (const id of r.defects ?? []) {
  const l = byDefect.get(id) ?? [];
  l.push(r.changedShare);
  byDefect.set(id, l);
}
const rows = [...byDefect].filter(([, l]) => l.length >= 5).sort((a, b) => pct(a[1], 0.5) - pct(b[1], 0.5));
if (rows.length > 0) {
  /*
   * This is the table CHANGE_SHARE in repair-files.ts is built from. A row at or
   * under the ceiling is asked for as blocks; everything else is asked for whole.
   * Re-running this is how that table is re-derived — the medians move as the
   * pipeline changes, and `visual-typography` has already been 85% and 3%.
   */
  const CEILING = 0.1;
  console.log('\nrepair change share by defect (files carrying it, n>=5):');
  for (const [id, l] of rows) {
    const m = pct(l, 0.5);
    console.log(`  ${id.padEnd(26)} n=${String(l.length).padStart(3)}  median ${fmt(m)}  ${m <= CEILING ? 'patch' : 'whole'}`);
  }
  console.log(`\n  Paste the rows marked "patch" into CHANGE_SHARE in src/orchestration/repair/repair-files.ts:`);
  for (const [id, l] of rows.filter(([, l]) => pct(l, 0.5) <= CEILING))
    console.log(`    '${id}': { median: ${pct(l, 0.5).toFixed(2)}, of: ${l.length} },`);
}
