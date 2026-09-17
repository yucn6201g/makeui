// Tests for deciding which clicked controls actually did nothing.
//
// The rule this covers had stopped working without anyone noticing. It required
// the previously recorded click to have changed screens, which was true when nav
// clicks were consecutive; a row click was later interleaved between every pair
// of them, so the predecessor became a row click and the condition became
// unsatisfiable. It reported nothing, and nothing reads exactly like clean.
//
// The recorded walks below are real: they were produced by running the actual
// walk expression in a browser against a shell holding a nav link, a menu
// toggle, an aria-only toggle and one deliberately dead button.
//
//   node test/dead-nav.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/tools/browser-verify.ts')}" --bundle --platform=node --format=esm ` +
    `--loader:.txt=text --outfile="${path.join(root, 'dist/dn.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'inherit', cwd: root }
);
const { deadControls, deadActions, throwingControls } = await import(pathToFileURL(path.join(root, 'dist/dn.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const row = (responded = false) => ({ kind: 'row', label: '行1', href: '', hashBefore: '', changed: responded, responded });
const nav = (label, o = {}) => ({
  kind: 'nav', label, href: o.href ?? '', hashBefore: o.hashBefore ?? '',
  changed: o.changed ?? false, responded: o.responded ?? o.changed ?? false,
});

/**
 * The walk this module was rewritten against, transcribed from the browser.
 *
 * 一覧 is the landing screen's own item and correctly does nothing; メニュー
 * opens a dropdown; 通知 flips aria-expanded and nothing else; ヘルプ is wired
 * to an empty handler.
 */
const REAL = [
  row(), nav('一覧'), row(),
  nav('詳細', { href: '#/detail', hashBefore: '', changed: true }),
  row(), nav('メニュー', { hashBefore: '#/detail', responded: true }),
  row(), nav('通知', { hashBefore: '#/detail', responded: true }),
  row(), nav('ヘルプ', { hashBefore: '#/detail' }),
  row(),
];

check('only the genuinely dead control is reported', deadControls(REAL), ['ヘルプ']);

// The regression this replaces. Kept as an explicit statement of the old rule so
// a future change that reintroduces it fails here rather than in production.
const oldRule = (list) =>
  list.filter((n, i) => n.kind === 'nav' && !n.changed && n.label && i > 0 && list[i - 1]?.changed).map((n) => n.label);
check('the rule it replaces saw nothing on the same walk', oldRule(REAL), []);

// --- what must never be called dead --------------------------------------
check('a control that opened a menu is not dead',
  deadControls([nav('一覧', { changed: true }), nav('メニュー', { responded: true })]), []);
check('a control that only flipped an attribute is not dead',
  deadControls([nav('一覧', { changed: true }), nav('通知', { responded: true })]), []);
check('a link to the screen already showing is not dead',
  deadControls([
    nav('一覧', { href: '#/list', changed: true }),
    nav('詳細', { href: '#/detail', hashBefore: '#/list', changed: true }),
    nav('詳細', { href: '#/detail', hashBefore: '#/detail' }),
  ]), []);
// A hash carrying an id is still the same screen.
check('a link to the current screen with an id is not dead',
  deadControls([
    nav('一覧', { changed: true }),
    nav('詳細', { href: '#/detail', hashBefore: '#/detail/42' }),
  ]), []);
check('the first control is never judged', deadControls([nav('一覧'), nav('詳細', { changed: true })]), []);
check('an unlabelled control is not reported',
  deadControls([nav('一覧', { changed: true }), nav('')]), []);
check('row clicks are never reported',
  deadControls([nav('一覧', { changed: true }), { ...row(), label: '行1' }]), []);

// A page where nothing at all responded is a failed walk, not an app with a
// dead navigation. Reporting every control would blame the app for the probe.
check('a frozen page reports nothing',
  deadControls([nav('一覧'), nav('詳細'), nav('設定')]), []);
check('an empty walk reports nothing', deadControls([]), []);
// Liveness may be demonstrated by a row rather than by the nav.
check('a responding row is enough to judge the nav',
  deadControls([nav('一覧'), row(true), nav('ヘルプ')]), ['ヘルプ']);

// --- what must be called dead --------------------------------------------
check('several dead controls are all reported',
  deadControls([nav('一覧', { changed: true }), nav('ヘルプ'), nav('設定')]), ['ヘルプ', '設定']);
check('the same label is reported once',
  deadControls([nav('一覧', { changed: true }), nav('ヘルプ'), nav('ヘルプ')]), ['ヘルプ']);
// The href check must not excuse a control that points somewhere else.
check('a link to another screen that did nothing is dead',
  deadControls([
    nav('一覧', { changed: true }),
    nav('設定', { href: '#/settings', hashBefore: '#/list' }),
  ]), ['設定']);
// A button has no href, so the current-screen excuse cannot apply to it.
check('a button that did nothing is dead',
  deadControls([nav('一覧', { changed: true }), nav('保存', { hashBefore: '#/list' })]), ['保存']);

// --- in-screen buttons ----------------------------------------------------
// The check closest to what this product claims to make. A mock whose nav works
// and whose 追加 and 保存 buttons do nothing is a picture of an application, and
// nothing pressed those buttons at all until the walk was extended.
const act = (label, responded = false) => ({
  kind: 'action', label, href: '', hashBefore: '#/list', changed: responded, responded,
});

check('a button that did nothing is reported',
  deadActions([nav('一覧', { changed: true }), act('保存')]), ['保存']);
check('a button that changed something is not',
  deadActions([nav('一覧', { changed: true }), act('追加', true)]), []);
// No first-control exemption here: unlike a nav item pointing at the current
// screen, a 保存 button has no honest reason to sit there doing nothing.
check('the first action is judged too', deadActions([act('保存'), act('追加', true)]), ['保存']);
check('nav items are not counted as actions',
  deadActions([nav('一覧', { changed: true }), nav('ヘルプ')]), []);
check('rows are not counted as actions',
  deadActions([nav('一覧', { changed: true }), row(true), { ...row(), kind: 'row' }]), []);
check('the same label is reported once',
  deadActions([nav('一覧', { changed: true }), act('保存'), act('保存')]), ['保存']);
check('several dead buttons are all reported',
  deadActions([nav('一覧', { changed: true }), act('保存'), act('申請')]), ['保存', '申請']);
// Same liveness guard: a page that never responded is a failed walk.
check('a frozen page reports no dead buttons', deadActions([act('保存'), act('申請')]), []);
check('an unlabelled button is not reported',
  deadActions([nav('一覧', { changed: true }), act('')]), []);
check('an empty walk reports nothing', deadActions([]), []);
// The two lists must not overlap — a control belongs to exactly one of them.
const MIXED = [nav('一覧', { changed: true }), nav('ヘルプ'), act('保存'), act('追加', true)];
check('nav and action findings are disjoint',
  [deadControls(MIXED), deadActions(MIXED)], [['ヘルプ'], ['保存']]);

// --- controls that throw ---------------------------------------------------
//
// A different finding from a dead control, and a worse one: a dead button does
// nothing, a throwing button takes the screen down. Reported by a user clicking
// through a generated storefront:
//
//   TypeError: Cannot read properties of undefined (reading 'params')
//     at hash (…) at onClick (…)
//
// That reached the pipeline only as an anonymous console-error carrying a stack
// into a bundled file the repair planner cannot open — it had to infer both
// which control and which line. The walk pressed the button; it just swallowed
// what happened ("try { el.click() } catch {}"), and a React handler does not
// throw back through click() anyway.
const threw = (label, error) => ({
  kind: 'action', label, href: '', hashBefore: '#/list', changed: false, responded: false,
  threw: [error],
});

check('a control that threw is named with what it threw',
  throwingControls([nav('一覧', { changed: true }), threw('詳細を見る', "Cannot read properties of undefined (reading 'params')")]),
  [{ label: '詳細を見る', error: "Cannot read properties of undefined (reading 'params')" }]);

check('a control that worked is not reported',
  throwingControls([nav('一覧', { changed: true }), act('追加', true)]), []);

// A dead control and a throwing control are different faults; a button can be
// both (it threw, so nothing changed) and the throw is the one worth reporting.
const both = threw('保存', 'x is not a function');
check('a throwing control is reported as throwing', throwingControls([both]).length, 1);
check('and still counts as dead, which is a separate finding',
  deadActions([nav('一覧', { changed: true }), both]), ['保存']);

// One entry per label, so one broken component in a list of twelve does not
// produce twelve identical findings.
check('repeats of the same control collapse',
  throwingControls([threw('詳細', 'boom'), threw('詳細', 'boom'), threw('詳細', 'boom')]).length, 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
