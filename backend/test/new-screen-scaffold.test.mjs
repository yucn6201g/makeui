// A new screen the model could not produce, rather than nothing at all.
//
// Measured on real edits: a new `ContactScreen` came back unparseable on both
// attempts, and the consistency net correctly dropped everything that served it
// — the route, the App branch, the footer link — because a project describing a
// screen it does not have is worse than one that never grew the route. The user
// then asked for a contact page, the edit changed nothing, and reported success.
//
// So the file is scaffolded instead: a heading and a line, in the project's own
// framework. The route resolves, the rest of the change survives, and the screen
// is thin rather than absent — which `screen-thin` reports in the same run.
//
// Two things have to hold and they pull in opposite directions. The scaffold has
// to COMPILE, or it has traded a missing screen for a broken build. And it must
// apply only to a file being created: an edit to an existing file is dropped,
// because the original is intact and a working file beats a placeholder of one.
//
//   node test/new-screen-scaffold.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// The function is not exported — it is an implementation detail of one edit
// path — so it is lifted out of the source and run. Reading it back this way is
// the same trade the other source-reading tests make: the alternative is
// widening a module's surface for a test.
const src = fs.readFileSync(path.join(root, 'src/orchestration/edit-files.ts'), 'utf8');
const at = src.indexOf('function newScreenScaffold');
check('the scaffold was found', at > 0, true);
const body = src.slice(at, src.indexOf('\n}', at) + 2);
const newScreenScaffold = new Function(
  'kind', 'filePath',
  body.replace(/^function newScreenScaffold\([^)]*\): string \{/, '').replace(/\}\s*$/, '')
);

// --- what it produces ------------------------------------------------------------
{
  const react = newScreenScaffold('react', 'src/screens/ContactScreen.tsx');
  check('react: a default export', /export default function ContactScreen\(\)/.test(react), true);
  check('react: the name is the screen, not the file',
    /<h1>Contact<\/h1>/.test(react), true);

  const vue = newScreenScaffold('vue', 'src/screens/OrderHistoryScreen.vue');
  check('vue: a template', /^<template>/.test(vue), true);
  // `OrderHistoryScreen` -> `Order History`: the suffix goes and the camel hump
  // becomes a space, because a heading is read by a person.
  check('vue: the heading is spaced', /<h1>Order History<\/h1>/.test(vue), true);


  // A path whose name is only the suffix must not produce an empty heading.
  check('a screen called Screen keeps a name',
    /<h1>Screen<\/h1>/.test(newScreenScaffold('react', 'src/screens/Screen.tsx')), true);
}

// --- and it compiles -------------------------------------------------------------
//
// The point of the whole change. A scaffold that does not build has traded a
// missing screen for a broken project, which is the worse of the two.
{
  execSync(
    `npx esbuild "${path.join(root, 'src/tools/framework-compile.ts')}" --bundle --platform=node --format=esm ` +
      `--outfile="${path.join(root, 'dist/fc.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
    { stdio: 'pipe', cwd: root }
  );
  const { compileFile } = await import(pathToFileURL(path.join(root, 'dist/fc.test.mjs')).href);
  for (const [kind, file] of [
    ['react', 'src/screens/ContactScreen.tsx'],
    ['vue', 'src/screens/ContactScreen.vue'],
  ]) {
    const out = newScreenScaffold(kind, file);
    let error = null;
    try { error = compileFile(file, out, kind)?.error ?? null; } catch (e) { error = String(e); }
    check(`${kind}: the scaffold compiles`, error, null);
  }
}

// --- who gets one ----------------------------------------------------------------
{
  const flat = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ').replace(/\s+/g, ' ');
  /*
   * Both conditions, and both matter. Without `plan?.create` an edit to an
   * existing file would be replaced by a placeholder — throwing away a working
   * file to avoid an unwritten one. Without `screenFile` a failed store, router
   * or component would be scaffolded, and a stubbed router is a project that
   * navigates nowhere.
   */
  check('only a file being created is scaffolded', flat.includes('if (!plan?.create || !fw.screenFile.test(r.path)) return r'), true);
  check('and the rescue happens before the consistency net reads the results',
    flat.indexOf('const settled = results.map') < flat.indexOf('const usable = settled.filter'), true);
  check('the net reads the settled list, not the raw one',
    flat.includes('const usable = settled.filter') && flat.includes('const skipped = settled.filter'), true);
  check('and it is reported rather than silent',
    flat.includes("logger.info('New screens scaffolded after the model could not produce them'"), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
