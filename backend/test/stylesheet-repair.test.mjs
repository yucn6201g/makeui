// The design-system repair is handed a stylesheet, not a project.
//
// Every deviation it fixes is a CSS fact: `measureConformance` runs over
// `normaliseCss(html)` and nothing else — missing token values, a forbidden
// colour, palette dominance, radii, motion. And the stylesheet contract puts all
// styling in one file.
//
// Measured before this: 31,115 input tokens a call and 19,019 out, because the
// call sent `finalHtml.slice(0, 90000)` — the whole project, TypeScript and all
// — and asked for the whole project back. 7.4% of everything MakeUI spends, to
// change some hex values in a stylesheet.
//
// It is also the safer shape, which is the half worth testing. "Preserve ALL
// content, copy, structure, semantics and JavaScript EXACTLY as given" was an
// instruction asking the model not to damage code it had no reason to touch. A
// call given only the stylesheet cannot damage it at all, and the splice below
// is what makes that true.
//
//   node test/stylesheet-repair.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/tools/project/project-transport.ts')}" --bundle --platform=node ` +
    `--format=esm --outfile="${path.join(root, 'dist/ss.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const { stylesheetOf, spliceStylesheet, readProjectFiles, writeProjectDocument } = await import(
  pathToFileURL(path.join(root, 'dist/ss.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const project = writeProjectDocument(new Map([
  ['src/main.tsx', "import App from './App';\nconsole.log('mount');"],
  ['src/styles/globals.css', ':root { --accent: #8b5cf6; }\n.btn { color: var(--accent); }'],
  ['src/App.tsx', 'export default function App() { return null }'],
  ['src/styles/print.css', '@media print { .btn { display: none } }'],
]));

// --- finding it ----------------------------------------------------------------
check('the stylesheet is the largest css file, not the first',
  stylesheetOf(project)?.path, 'src/styles/globals.css');
check('and it comes back with its contents',
  stylesheetOf(project)?.body.includes('--accent'), true);

check('a document with no fences has none', stylesheetOf('<html><body>hi</body></html>'), null);
check('nor does a project with no css',
  stylesheetOf(writeProjectDocument(new Map([['src/main.tsx', 'const x = 1']]))), null);
check('an empty stylesheet does not count',
  stylesheetOf(writeProjectDocument(new Map([['a.css', '   ']]))), null);

// --- putting it back -----------------------------------------------------------
const repaired = spliceStylesheet(project, 'src/styles/globals.css',
  ':root { --accent: #0017C1; }\n.btn { color: var(--accent); }');

check('the repaired stylesheet replaces the old one',
  readProjectFiles(repaired).get('src/styles/globals.css').includes('#0017C1'), true);
check('and the old value is gone', repaired.includes('#8b5cf6'), false);

// The whole point: a call that never saw the code cannot have changed it.
const before = readProjectFiles(project);
const after = readProjectFiles(repaired);
check('every other file is byte-identical',
  [...before.keys()].filter((p) => p !== 'src/styles/globals.css' && before.get(p) !== after.get(p)),
  []);
check('and no file appeared or vanished',
  [[...before.keys()].length, [...after.keys()].length], [4, 4]);

// --- a reply that is not a stylesheet ------------------------------------------
//
// Weak on purpose — a brace and a colon. It guards against prose and markdown,
// not against bad CSS; whether the repair helped is decided by measuring the
// whole document afterwards, which is the only test that means anything.
check('prose is refused', spliceStylesheet(project, 'src/styles/globals.css',
  'ここでは色を #0017C1 に変更しました。'), null);
check('an empty reply is refused', spliceStylesheet(project, 'src/styles/globals.css', '   '), null);
check('a bare rule is accepted', typeof spliceStylesheet(project, 'src/styles/globals.css', 'a{color:red}'), 'string');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
