// Svelte is gone, and nothing quietly puts it back.
//
// Removed on 2026-09-18 after three weeks of production told the same story on
// every measure: of 66 Svelte runs the first audit found a blank render in 36
// (55%) against 9 of 151 React runs (6%), console errors in 51 (77%) against 24
// (16%), and 33 of the 39 framework repairs in the codebase existed for Svelte
// alone. The cause is not the framework — the model writes Svelte 4 idioms into
// a Svelte 5 project, which is the same collision every one of those repairs was
// written for — but the cost landed here.
//
// What this holds: the option is not offered, the compiler is not carried, and
// a project stored under it is not listed. A generation cannot select it, so a
// repair for it can never be needed again.
//
//   node test/svelte-removed.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/** Source lines that name svelte, excluding comments — history may stay written down. */
function mentions(dir) {
  const hits = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/node_modules|dist|vendor/.test(e.name)) walk(p); continue; }
      if (!/\.(m?[jt]sx?)$/.test(e.name)) continue;
      const rel = path.relative(root, p).replace(/\\/g, '/');
      if (rel.endsWith('test/svelte-removed.test.mjs')) continue;
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        if (!/svelte/i.test(line)) continue;
        if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue;   // a comment recording why
        // The one live use of the word is what retires it from the project list.
        if (/RETIRED = new Set/.test(line)) continue;
        hits.push(`${rel}: ${line.trim().slice(0, 80)}`);
      }
    }
  })(dir);
  return hits;
}

check('the backend runs no Svelte code', mentions(path.join(root, 'backend/src')), []);
check('nor does the frontend', mentions(path.join(root, 'frontend/src')), []);

// --- the option is not offered ------------------------------------------------
const frameworks = fs.readFileSync(path.join(root, 'backend/src/config/frameworks.ts'), 'utf8');
check('the framework registry has two kinds', /export type OutputKind = 'react' \| 'vue';/.test(frameworks), true);
const app = fs.readFileSync(path.join(root, 'frontend/src/App.tsx'), 'utf8');
check('the picker offers no Svelte', /id: 'svelte'/.test(app), false);
const list = fs.readFileSync(path.join(root, 'frontend/src/components/ProjectList.tsx'), 'utf8')
  .split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
check('and neither does the project filter', /svelte/i.test(list), false);

// --- the compiler is not carried ----------------------------------------------
for (const pkg of ['backend/package.json', 'frontend/package.json']) {
  const json = JSON.parse(fs.readFileSync(path.join(root, pkg), 'utf8'));
  const deps = { ...json.dependencies, ...json.devDependencies };
  check(`${pkg} does not depend on svelte`, Object.keys(deps).some((d) => /^svelte/.test(d)), false);
}
check('and no Svelte runtime is vendored',
  fs.readdirSync(path.join(root, 'backend/src/vendor')).some((f) => /svelte/i.test(f)), false);

// --- a stored project built with it is not listed -------------------------------
const service = fs.readFileSync(path.join(root, 'backend/src/services/project-service.ts'), 'utf8');
check('the listing filters the retired framework out',
  /RETIRED = new Set\(\['svelte'\]\)/.test(service) && /!RETIRED\.has\(item\.outputKind\?\.S \?\? ''\)/.test(service), true);
// The rows themselves are untouched: hiding is reversible, deleting is not, and
// two of the six projects belong to another account.
check('and nothing deletes them', /DeleteItemCommand[\s\S]{0,200}outputKind/.test(service), false);

// --- the repairs that are left are not Svelte's ---------------------------------
const fixups = fs.readFileSync(path.join(root, 'backend/src/tools/framework-fixups.ts'), 'utf8');
const exported = [...fixups.matchAll(/^export function (fix\w+)/gm)].map((m) => m[1]);
check('no repair is named for Svelte', exported.filter((n) => /svelte/i.test(n)), []);
/*
 * Half of what it was, not a budget for what comes next.
 *
 * 4,067 lines before the removal and 1,552 after. The ceiling is here to catch
 * Svelte's 33 repairs coming back in bulk, not to stop the file growing: three
 * repairs written since for React and Vue took it to 2,021, which is the kind
 * of growth this file is for. Raised with the number it was raised at, so the
 * next person can see whether the trend is repairs or a re-added framework —
 * and the check above, that no repair is NAMED for Svelte, is the one that
 * actually says which.
 *
 * 2026-09-20: 2,622, for four more React/Vue repairs — the input font, keyboard
 * reach, the undrawn artwork and the tokens that artwork reads. Most of each one
 * lives outside this file (tools/form-controls.ts, keyboard-reach.ts,
 * artwork.ts); what landed here is the entry point and its wiring into
 * fixupProject, which is about fifteen lines of the same shape per repair.
 * That repetition is the next thing to take out if this keeps growing.
 */
check('and the file is about half of what it was', fixups.split('\n').length < 2800, true);

// --- nothing imports a Svelte compiler anywhere ---------------------------------
let tracked = '';
try {
  tracked = execSync('git ls-files', { cwd: root, encoding: 'utf8' });
} catch { /* no git in CodeBuild's zip */ }
if (tracked) {
  check('no tracked file is a .svelte file', tracked.split('\n').filter((f) => /\.svelte(\.[jt]s)?$/.test(f)), []);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
