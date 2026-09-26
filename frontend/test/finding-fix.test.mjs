// The findings under a reply became things you can act on, and the count beside
// the score went away.
//
// Two numbers sat a centimetre apart and disagreed, which is what the user
// reported. They were measuring different things:
//
//   未解決の指摘 N件   the findings still open when the run ended — the list
//   未修正 N件        `unrepairedDefects`, what the repair budget declined to
//                     spend a call on
//
// A defect can be in either, both or neither: one the budget skipped may be
// fixed by another file's repair, and one it did spend a call on may still be
// open. Both were labelled as things that were not fixed. The list is the one a
// person can act on, so it is the one that stays — and every item in it now has
// a button.
//
//   node test/finding-fix.test.mjs      (from frontend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { APP_FILES, readApp } from './lib/app-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/utils/chat/findingFix.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist-test/ff.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const { findingFixInstruction, findingFixMessage, FINDING_FOR_MODEL, FINDING_FOR_TRANSCRIPT } =
  await import(pathToFileURL(path.join(root, 'dist-test/ff.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const app = readApp();
const css = fs.readFileSync(path.join(root, 'src/index.css'), 'utf8');

// --- what the button sends -----------------------------------------------------
const FINDING = 'スタイルが各コンポーネントに散っていて、共通化されていません。';
{
  const instruction = findingFixInstruction(FINDING);
  check('the finding is carried verbatim', instruction.includes(FINDING), true);
  /*
   * The edit path answers an instruction by rewriting whole files. Measured on
   * this project's own storefront: an edit asked to make product cards
   * clickable rewrote the screen, deleted the working ProductCard and invented
   * a `product.imageUrl` the data has not got. So the instruction bounds itself.
   */
  check('and it is told not to change anything else', /ほかの画面・文言・データ・構成はそのまま/.test(instruction), true);
  check('and not to rebuild what works', /動いている部品を作り直さず/.test(instruction), true);
}
check('an empty finding sends nothing', findingFixInstruction('   '), null);

// Two budgets: the model can afford more of a long finding than the bubble can.
{
  const long = 'あ'.repeat(FINDING_FOR_MODEL + 500);
  check('a long finding is clipped for the model',
    findingFixInstruction(long).includes('あ'.repeat(FINDING_FOR_MODEL) + '…'), true);
  check('and clipped harder for the transcript',
    findingFixMessage(long).includes('あ'.repeat(FINDING_FOR_TRANSCRIPT) + '…'), true);
  check('the transcript budget is the smaller one', FINDING_FOR_TRANSCRIPT < FINDING_FOR_MODEL, true);
}
// What goes in the thread is the person's message, not the prompt.
check('the thread shows a sentence, not the instruction',
  findingFixMessage(FINDING).startsWith('次の指摘の修正を依頼しました。'), true);
check('and it still quotes the finding', findingFixMessage(FINDING).includes(FINDING), true);

// --- the button ----------------------------------------------------------------
check('every finding gets one', /onClick=\{\(\) => handleFixFinding\(item\)\}/.test(app), true);
check('it is a real button, not a link', /className="app__findings-fix"[\s\S]{0,200}type="button"|type="button"[\s\S]{0,200}className="app__findings-fix"/.test(app), true);
// A click while something is running would queue a second job against a
// document that is about to change.
check('it is disabled while a run is in flight',
  /className="app__findings-fix"[\s\S]{0,300}disabled=\{!displayHtml \|\| rebuilding \|\| isProcessing\}/.test(app), true);
check('and the handler refuses the same cases',
  /const handleFixFinding = \(finding: string\) => \{\s*\n\s*if \(!displayHtml \|\| rebuilding \|\| isProcessing\) return;/.test(app), true);
// One finding per request — the pipeline's own measurement, not a preference.
// (The words appear in a comment saying why there is not one, so this looks for
// the label of a control rather than for the string.)
check('there is no combined "fix everything" button', />\s*まとめて修正/.test(app), false);
check('the button has styling', /\.app__findings-fix \{/.test(css), true);
check('including a disabled state', /\.app__findings-fix:disabled/.test(css), true);

// --- the count beside the score is gone ------------------------------------------
check('no 未修正 chip is rendered', /未修正 \{/.test(app), false);
check('the thread no longer carries the number',
  /unrepairedDefects\?: number/.test(app), false);
check('nor does the generate hook',
  /unrepairedDefects/.test(fs.readFileSync(path.join(root, 'src/hooks/useGenerate.ts'), 'utf8')), false);
check('nor the stored-message type',
  /unrepairedDefects/.test(fs.readFileSync(path.join(root, 'src/hooks/useChatHistory.ts'), 'utf8')), false);
check('and its style rule went with it', /app__chat-unrepaired/.test(css), false);
// The reply's own count stays: it heads the list the button acts on.
check('the findings count is still shown', /未解決の指摘 \{block\.count\}件/.test(app), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
