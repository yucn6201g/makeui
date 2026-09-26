/**
 * A named import the target module does not export.
 *
 * The verification bundle is a CommonJS registry, so a missing name is not a
 * build error — it is `undefined`, and rendering it is React #130 with no
 * component named. Both live generations on 2026-09-13 had repair passes
 * rejected for that, and a scan of 36 stored outputs found it in 11 that had
 * already shipped: a booking app whose 「確認へ進む」 called `isPastDate` from a
 * module that does not export it, screens importing `useAppState` from a store
 * that never defined it, a dialog importing `{ Modal }` from a default export.
 *
 * The fixtures below are shaped on those files.
 *
 *   node test/export-mismatch.test.mjs      (from backend/)
 */
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const entry = path.join(root, 'dist/export-mismatch-entry.ts');
fs.mkdirSync(path.dirname(entry), { recursive: true });
fs.writeFileSync(entry, [
  "export { missingExports, fixNamedImportOfDefault, moduleDefects, toRunnableDocument } from '../src/tools/project/react-bundle.js'",
  "export { fixupProject } from '../src/tools/fixups/framework-fixups.js'",
  "export { rejectedCandidateKey } from '../src/utils/rejected-candidate.js'",
].join('\n'));
const out = path.join(root, 'dist/export-mismatch.test.mjs');
await esbuild.build({
  entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out,
  external: ['@aws-sdk/*', '@smithy/*', '@strands-agents/*', 'esbuild'], loader: { '.txt': 'text' }, logLevel: 'error',
});
const m = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const fence = (p, body) => `@@@makeui:file ${p}\n${body}\n@@@makeui:endfile\n`;
const doc = (...blocks) => `<!DOCTYPE html><html><body><div id="root"></div>\n${blocks.join('')}</body></html>`;

const SHELL = [
  fence('src/main.tsx', "import { createRoot } from 'react-dom/client';\nimport App from './App';\ncreateRoot(document.getElementById('root')!).render(<App />);"),
  fence('src/App.tsx', "import ConfirmDialog from './components/ui/ConfirmDialog';\nimport BookingScreen from './screens/BookingScreen';\nexport default function App() { return <main><BookingScreen /><ConfirmDialog /></main>; }"),
];
const PROJECT = doc(
  ...SHELL,
  fence('src/components/ui/Modal.tsx', "export default function Modal({ children }: { children: React.ReactNode }) { return <div>{children}</div>; }"),
  fence('src/components/ui/Button.tsx', "const Button = (p: { label: string }) => <button>{p.label}</button>;\nexport default Button;"),
  fence('src/components/ui/ConfirmDialog.tsx', "import { Modal } from './Modal';\nimport { Button } from './Button';\nexport default function ConfirmDialog() { return <Modal><Button label=\"OK\" /></Modal>; }"),
  fence('src/lib/bookingHelpers.ts', "export function getTimeOptions() { return ['09:00']; }\nexport type Slot = { start: string };"),
  fence('src/screens/BookingScreen.tsx', "import { isPastDate, getTimeOptions, type Slot } from '../lib/bookingHelpers';\nexport default function BookingScreen() {\n  const submit = () => { if (isPastDate('2026-01-01')) return; };\n  const s: Slot = { start: getTimeOptions()[0] };\n  return <form onSubmit={submit}>{s.start}</form>;\n}"),
  fence('src/store/types.ts', "export interface State { n: number }"),
  fence('src/store/reducer.ts', "import { State, AppAction } from './types';\nexport function reducer(s: State, a: AppAction): State { return s; }"),
);

// --- what is missing --------------------------------------------------------------
const found = m.missingExports(PROJECT).map((x) => `${x.importer} ${x.name}${x.targetHasDefault ? ' (default exists)' : ''}`).sort();
check('every named import the target does not export is found', found, [
  'src/components/ui/ConfirmDialog.tsx Button (default exists)',
  'src/components/ui/ConfirmDialog.tsx Modal (default exists)',
  'src/screens/BookingScreen.tsx isPastDate',
  'src/store/reducer.ts AppAction',
]);
check('an `import { type X }` is not checked', found.some((f) => /Slot/.test(f)), false);

// Silence where it cannot be sure.
const star = doc(...SHELL,
  fence('src/components/index.ts', "export * from 'some-package';"),
  fence('src/screens/X.tsx', "import { Anything } from '../components';\nexport default function X() { return <Anything />; }"));
check('an export * it cannot follow says nothing', m.missingExports(star), []);
const barrel = doc(...SHELL,
  fence('src/components/Card.tsx', "export function Card() { return <div/>; }"),
  fence('src/components/index.ts', "export * from './Card';\nexport { default as Pill } from './Pill';"),
  fence('src/components/Pill.tsx', "export default function Pill() { return <i/>; }"),
  fence('src/screens/X.tsx', "import { Card, Pill } from '../components';\nexport default function X() { return <><Card /><Pill /></>; }"));
check('a barrel re-exporting by star and by alias is read through', m.missingExports(barrel), []);

// --- which of them matter at runtime ---------------------------------------------------
const defects = m.moduleDefects(PROJECT).filter((d) => d.id === 'export-missing');
check('the ones used as values become a defect', defects.length, 1);
check('naming the called function and the rendered components',
  ['isPastDate', 'Modal', 'Button'].every((n) => defects[0].instruction.includes(` ${n} を import`)), true);
check('but not a name used only as a type, which the transform erases', defects[0].instruction.includes('AppAction'), false);
check('it carries the importer and the target, so the planner is skipped',
  defects[0].paths.includes('src/screens/BookingScreen.tsx') && defects[0].paths.includes('src/lib/bookingHelpers.ts'), true);
check('and it is part of the module defects every path already collects',
  m.moduleDefects(PROJECT).some((d) => d.id === 'export-missing'), true);

// --- the half that is mechanical -----------------------------------------------------------
const fixed = m.fixNamedImportOfDefault(PROJECT);
check('a named import of a default export is rewritten', fixed.html.includes("import Modal from './Modal'") && fixed.html.includes("import Button from './Button'"), true);
check('what it cannot know is left for the repair', m.missingExports(fixed.html).map((x) => x.name).sort(), ['AppAction', 'isPastDate']);
check('and it is part of fixupProject', m.fixupProject(PROJECT, 'react').html.includes("import Modal from './Modal'"), true);
check('the result still compiles', Boolean(m.toRunnableDocument(fixed.html).error), false);

const aliased = doc(...SHELL,
  fence('src/components/ui/Modal.tsx', "export default function Modal() { return <div/>; }"),
  fence('src/screens/X.tsx', "import { Modal as Dialog, useThing } from '../components/ui/Modal';\nexport default function X() { useThing(); return <Dialog />; }"));
check('an alias keeps its local name, and the other names stay named',
  m.fixNamedImportOfDefault(aliased).html.includes("import Dialog, { useThing } from '../components/ui/Modal'"), true);
const collision = doc(...SHELL,
  fence('src/lib/format.ts', "export default function format() { return ''; }"),
  fence('src/screens/X.tsx', "import { formatCurrency } from '../lib/format';\nexport default function X() { return <b>{formatCurrency(1)}</b>; }"));
check('a name that is neither the default nor the file is not guessed onto the default',
  m.fixNamedImportOfDefault(collision).fixed, []);

// --- wired into the judge -------------------------------------------------------------------
const graph = read('src/orchestration/generate/graph.ts');
const judge = graph.slice(graph.indexOf('const judgeRepair = async ('), graph.indexOf('const repairBudget = new RepairBudget()'));
check('a repair candidate gets the deterministic corrections before it is judged',
  judge.indexOf('fixupProject(candidate, outputKind)') > 0 && judge.indexOf('fixupProject(candidate, outputKind)') < judge.indexOf('toRunnableDocument(candidate, outputKind)'), true);
check('a candidate that broke the app is diagnosed and kept',
  /logger\.info\('A repair candidate broke the app'[\s\S]*?missingExports:[\s\S]*?keepRejectedCandidate\(requestId, pass, kind, candidate\)/.test(judge), true);
check('and the importers named rank first among the single-file reverts', /\.\.\.mismatched\.map\(\(m\) => m\.importer\)/.test(judge), true);
// --- and into both edit paths ------------------------------------------------------------------
const meta = read('src/orchestration/edit/meta-orchestrator.ts');
check('a per-file edit gets the same corrections', /return correctIdioms\(syntax\.html, 'Per-file edit'\)/.test(meta), true);
check('and a full rewrite does too', /return correctIdioms\(syntax\.html, 'Full rewrite'\)/.test(meta), true);
check('through fixupProject, for whatever framework the project is',
  /function correctIdioms[\s\S]*?const kind = detectKind\(readProjectFiles\(html\)\.keys\(\)\)[\s\S]*?fixupProject\(html, kind\)/.test(meta), true);

// --- and the preview's 修復する request carries the cause ---------------------------------------
const prefix = /const RUNTIME_REPAIR_PREFIX = '([^']+)'/.exec(meta)?.[1];
check('the backend recognises the sentence the frontend writes',
  Boolean(prefix) && read('../frontend/src/utils/chat/runtimeRepair.ts').includes(`'${prefix}`), true);
check('it appends the import defects the source shows, and nothing for other instructions',
  /if \(!instruction\.startsWith\(RUNTIME_REPAIR_PREFIX\)\) return instruction[\s\S]*?d\.id === 'export-missing' \|\| d\.id === 'import-missing'[\s\S]*?if \(found\.length === 0\) return instruction/.test(meta), true);
check('the edit plans from the diagnosed request', /const instruction = withStaticDiagnosis\(requestedInstruction, html\)/.test(meta), true);
check('but its checklist comes from what the user asked', /extractRequirements\(requestedInstruction\)/.test(meta), true);

check('kept under jobs/, which the bucket expires in seven days',
  m.rejectedCandidateKey('req-1', 2, 'per-file (routing reverted)'), 'jobs/req-1/rejected/pass2-per-file-routing-reverted.html');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
