/**
 * Why a third of runs finished on exactly 30, and the three things done about it.
 *
 * Measured over 21 days, 231 generations: 64 finished on 30, which is the clamp
 * in `Rubric.total`. Sampling 25 of those documents and re-scoring them with the
 * browser facts left out, 22 scored 48-90 and three scored 86, 88 and 90 with no
 * open findings at all. So the floor is not thin documents — it is what the
 * runtime half does to good ones.
 *
 * And it is framework-shaped. Across 318 scored generations attributed to a
 * framework:
 *
 *   svelte  64 runs  median 30  58% at or under the floor
 *   vue     57 runs  median 56  18%
 *   react   76 runs  median 67  11%
 *
 * Svelte's median score IS the floor. Compiling the stored corpus with the
 * pipeline's own `compileFile`: 5 of 18 Svelte documents (28%) have a file that
 * will not build, against 1 of 61 React and 0 of 13 Vue — and every one of the
 * Svelte failures is a rune rule.
 *
 *   node test/score-floor.test.mjs      (from backend/)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeReactError, decodeReactErrors } from '../src/utils/react-error.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- 2. a minified React error is decoded ------------------------------------------------
{
  const raw = 'Error: Minified React error #130; visit https://reactjs.org/docs/error-decoder.html'
    + '?invariant=130&args[]=undefined for the full message';
  const out = decodeReactError(raw);

  check('the number is gone', /Minified React error/.test(out), false);
  check('the message is there', /Element type is invalid/.test(out), true);
  check('with the argument substituted', /but got: undefined/.test(out), true);
  check('the code is kept, so the log still points at React', /React #130/.test(out), true);
  check('and the pipeline says what it usually means', /never imported/.test(out), true);

  // The two other codes seen in 21 days.
  check('#301 decodes', /Too many re-renders/.test(decodeReactError('Minified React error #301; visit x?invariant=301')), true);
  check('#310 decodes', /Rendered more hooks/.test(decodeReactError('Minified React error #310; visit x?invariant=310')), true);

  /*
   * An unknown code passes through whole. A table that guessed would put a
   * confident wrong sentence in front of the repair pass, which is worse than
   * the number it replaced.
   */
  const unknown = 'Minified React error #999; visit https://x?invariant=999 for the full message';
  check('an unknown code is left alone', decodeReactError(unknown), unknown);

  // And so does everything that was never a React invariant.
  const other = "TypeError: Cannot read properties of undefined (reading 'map')";
  check('other errors are untouched', decodeReactError(other), other);
  check('the list form maps them all', decodeReactErrors([raw, other]).length, 2);
  check('and leaves the non-React one identical', decodeReactErrors([raw, other])[1], other);

  // Applied where the walk records them, so everything downstream reads the sentence.
  const verify = read('src/tools/browser/browser-verify.ts');
  /*
   * Every site that assigns a LIST, which is what `consoleErrors: [` picks out —
   * the interface's `string[]` declaration and the `facts.consoleErrors.length`
   * count are neither of them a place errors are recorded.
   */
  const lists = verify.split('\n').filter((l) => /consoleErrors: \[|consoleErrors: decodeReactErrors\(/.test(l));
  check('the walk records errors in more than one place', lists.length >= 2, true);
  check('and every one of them is decoded',
    lists.filter((l) => !l.includes('decodeReactErrors(')), []);
}

// --- 3. the clamp is recorded, not moved --------------------------------------------------
{
  const scoring = read('src/orchestration/audit/scoring.ts');
  check('the clamp is still 30..99', /Math\.max\(30, Math\.min\(99, this\.raw\(\)\)\)/.test(scoring), true);
  check('and the unclamped value has a name', /raw\(\): number/.test(scoring), true);
  /*
   * Not in ScoreParts. That object is stored on the thread and rendered as a
   * chip; two numbers for one score in it is how a display shows the wrong one.
   */
  check('it is left out of what the thread stores',
    /Omit<ScoreBreakdown, 'total' \| 'raw'>/.test(scoring), true);

  const graph = read('src/orchestration/generate/graph.ts');
  check('the pipeline logs it', /raw: scored\.raw/.test(graph), true);
  check('only when it differs from the score', /scored\.raw !== finalScore/.test(graph), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
