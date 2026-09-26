// Carrying a multi-part request through the edit path.
//
// A request like 「在庫画面を追加して、遷移も付けて、ボタンの色も変えて、CSVエクスポートも」
// used to be one thing at every stage: one scope, one specification, one file
// plan — and then each file was handed the WHOLE instruction, so the file whose
// job was a colour token also read "add CSV export".
//
// Nothing checked coverage either. Everything the edit path verifies afterwards
// is about defects it INTRODUCED, so three parts of four came back with no new
// defects, a clean browser, and the word "success".
//
//   node test/modify-parts.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = (src, out) =>
  execSync(
    `npx esbuild "${path.join(root, src)}" --bundle --platform=node --format=esm ` +
      `--outfile="${path.join(root, out)}" --external:@aws-sdk/* --external:@smithy/*`,
    { stdio: 'pipe', cwd: root }
  );
bundle('src/orchestration/edit/edit-files.ts', 'dist/mp-edit.test.mjs');
bundle('src/orchestration/generate/workflow-router.ts', 'dist/mp-router.test.mjs');
const { planFileEdits, applyFileEdits } = await import(
  pathToFileURL(path.join(root, 'dist/mp-edit.test.mjs')).href
);
const { widestScope } = await import(pathToFileURL(path.join(root, 'dist/mp-router.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const fence = (p, body) => `@@@makeui:file ${p}\n${body}\n@@@makeui:endfile\n`;
const PROJECT =
  '<!DOCTYPE html><html><body>\n' +
  fence('src/main.tsx', "import App from './App';") +
  fence('src/App.tsx', "export default function App() { return null }") +
  fence('src/routes.tsx', "export const routes = [];") +
  fence('src/styles/tokens.css', ':root{--brand:#111}') +
  '</body></html>';

const INSTRUCTION = '在庫管理画面を追加して、ダッシュボードから遷移できるようにし、ボタンの色をブランドカラーに変えて、CSVエクスポートも付けて';
const PARTS = [
  { text: '在庫管理画面を追加' },
  { text: 'ダッシュボードから遷移できるように' },
  { text: 'ボタンの色をブランドカラーに' },
  { text: 'CSVエクスポートを付ける' },
];

const recorder = (reply) => {
  const seen = [];
  const fn = async (system, user) => { seen.push(user); return reply; };
  fn.seen = seen;
  return fn;
};

// --- the planner is handed the decomposition ------------------------------
// Without it the planner has to split the sentence AND map it to files in one
// reading. With it, the split is done and the reading is only the mapping.
{
  const invoke = recorder(JSON.stringify({ files: [
    { path: 'src/screens/Inventory.tsx', reason: '在庫画面', parts: [1] },
    { path: 'src/styles/tokens.css', reason: 'ブランドカラー', parts: [3] },
  ] }));
  const plans = await planFileEdits(PROJECT, INSTRUCTION, '', invoke, '', PARTS);
  check('the parts are listed for the planner, numbered',
    invoke.seen[0].includes('  1. 在庫管理画面を追加') && invoke.seen[0].includes('  4. CSVエクスポートを付ける'), true);
  check('and it is told what the numbers are for',
    invoke.seen[0].includes('which of these numbers it serves'), true);
  check('the mapping comes back on the plan',
    plans.filter((p) => p.path === 'src/styles/tokens.css')[0].parts, [3]);
}
{
  // A single-part request must send the prompt it always sent.
  const withOne = recorder('{"files":[{"path":"src/App.tsx"}]}');
  const without = recorder('{"files":[{"path":"src/App.tsx"}]}');
  await planFileEdits(PROJECT, 'ボタンを青くして', '', withOne, '', [{ text: 'ボタンを青くして' }]);
  await planFileEdits(PROJECT, 'ボタンを青くして', '', without, '');
  check('one part is the same prompt as no parts', withOne.seen[0], without.seen[0]);
  check('and it mentions no decomposition', /several separate things/.test(without.seen[0]), false);
}
{
  // A planner citing part 5 of a four-part request is describing something the
  // user did not ask for.
  const invoke = recorder('{"files":[{"path":"src/App.tsx","parts":[1,5,"x",2,2]}]}');
  const plans = await planFileEdits(PROJECT, INSTRUCTION, '', invoke, '', PARTS);
  check('only numbers naming a real part survive, deduplicated', plans[0].parts, [1, 2]);
}

// --- the editor is told only its own part ---------------------------------
{
  const invoke = recorder('export default function X() { return null }');
  await applyFileEdits(
    PROJECT,
    [{ path: 'src/styles/tokens.css', create: false, reason: 'ブランドカラー', parts: [3] }],
    INSTRUCTION, '', invoke, '', PARTS
  );
  check('the file is told which part is its job',
    invoke.seen[0].includes('  - ボタンの色をブランドカラーに'), true);
  check('and told to leave the rest alone',
    invoke.seen[0].includes('Do not attempt the rest of the request here'), true);
  // The whole instruction is still present — the file needs the context — but it
  // is no longer the only thing saying what to do.
  check('the full request is still there as context', invoke.seen[0].includes(INSTRUCTION), true);
  check('and the other parts are not listed as its job',
    invoke.seen[0].includes('  - CSVエクスポートを付ける'), false);
}
{
  // An unstated mapping falls back to the whole instruction: a file given the
  // wrong fragment is a worse outcome than one given too much.
  const invoke = recorder('x');
  await applyFileEdits(PROJECT, [{ path: 'src/App.tsx', create: false, reason: '' }], INSTRUCTION, '', invoke, '', PARTS);
  check('a file with no mapping is not narrowed',
    /THIS file is responsible only for/.test(invoke.seen[0]), false);
}

// --- the widest scope -----------------------------------------------------
// One label is still wanted in places, and a mixed request should wear the
// widest of its parts rather than whichever the model happened to name first.
check('structural outranks the rest',
  widestScope([{ scope: 'visual' }, { scope: 'structural' }, { scope: 'content' }], 'visual'), 'structural');
check('behaviour outranks content and visual',
  widestScope([{ scope: 'content' }, { scope: 'behaviour' }], 'visual'), 'behaviour');
check('and a single visual part stays visual',
  widestScope([{ scope: 'visual' }], 'visual'), 'visual');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
