// A screen that throws while it renders, shown as a message rather than a blank page.
//
// React unmounts the whole root when a render throws and nothing catches it, so
// one broken screen took the shell, the navigation and every other screen with
// it. Over thirty days to 2026-09-23, 15 of 123 generations shipped with a
// finding that can do that (console-error 12, blank-render 6). The recent ones
// all render after this week's fixups — but a fixup only closes a shape somebody
// has already seen, and "確実に防止" needs a net under the ones nobody has.
//
// Verified in a browser on a project whose second screen reads `.name` of
// undefined: the landing screen rendered, the broken one showed the panel with
// the message and two ways out instead of a white page, 「最初の画面へ」 brought
// the app back, and console.error carried the error so verification still
// reports it.
//
//   node test/render-boundary.test.mjs      (from backend/)
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await esbuild.build({
  entryPoints: [path.join(root, 'src/tools/framework-compile.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile: path.join(root, 'dist/rb.test.mjs'),
  external: ['@aws-sdk/*', '@smithy/*'], loader: { '.txt': 'text' }, logLevel: 'error',
});
const fc = await import(pathToFileURL(path.join(root, 'dist/rb.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- the two copies are one -----------------------------------------------------
/*
 * The backend renders what verification measures; the frontend renders what the
 * user sees. A net in only one of them either protects nobody or protects a
 * page nobody looks at.
 */
const read = (p) => fs.readFileSync(path.join(root, '..', p), 'utf8').replace(/\r\n/g, '\n');
const constant = (src) => {
  const at = src.indexOf('export const RENDER_BOUNDARY = `');
  if (at < 0) return null;
  const start = at + 'export const RENDER_BOUNDARY = `'.length;
  return src.slice(start, src.indexOf('`', start));
};
const be = constant(read('backend/src/tools/framework-compile.ts'));
const fe = constant(read('frontend/src/utils/frameworkCompile.ts'));
check('the backend has the boundary', typeof be === 'string' && be.length > 200, true);
check('the frontend has the boundary', typeof fe === 'string' && fe.length > 200, true);
check('and they are the same code', be === fe, true);

// --- it is wired where the app is mounted, in both -------------------------------
const WIRE = /root\.render = function\(el\) \{ __rendered = true; return orig\(__R\.createElement\(MakeuiBoundary, null, el\)\); \};/;
check('the backend wraps the root render', WIRE.test(read('backend/src/tools/framework-compile.ts')), true);
check('the frontend wraps the root render', WIRE.test(read('frontend/src/utils/frameworkCompile.ts')), true);
check('the builtins include the boundary', fc.RUNTIMES.react.builtins.includes('function MakeuiBoundary'), true);

// --- it is code the page's engine will run ----------------------------------------
// ES5, no backticks: it is spliced into a template literal and into a page.
check('no backticks in it', be.includes('`'), false);
check('no arrow functions or classes', /=>|\bclass\s/.test(be), false);
check('the builtins parse', (() => { try { new Function(`var __rendered;return ${fc.RUNTIMES.react.builtins}`); return true; } catch { return false; } })(), true);

// --- what it does, read from the code ------------------------------------------------
check('it catches during render', /getDerivedStateFromError/.test(be), true);
// Nothing is hidden from verification: the walk reads console errors.
check('it still reports to the console', /componentDidCatch[\s\S]*console\.error\('\[makeui\]/.test(be), true);
check('it marks the panel for the walk', /'data-makeui-render-error': ''/.test(be), true);
check('the user can leave the broken screen', /前の画面に戻る/.test(be) && /最初の画面へ/.test(be), true);
check('and the app comes back when they do', /addEventListener\('hashchange', this\.__reset\)/.test(be), true);

// --- the walk measures the panel as the failure it is ---------------------------------
const walk = read('backend/src/tools/browser-verify.ts');
check('a screen showing the panel is measured as failed',
  /querySelector\('\[data-makeui-render-error\]'\)\)\s*\{\s*fill = 0;\s*hiddenBy = 'render-error';/.test(walk), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
