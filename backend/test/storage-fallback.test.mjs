/**
 * Web storage in the document the browser verification renders.
 *
 * The verification's document has an opaque origin, where reading
 * `window.localStorage` throws. A generated flashcard app that restored its
 * decks from storage rendered nothing there and scored 30 (2026-09-14), while
 * the user's preview — which already installs an in-memory stand-in — showed it
 * working. These pin the stand-in into the runnable document, run it against a
 * window whose storage throws, and hold it equal to the preview's copy.
 *
 *   node test/storage-fallback.test.mjs      (from backend/)
 */
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/tools/project/react-bundle.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/storage-fallback.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'pipe', cwd: root }
);
const { STORAGE_FALLBACK, toRunnableDocument } = await import(pathToFileURL(path.join(root, 'dist/storage-fallback.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
};

// --- it works where storage is refused -------------------------------------------------------
const refused = () => {
  const win = {};
  for (const key of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(win, key, {
      get() { throw new Error("SecurityError: Failed to read the '" + key + "' property from 'Window': Access is denied for this document."); },
      configurable: true,
    });
  }
  win.window = win;
  return vm.createContext(win);
};
const ctx = refused();
vm.runInContext(STORAGE_FALLBACK, ctx);
check('after it, window.localStorage can be read and written', vm.runInContext("window.localStorage.setItem('decks', '[1]'); window.localStorage.getItem('decks')", ctx), '[1]');
check('a bare localStorage is the same store', vm.runInContext("localStorage.getItem('decks')", ctx), '[1]');
check('a missing key reads null, as the real one does', vm.runInContext("localStorage.getItem('nope')", ctx), null);
check('values are stored as strings', vm.runInContext("localStorage.setItem('n', 3); typeof localStorage.getItem('n')", ctx), 'string');
check('sessionStorage is separate', vm.runInContext("sessionStorage.getItem('decks')", ctx), null);
check('length, key, removeItem and clear behave', vm.runInContext("var a = localStorage.length; var k = localStorage.key(0); localStorage.removeItem('n'); var b = localStorage.length; localStorage.clear(); [a, k, b, localStorage.length].join(',')", ctx), '2,decks,1,0');

// --- it leaves working storage alone --------------------------------------------------------
const real = { getItem: () => 'real', setItem() {}, removeItem() {}, clear() {}, key: () => null, length: 0 };
const ok = vm.createContext({ localStorage: real, sessionStorage: real });
vm.runInContext('var window = this;', ok);
vm.runInContext(STORAGE_FALLBACK, ok);
check('where storage works, the browser\'s own stays', vm.runInContext("localStorage.getItem('x')", ok), 'real');

// --- it is in the document the verification renders -----------------------------------------
const project = [
  '<!DOCTYPE html><html><body><div id="root"></div>',
  '@@@makeui:file src/main.tsx',
  "import { createRoot } from 'react-dom/client';",
  "import App from './App';",
  "createRoot(document.getElementById('root')!).render(<App />);",
  '@@@makeui:endfile',
  '@@@makeui:file src/App.tsx',
  "export default function App() { return <main>{localStorage.getItem('x') ?? 'empty'}</main>; }",
  '@@@makeui:endfile',
  '</body></html>',
].join('\n');
const runnable = toRunnableDocument(project, 'react');
check('the project compiles', runnable.error, null);
const head = runnable.html.slice(0, runnable.html.indexOf('</head>'));
check('the stand-in is in the head', head.includes('<script data-makeui-storage>'), true);
check('before any runtime or module script', runnable.html.indexOf('data-makeui-storage') < runnable.html.indexOf('<body>'), true);

// --- one stand-in, two copies ---------------------------------------------------------------
const guard = fs.readFileSync(path.join(root, '../frontend/src/utils/preview/previewGuard.ts'), 'utf8').split(String.fromCharCode(13)).join('');
const start = guard.indexOf('(function() {\n    var _stores');
const end = guard.indexOf('})();', start) + '})();'.length;
const squash = (s) => s.replace(/\s+/g, ' ').trim();
check('the preview installs the same stand-in the verification does', start >= 0 && squash(guard.slice(start, end)) === squash(STORAGE_FALLBACK), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
