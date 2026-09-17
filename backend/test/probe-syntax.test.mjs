// Whether the probes can still start.
//
// `run-all.mjs` deliberately excludes `*.probe.mjs` — they invoke the deployed
// Runtime, cost tokens and take minutes, so they are run by hand when a
// question needs them. That exclusion has a cost the runner's comment does not
// mention: nothing looks at these files between runs, and a probe that stopped
// parsing is indistinguishable from one that was simply not needed lately.
//
// Measured, that is not hypothetical. `design-system.probe.mjs` sat with a
// literal newline where a `\n` escape belonged — written through a shell
// heredoc that ate the backslash — and failed at parse time, before it reached
// a single assertion. It was reached for to answer a question about whether an
// imported design system is enforced, and it could not even load.
//
// Parsing is the whole assertion. It cannot tell whether a probe still probes
// the right thing, and it costs nothing, which is the point: the alternative is
// finding out at the moment the probe is needed.
//
//   node test/probe-syntax.test.mjs      (from backend/)
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const probes = readdirSync(here).filter((f) => f.endsWith('.probe.mjs')).sort();

let pass = 0, fail = 0;

// Probes are gitignored, so CI always has none and this always does nothing
// there. Said out loud rather than reported as a pass: a suite that checks
// nothing and prints a green line is the thing this file exists to catch.
//
// The tally line is required by `run-all.mjs`, which treats its absence as a
// failure — correctly, since a suite that exits 0 without one has usually died
// before reaching its assertions. Printing `0 passed` was the omission that made
// the first version of this file break the build: it passed locally, where
// probes exist, and the branch that only ever runs in CI was the untested one.
if (probes.length === 0) {
  console.log('no probe files present — they are gitignored, so CI has none');
  console.log('\n0 passed, 0 failed');
  process.exit(0);
}

for (const f of probes) {
  const r = spawnSync(process.execPath, ['--check', path.join(here, f)], { encoding: 'utf8' });
  const ok = r.status === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${f} parses`);
  if (!ok) console.log('      ' + (r.stderr || '').split('\n').slice(0, 4).join('\n      '));
  ok ? pass++ : fail++;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
