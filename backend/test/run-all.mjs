/*
 * Runs every test in this directory.
 *
 * `npm test` used to be a hand-written `&&` chain naming each file. Two tests
 * added in the same week — framework-audit and navigate-shape — were never
 * added to it, so CodeBuild ran neither. Both exist because a detector had gone
 * stale and shipped a defect to a user; neither would have said a word if it
 * went stale again.
 *
 * A list that has to be updated by hand is a list that silently stops being
 * complete, and the failure is invisible in exactly the way that matters: the
 * pipeline goes green. So the runner discovers instead.
 *
 * Probes (*.probe.mjs) are deliberately excluded — they invoke the deployed
 * Runtime, cost tokens, and take minutes.
 *
 *   node test/run-all.mjs            (from backend/)
 *   node test/run-all.mjs --list     names the files it would run
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort();

if (process.argv.includes('--list')) {
  for (const f of files) console.log(f);
  process.exit(0);
}

if (files.length === 0) {
  console.error('No test files found — the runner is looking in the wrong place.');
  process.exit(1);
}

const failed = [];
let totalPass = 0;
let totalFail = 0;

for (const file of files) {
  const r = spawnSync(process.execPath, [path.join(here, file)], {
    encoding: 'utf8',
    cwd: path.resolve(here, '..'),
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const tally = /(\d+) passed, (\d+) failed/.exec(out);

  if (tally) {
    totalPass += Number(tally[1]);
    totalFail += Number(tally[2]);
  }

  if (r.status === 0 && tally && tally[2] === '0') {
    console.log(`PASS  ${file.replace('.test.mjs', '').padEnd(22)} ${tally[1]} assertions`);
    continue;
  }

  // Only failing suites print their output. A green run that dumps twenty
  // suites' worth of PASS lines is a log nobody reads, which is how the two
  // missing suites went unnoticed in the first place.
  failed.push(file);
  console.log(`FAIL  ${file}`);
  console.log(out.split('\n').filter((l) => !l.startsWith('PASS')).join('\n'));
}

console.log(
  `\n${files.length - failed.length}/${files.length} suites, ${totalPass} assertions passed` +
    (totalFail ? `, ${totalFail} failed` : '')
);
if (failed.length > 0) {
  console.log(`Failing: ${failed.join(', ')}`);
  process.exit(1);
}
