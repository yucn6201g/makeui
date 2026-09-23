// One left edge and one baseline for the row under a reply.
//
// The row holds a bordered pill (the model and the design system), a filled
// pill (the score) and three runs of plain text (tools, tokens, the time). Each
// carried its own box, so each put its TEXT somewhere different: the pills
// inset theirs by a padding and a border, the plain runs did not. The chat
// column is 300–380px, so the row wraps — and the wrapped line then started 7px
// to the left of the line above it.
//
// Reported as 「LLMモデルとデザインプリセットのテキストが、Scoreとトークン数の
// 表示位置とずれているようにみえる」.
//
// Measured in a browser at the real column width, with a Range over the text
// rather than a probe element (a probe inside a flex container becomes a flex
// item and measures the alignment rather than the text):
//
//   before   line 1 text at x=7, line 2 at x=0   — 7.00px apart
//   after    line 1 text at x=7, line 2 at x=7   — 0.00px apart
//
//   node test/meta-row-alignment.test.mjs      (from frontend/)
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(root, 'src/index.css'), 'utf8');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/** One rule's declarations, by selector. */
const ruleFor = (selector) => {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) return null;
  return css.slice(at, css.indexOf('}', at));
};

const row = ruleFor('.app__chat-meta');
check('the row exists', Boolean(row), true);
/*
 * Baseline, not centre. Centring aligns BOXES, and boxes of different heights
 * centred on one line put their text on different baselines.
 */
check('the row aligns on the baseline', /align-items:\s*baseline/.test(row), true);
check('and still wraps — the column is 300px', /flex-wrap:\s*wrap/.test(row), true);

/*
 * The box is defined once, for every child, so the text of each item starts on
 * the same x whether its item draws a pill or not — and so an item added to
 * this row later lines up by default instead of being the next thing that does
 * not.
 */
const child = ruleFor('.app__chat-meta > *');
check('every item shares one box', Boolean(child), true);
check('with the same padding', /padding:\s*1px 6px/.test(child), true);
// Transparent rather than absent: a border changes where the text sits, so the
// items that draw no border still need one to sit on the same grid.
check('and a transparent border the pills colour in', /border:\s*1px solid transparent/.test(child), true);
check('each item is itself baseline-aligned', /align-items:\s*baseline/.test(child), true);

/*
 * The two pills keep their ground and their border and nothing else: a second
 * copy of the box here is how the row drifted apart in the first place.
 */
const score = ruleFor('.app__chat-score');
check('the score is only a ground', /background:/.test(score), true);
check('and does not re-declare the box', /padding:|border:\s*1px solid \S/.test(score), false);

/*
 * And each item is declared ONCE.
 *
 * This is what the defect actually was. Four rules from when these were things
 * stacked under a reply survived above the row: a later rule of the same
 * specificity only overrides the properties it declares, and the row never
 * declared a size, so the old ones did —
 *
 *   .app__chat-score   font-size 0.75rem    margin-top 6px
 *   .app__chat-tools   font-size 0.6875rem  margin-top 4px
 *   .app__chat-tokens  font-size 0.6875rem  margin-top 4px, margin-left 8px
 *   (the row itself)   font-size 0.625rem
 *
 * Three text sizes and two stray top margins on one line. A shared box cannot
 * fix that, because the sizes are what is unequal — so the duplicates are gone,
 * and this keeps them gone.
 */
const declaredTwice = ['.app__chat-score', '.app__chat-tools', '.app__chat-tokens', '.app__chat-timestamp', '.app__chat-run']
  .filter((s) => css.split(`\n${s} {`).length > 2);
check('no item in the row is declared twice', declaredTwice, []);
check('and the row is the only thing setting their size',
  ['.app__chat-score', '.app__chat-tools', '.app__chat-tokens', '.app__chat-timestamp']
    .filter((s) => /font-size/.test(ruleFor(s) ?? '')), []);

const run = ruleFor('.app__chat-run');
check('the run chip only colours its border', /border-color:\s*var\(--figma-border\)/.test(run), true);
check('and does not re-declare the box', /padding:|border:\s*1px solid \S/.test(run), false);
// It holds several runs of text of its own, which have to sit on the same
// baseline as each other — Latin next to Japanese, centred, is the same defect
// one level down.
check('and it does not centre its own parts', /align-items:\s*center/.test(run), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
