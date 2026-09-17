// Saving an edited source file back into the document.
//
// The code view shows a project — folders, files, an index.html. What exists is
// one HTML document carrying those files, and editing means going the other way.
// `blockOf` is what finds the region to write into, and both `editability` and
// `applyFileEdit` are built on it.
//
// It only understood `<script data-file="…">`, the transport React projects
// travelled in before components carrying their own <script> forced the move to
// line fences. So for every project generated since, the editor reported
// 「このファイルは保存対象に含まれていません」 for every file in the tree and a save
// returned null. A whole feature, dead for every current document, because one
// helper still asked the old question — while `isProject` two lines above it had
// already been corrected for exactly that.
//
//   node test/source-edit.test.mjs      (from frontend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/utils/sourceEdit.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'node_modules/.cache/se.test.mjs')}"`,
  { stdio: 'inherit', cwd: root }
);
execSync(
  `npx esbuild "${path.join(root, 'src/utils/virtualFs.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'node_modules/.cache/vf.test.mjs')}"`,
  { stdio: 'inherit', cwd: root }
);
const { editability, applyFileEdit } = await import(
  pathToFileURL(path.join(root, 'node_modules/.cache/se.test.mjs')).href
);
const { splitHtmlToFiles } = await import(
  pathToFileURL(path.join(root, 'node_modules/.cache/vf.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const fence = (p, body) => `@@@makeui:file ${p}\n${body}\n@@@makeui:endfile\n`;
const APP = 'export default function App() { return <button className="btn">買う</button> }';
const PROJECT = `<!DOCTYPE html><html><body>\n<div id="root"></div>\n`
  + fence('src/main.tsx', "import App from './App'\n")
  + fence('src/App.tsx', APP)
  + fence('src/styles/globals.css', '.btn { border-radius: 4px; }')
  + `</body></html>`;

// --- the feature that was dead ----------------------------------------------
check('a fenced source file is editable', editability(PROJECT, 'src/App.tsx'), { editable: true });
check('so is its stylesheet', editability(PROJECT, 'src/styles/globals.css'), { editable: true });

const NEXT = 'export default function App() { return <button className="btn">購入</button> }';
const saved = applyFileEdit(PROJECT, 'src/App.tsx', NEXT);
check('a save returns a document', saved !== null, true);
check('the new content is in it', saved.includes('購入'), true);
check('the old content is gone', saved.includes('買う'), false);

// Round-tripping is the actual contract: the tree the editor shows afterwards
// must be the same tree with one file changed.
const before = splitHtmlToFiles(PROJECT);
const after = splitHtmlToFiles(saved);
check('the file list is unchanged', after.map((f) => f.path), before.map((f) => f.path));
check('and only the edited file changed',
  after.filter((f, i) => f.content !== before[i].content).map((f) => f.path),
  ['src/App.tsx']);
check('the edited file reads back exactly',
  after.find((f) => f.path === 'src/App.tsx').content, NEXT);

// Editing one file must not disturb its neighbours' fences — the failure that
// would corrupt the whole document rather than one file.
check('every fence survives', (saved.match(/@@@makeui:file /g) || []).length, 3);
check('and every closer', (saved.match(/@@@makeui:endfile/g) || []).length, 3);

// The first file in the document is the offset edge case: its block starts at
// index 0 of its line, with nothing before it to measure.
const first = applyFileEdit(PROJECT, 'src/main.tsx', "import App from './App'\n// edited");
check('the first file can be edited too', first !== null, true);
check('without losing the doctype', first.startsWith('<!DOCTYPE html>'), true);
check('and without disturbing the others',
  splitHtmlToFiles(first).find((f) => f.path === 'src/App.tsx').content, APP);

// --- what must still be refused ---------------------------------------------
check('index.html is not editable in a project',
  editability(PROJECT, 'index.html').editable, false);
check('nor is a scaffolded file',
  editability(PROJECT, 'package.json').editable, false);
check('a file that is not there is refused',
  editability(PROJECT, 'src/Nope.tsx').editable, false);
check('and saving it returns null', applyFileEdit(PROJECT, 'src/Nope.tsx', 'x'), null);

// --- the legacy transport still works ---------------------------------------
// 34 stored projects predate the fences and must keep opening.
const LEGACY = `<!DOCTYPE html><html><body>`
  + `<script type="text/jsx" data-file="src/App.tsx">${APP}</script>`
  + `</body></html>`;
check('a data-file block is still editable', editability(LEGACY, 'src/App.tsx'), { editable: true });
const legacySaved = applyFileEdit(LEGACY, 'src/App.tsx', NEXT);
check('and still saves', legacySaved.includes('購入'), true);
check('keeping the attribute that makes it meaningful',
  legacySaved.includes('type="text/jsx" data-file="src/App.tsx"'), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
