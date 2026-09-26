// A page that navigates while it renders, and the walk it took down with it.
//
// Reported 2026-09-20: a 仕上げ run replied 「ブラウザ実行による検証は行っていません
// （このモードでは省略されます）」. 仕上げ verifies, and the log said it had tried:
//
//   Browser verification failed; continuing without it
//   error: "cdp timeout: Runtime.evaluate"   durationMs: 50187
//
// The walk was not slow. Replayed on the stored document, clicking the first
// item row alone — no walk at all — froze the tab. The detail screen read
// `selectedItemId` from the top of the store while the reducer wrote it under
// `state.ui`, so the guard below was true on every visit, and it navigated
// DURING ITS OWN RENDER:
//
//     if (!selectedItemId) { onNavigateItems(); return null; }
//
// navigate() updates the router while a child renders; the router renders again
// before the hash has changed; the child renders again. The page never returns
// to the event loop — not the user's clicks, not the walk, not even a timer the
// walk sets for itself.
//
// Measured over 75 stored React documents: 3 (4%) navigate during render. After
// this rewrite the same click leaves the page responsive, and the full walk over
// that document finishes in 2.6s where it had been cut off at 45s with nothing.
//
//   node test/render-navigation.test.mjs      (from backend/)
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { readFixups } from './lib/fixups-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = async (entry, out) => {
  await esbuild.build({
    entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'esm',
    outfile: path.join(root, out), external: ['@aws-sdk/*', '@smithy/*'], loader: { '.txt': 'text' },
    logLevel: 'error',
  });
  return import(pathToFileURL(path.join(root, out)).href);
};
const rn = await build('src/tools/fixups/render-navigation.ts', 'dist/rn.test.mjs');
const bv = await build('src/tools/browser/browser-verify.ts', 'dist/rnbv.test.mjs');
const ra = await build('src/orchestration/audit/runtime-audit.ts', 'dist/rnra.test.mjs');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- the reported shape ----------------------------------------------------------
const DETAIL = `export function DetailScreen({ onNavigateItems }) {
  const { selectedItemId, items } = state;

  if (!selectedItemId) {
    onNavigateItems();
    return null;
  }

  const item = items.find(i => i.id === selectedItemId);
  if (!item) {
    onNavigateItems();
    return null;
  }
  return <div>{item.name}</div>;
}`;
{
  const r = rn.deferRenderNavigation(DETAIL);
  check('both guards are found', r.found.map((f) => f.call), ['onNavigateItems()', 'onNavigateItems()']);
  check('the call moves after the render', (r.source.match(/setTimeout\(\(\) => onNavigateItems\(\), 0\);/g) || []).length, 2);
  check('the guard still renders nothing meanwhile', (r.source.match(/return null;/g) || []).length, 2);
  // No hook is added. The second guard follows an early return, and a hook
  // placed there would be called conditionally — which React rejects.
  check('no hook is introduced', /useEffect/.test(r.source), false);
  check('the rest of the component is untouched', r.source.includes('return <div>{item.name}</div>;'), true);
  check('running it twice changes nothing more', rn.deferRenderNavigation(r.source).found.length, 0);
}

// --- the other shapes in the corpus -----------------------------------------------
check('navigate(...) with an argument',
  rn.deferRenderNavigation("if (state.cart.length === 0) {\n    navigate('home');\n    return null;\n  }").found.length, 1);
check('a condition with a call in it',
  rn.deferRenderNavigation("if (!state.items.some((i) => i.ok)) { navigate('list'); return null; }").found.length, 1);
check('a router method',
  rn.deferRenderNavigation("if (!user) { router.push('/login'); return null; }").found.length, 1);

// --- what must not be touched ------------------------------------------------------
// Tight on purpose: `push` alone is an array, `go…` is `goods()`.
check('an array push is not navigation',
  rn.deferRenderNavigation('if (!x) { list.push(y); return null; }').found.length, 0);
check('an unrelated call is not navigation',
  rn.deferRenderNavigation("if (!x) { console.warn('missing'); return null; }").found.length, 0);
check('a guard that returns something is not the empty render',
  rn.deferRenderNavigation("if (!x) { navigate('a'); return <Spinner />; }").found.length, 0);
check('two statements before the return are not the pattern',
  rn.deferRenderNavigation("if (!x) { log(); navigate('a'); return null; }").found.length, 0);
// Inside an effect, navigating is already correct.
check('a guard inside an effect is left alone', rn.deferRenderNavigation(
  "useEffect(() => {\n  if (!x) {\n    navigate('a');\n    return null;\n  }\n}, [x]);").found.length, 0);
check('an already-deferred call is left alone',
  rn.deferRenderNavigation("if (!x) { setTimeout(() => navigate('a'), 0); return null; }").found.length, 0);

// --- the fixup wrapper -------------------------------------------------------------
{
  const files = new Map([
    ['src/screens/DetailScreen.tsx', DETAIL],
    ['src/screens/Ok.tsx', 'export const Ok = () => <div/>;'],
    ['src/views/A.vue', '<template><div/></template>'],
  ]);
  const r = rn.fixRenderNavigation(files);
  check('the React file is rewritten', /setTimeout/.test(r.files.get('src/screens/DetailScreen.tsx')), true);
  check('the others are not', r.files.get('src/screens/Ok.tsx'), 'export const Ok = () => <div/>;');
  check('and it says why it matters', /応答しなくなります/.test(r.fixed[0] ?? ''), true);
  check('nothing to do is nothing reported', rn.fixRenderNavigation(new Map([['a.tsx', 'x']])).fixed, []);
}
const fixups = readFixups();
check('the project pass runs it for React', /kind === 'react'[\s\S]{0,200}apply\(fixRenderNavigation\(files\)\)/.test(fixups), true);

// --- the walk cannot be taken down silently again ------------------------------------
const walk = bv.walkExpression(['a', 'b']);
check('the walk still parses', (() => { try { new Function('return ' + walk); return true; } catch { return false; } })(), true);
/*
 * A check between clicks bounds the walk only while every click comes back.
 * The whole walk now races a timer the page owns, which answers with what the
 * walk has recorded, marked cutOff.
 */
check('the walk races its own hard deadline',
  walk.includes(`setTimeout(() => resolve(partial()), ${bv.WALK_HARD_DEADLINE_MS})`) && /Promise\.race\(\[body, hard\]\)/.test(walk), true);
check('which is clear of the transport timeout', bv.WALK_HARD_DEADLINE_MS < 45_000 - 10_000, true);
check('and a test can shorten it', bv.walkExpression(['a'], 500).includes('resolve(partial()), 500)'), true);
// The partial answer reads real state, so it must be assigned before the first
// await — otherwise the timer would answer with the empty placeholder.
check('the partial answer is wired before the walk first yields',
  walk.indexOf('partial = () =>') > 0 && walk.indexOf('partial = () =>') < walk.indexOf('await tryRow();'), true);
/*
 * And when the page's main thread itself stops, no timer in it can fire. What
 * survives is what it already sent: the walk announces each press on the
 * console BEFORE it clicks, and the transport keeps those events.
 */
check('each press is announced before the click',
  walk.indexOf(`console.debug(${JSON.stringify(bv.WALK_MARK)}`) > 0
    && walk.indexOf(`console.debug(${JSON.stringify(bv.WALK_MARK)}`) < walk.indexOf('try { el.click(); }'), true);
check('the mark comes apart into what was pressed',
  bv.parsePressMark('row|#/items|カッターナイフ D棚'), { kind: 'row', hash: '#/items', label: 'カッターナイフ D棚' });
check('a label containing the separator survives',
  bv.parsePressMark('action|#/x|a|b').label, 'a|b');

// --- and the freeze is a defect the repair loop is handed ------------------------------
{
  const d = ra.pageFrozenDefect({
    reason: 'page-frozen', frozeOn: { kind: 'row', hash: '#/items', label: 'カッターナイフ' }, error: 'x', durationMs: 50187,
  });
  check('the defect has its own id', d.id, 'page-frozen');
  check('it names the control', /「カッターナイフ」（一覧の行）を押すと/.test(d.instruction), true);
  check('and the screen', /#\/items の画面で/.test(d.instruction), true);
  check('it names render-phase navigation first', /1\. 描画中の画面遷移/.test(d.instruction), true);
  check('then the value read from the wrong place', /2\.[\s\S]*state\.ui\.X[\s\S]*state\.X/.test(d.instruction), true);
  check('the reader gets a sentence too', /ページが応答しなくなります/.test(d.note), true);
  const bare = ra.pageFrozenDefect({ reason: 'page-frozen', error: 'x', durationMs: 1 });
  check('a freeze before any press is still reported', /ページを開くと/.test(bare.instruction), true);
}
const graph = fs.readFileSync(path.join(root, 'src/orchestration/generate/graph.ts'), 'utf8');
check('the pipeline hands the freeze to the repair loop',
  /failure\?\.reason === 'page-frozen'\)\s*\{\s*runtimeDefects\.push\(pageFrozenDefect\(failure\)\)/.test(graph), true);
check('and tells the reply that it asked', /verifyAttempted: useBrowserVerify/.test(graph), true);
check('the failure log carries the run it belongs to',
  /Browser verification failed; continuing without it', \{\s*requestId: options\.requestId/.test(
    fs.readFileSync(path.join(root, 'src/tools/browser/browser-verify.ts'), 'utf8')), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
