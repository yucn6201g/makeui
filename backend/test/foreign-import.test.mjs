// A repaired file that reaches for a package must cost that file, not the pass.
//
// Measured on request 33c8019e, one of three runs of the same brief: the first
// repair pass took the defect count from 7 to 4 and was rejected twice, and the
// run shipped its original document at the floor — 30, with runtime 0 of 18 and
// 63 points of deductions.
//
// The reason is in the log:
//
//     "reason": "broke the app: console-error-introduced",
//     "runtimeErrors": ["Error: Module not found: date-fns
//        at src/screens/HomeScreen.tsx …"]
//
// The preview bundle has no `date-fns`, so `require` threw, the page was blank,
// and every other file in that pass — the icons, the components, the fixes that
// took 7 to 4 — went with it.
//
// The prompt already forbids this. `fileSystem()` says 「you may not add a
// package dependency」 and lists what is installed. Being told is not the same as
// being stopped, and this is checkable without asking anyone.
//
//   node test/foreign-import.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'dist/foreign-entry.ts');
fs.mkdirSync(path.dirname(entry), { recursive: true });
fs.writeFileSync(entry, [
  "export { foreignImport } from '../src/orchestration/repair-files.js';",
  "export { FRAMEWORKS } from '../src/config/frameworks.js';",
].join('\n'));
execSync(
  `npx esbuild "${entry}" --bundle --platform=node --format=esm --outfile="${path.join(root, 'dist/foreign.test.mjs')}" ` +
    `--external:@aws-sdk/* --external:@smithy/* --external:@strands-agents/*`,
  { stdio: 'pipe', cwd: root }
);
const { foreignImport, FRAMEWORKS } = await import(
  pathToFileURL(path.join(root, 'dist/foreign.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- the case that cost a run ----------------------------------------------------
check('the package from request 33c8019e is caught',
  foreignImport("import { format } from 'date-fns';\nexport default function HomeScreen() { return null }", 'react'),
  'date-fns');

// --- what must NOT be caught -------------------------------------------------------
check('the framework itself is installed',
  ["import { useState } from 'react';", "import { createRoot } from 'react-dom/client';"]
    .map((b) => foreignImport(b, 'react')),
  [null, null]);
check('relative imports are the project itself',
  ["import App from './App';", "import { yen } from '../lib/format';"].map((b) => foreignImport(b, 'react')),
  [null, null]);

/*
 * A type-only import is not a dependency: it is gone once the types are
 * stripped, so it can never be a module the preview fails to supply. The scorer
 * learned this after a Svelte project that met 98% of the rubric lost eight
 * points for importing its own framework's type definitions.
 */

// A subpath of something installed is installed.
check('a subpath of an installed package is allowed',
  foreignImport("import { flushSync } from 'react-dom/client';", 'react'), null);

// --- and it holds for the other two frameworks ---------------------------------------
check('a package is foreign in every framework',
  ['react', 'vue'].map((k) => foreignImport("import x from 'lodash';", k)),
  ['lodash', 'lodash']);

/*
 * The allow-list is the bundle's, not a copy of it.
 *
 * Two lists that must agree is how the audit and the score ended up on opposite
 * sides of the same document over the login gate. This reads
 * `providedModules` — what the preview actually supplies — so a package added
 * to the bundle is permitted here the same day.
 */
for (const kind of ['react', 'vue']) {
  for (const mod of FRAMEWORKS[kind].providedModules) {
    check(`  ${kind}: ${mod} is permitted because the bundle supplies it`,
      foreignImport(`import x from '${mod}';`, kind), null);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
