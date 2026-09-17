// The runtime defects nothing had ever been seen to report.
//
// Three checks in runtime-audit.ts had never fired on a real run:
// route-not-a-route, action-throws and text-over-image. "Never fired" has two
// readings — the fault is rare, or the detector is broken — and only one of
// them is fine. Nothing distinguished them, because these read browser facts
// rather than source, so no stored document exercises them and the only way
// they had ever been reached was by generating and hoping.
//
// So they are given the facts that must trigger them. A detector that stays
// silent here is broken; one that speaks here and stays quiet in production is
// simply reporting that the fault did not happen, which is the answer we
// wanted.
//
//   node test/runtime-audit.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/orchestration/runtime-audit.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/ra.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'pipe', cwd: root }
);
const { auditRuntime, runtimeRegressions } = await import(pathToFileURL(path.join(root, 'dist/ra.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const screen = (id) => ({ id, fill: 1, emptyBoxes: [], reachable: true, broken: [] });
// A run with nothing wrong with it, which every case below is one edit away from.
const CLEAN = {
  screens: [screen('home'), screen('list')],
  deadNav: [], deadActions: [], throwing: [], smallFields: [],
  unreachable: [], consoleErrors: [], contrast: [], mobile: null,
};
const fires = (id, facts) => auditRuntime({ ...CLEAN, ...facts }).some((d) => d.id === id);

check('a clean run reports none of the three',
  ['route-not-a-route', 'action-throws', 'text-over-image'].filter((id) => fires(id, {})), []);

// --- route-not-a-route ---------------------------------------------------------
// The router and its call sites disagreeing about what a route is. Neither form
// throws — a template literal stringifies anything — so they ship as routes
// nobody can parse, with a clean console and no build error.
check('navigate(item.id) into a function taking a Route',
  fires('route-not-a-route', { screens: [screen('home'), screen('undefined')] }), true);
check('navigate({screen}) into a function taking a ScreenId',
  fires('route-not-a-route', { screens: [screen('home'), screen('[object%20Object]')] }), true);
check('and the unencoded spelling of it',
  fires('route-not-a-route', { screens: [screen('home'), screen('[object Object]')] }), true);
check('null, NaN and booleans too',
  ['null', 'NaN', 'false'].every((id) => fires('route-not-a-route', { screens: [screen(id)] })), true);
// A real screen id must never be mistaken for one of these.
check('a screen legitimately called undefined-state is not bogus',
  fires('route-not-a-route', { screens: [screen('undefined-state')] }), false);
check('ordinary ids are not bogus',
  fires('route-not-a-route', { screens: [screen('home'), screen('product-detail')] }), false);

// --- action-throws -------------------------------------------------------------
// Worse than a dead control: a dead button does nothing, a throwing button takes
// the screen down. It used to reach the pipeline only as an anonymous
// console-error carrying a stack into a bundled file, so the repair planner had
// to infer both which control and which line.
const THROWN = [{ label: 'カートに追加', error: "TypeError: Cannot read properties of undefined (reading 'params')" }];
check('a control that throws when pressed', fires('action-throws', { throwing: THROWN }), true);
check('the control is named in the instruction',
  auditRuntime({ ...CLEAN, throwing: THROWN }).find((d) => d.id === 'action-throws').instruction.includes('カートに追加'),
  true);
check('and so is what it threw',
  auditRuntime({ ...CLEAN, throwing: THROWN }).find((d) => d.id === 'action-throws').instruction.includes('reading'),
  true);
check('no throwing control, no defect', fires('action-throws', { throwing: [] }), false);

// --- text-over-image -----------------------------------------------------------
// Reported apart from contrast-low because the remedy is different: stock images
// are assigned after the CSS is written, so no fixed-opacity scrim can promise
// a ratio. Measured: white heading over rgba(0,0,0,.3) at 1.1:1.
const OVER = { text: '毎日着たくなる、上質なアパレル', fg: '#fff', bg: 'rgba(0,0,0,.3)', ratio: 1.1, required: 4.5, overImage: true };
const PLAIN = { text: '送料無料', fg: '#999', bg: '#fff', ratio: 2.8, required: 4.5, overImage: false };
check('text over a photograph', fires('text-over-image', { contrast: [OVER] }), true);
check('the text is quoted back',
  auditRuntime({ ...CLEAN, contrast: [OVER] }).find((d) => d.id === 'text-over-image').instruction.includes('上質なアパレル'),
  true);
// The two are separate findings with separate remedies, and a run can have both.
check('plain low contrast is reported as contrast-low',
  fires('contrast-low', { contrast: [PLAIN] }), true);
check('and is not reported as text-over-image',
  fires('text-over-image', { contrast: [PLAIN] }), false);
check('text over an image is not also reported as contrast-low',
  fires('contrast-low', { contrast: [OVER] }), false);
check('a run can carry both', 
  ['contrast-low', 'text-over-image'].every((id) => fires(id, { contrast: [OVER, PLAIN] })), true);

// --- a regression check that reported a change when nothing changed -------------
//
// `unreachable-introduced` built "was reachable" from every screen the walk
// MEASURED — which includes the ones it opened by visiting their route after
// clicking failed to find them — and compared it against an `unreachable` list
// decided by clicking alone. A screen only ever reached by the fallback sat in
// both sets and read as lost, on every comparison, for ever.
//
// It is the marker that fired most: thirteen of twenty-two breaking verdicts,
// and both salvage retries in the v204 round — where the retry had kept exactly
// the `illustrations/` files the run then shipped without. Repairs were thrown
// away on a finding that could not be false.
const scr = (id, reachable) => ({ id, fill: 1, emptyBoxes: [], reachable, broken: [] });
const facts = (over = {}) => ({
  screens: [], deadNav: [], deadActions: [], throwing: [], consoleErrors: [],
  screenshot: '', unreachable: [], contrast: [], smallFields: [], mobile: null,
  truncated: false, ...over,
});

// Exactly what the v204 Vue walk measured: three screens, one of them clicked.
const asMeasured = facts({
  screens: [scr('dashboard', true), scr('category', false), scr('product', false)],
  unreachable: ['category', 'product'],
});
check('a document compared with itself has not regressed',
  runtimeRegressions(asMeasured, JSON.parse(JSON.stringify(asMeasured))).map((d) => d.id), []);

// A screen that really was clickable and is not any more is the finding this
// exists for, and it still fires.
const wasClickable = facts({
  screens: [scr('dashboard', true), scr('category', true)],
  unreachable: [],
});
const nowNot = facts({
  screens: [scr('dashboard', true), scr('category', false)],
  unreachable: ['category'],
});
check('a screen that lost its only entry is reported',
  runtimeRegressions(wasClickable, nowNot).map((d) => d.id), ['unreachable-introduced']);
check('and it names the screen',
  /category/.test(runtimeRegressions(wasClickable, nowNot)[0].instruction), true);

// A screen the repair added with no way in is still reported.
const added = facts({
  screens: [scr('dashboard', true), scr('reports', false)],
  unreachable: ['reports'],
});
check('a newly added screen with no entry is reported',
  runtimeRegressions(wasClickable, added).map((d) => d.id), ['unreachable-introduced']);

// Nothing changed, so nothing regressed — asserted over a facts object with
// every field populated, not just the one that was wrong.
//
// `unreachable-introduced` failed this property for as long as it existed, and
// it was found by asking the question rather than by reading the code. The other
// six comparisons pass it today; this keeps them honest, and catches the next
// one written the same way.
const RICH = {
  screens: [
    { id: 'dashboard', fill: 1, emptyBoxes: [{ label: 'chart', area: 40000 }], reachable: true, broken: [] },
    { id: 'category', fill: 0.62, emptyBoxes: [], reachable: false, broken: [{ kind: 'spill', px: 9 }] },
    { id: 'product', fill: 0.9, emptyBoxes: [], reachable: false, broken: [] },
  ],
  deadNav: ['ホーム'],
  deadActions: ['エクスポート'],
  throwing: [{ label: '保存', error: 'x is not defined' }],
  consoleErrors: ['TypeError: x is not a function'],
  screenshot: '',
  unreachable: ['category', 'product'],
  contrast: [{ text: '売上', ratio: 3.1, required: 4.5, overImage: false }],
  smallFields: [{ label: 'email', height: 28 }],
  mobile: { overflowBy: 17 },
  truncated: false,
};
check('a rich document compared with itself has not regressed',
  runtimeRegressions(RICH, JSON.parse(JSON.stringify(RICH))).map((d) => d.id), []);

// Where the failing colour is defined, so the instruction can name it.
//
// "Fix the design token rather than overriding the colour individually" was
// standing advice — and on the v205 React result there was no token to fix:
// `#059669` was written into SalesChart.tsx, CategoryChart.tsx,
// RankingTable.tsx and ProductChart.tsx. The instruction forbade the only
// repair the document allowed, and the finding survived three accepted repair
// passes on all three frameworks. Vue and Svelte had it as a token, so the
// advice was right for them and wrong for React: it cannot be written once.
const contrastDoc = (files) =>
  '<!DOCTYPE html><html><body><div id="root"></div>\n' +
  files.map(([p, b]) => `@@@makeui:file ${p}\n${b}\n@@@makeui:endfile\n`).join('') +
  '</body></html>';

const green = (fg, bg) => ({
  screens: [scr('a', true)], deadNav: [], deadActions: [], throwing: [],
  consoleErrors: [], screenshot: '', unreachable: [], smallFields: [],
  mobile: null, truncated: false,
  contrast: [{ text: '前月比', fg, bg, ratio: 3.2, required: 4.5, overImage: false }],
});

const TOKENISED = contrastDoc([
  ['src/styles/tokens.css', ':root { --accent-600: #059669; --bg: #f9fafb; }'],
  ['src/components/ui/Card.tsx', 'export const Card = () => <b style={{ color: "var(--accent-600)" }} />;'],
]);
const tokenised = auditRuntime(green('rgb(5, 150, 105)', 'rgb(249, 250, 251)'), TOKENISED)
  .find((d) => d.id === 'contrast-low');
check('a colour declared as a token is named as one',
  /--accent-600 で定義されています/.test(tokenised.instruction), true);

const HARDCODED = contrastDoc([
  ['src/styles/tokens.css', ':root { --bg: #f9fafb; }'],
  ['src/components/ui/SalesChart.tsx', 'export const SalesChart = () => <path stroke="#059669" />;'],
  ['src/components/ui/RankingTable.tsx', 'export const RankingTable = () => <b style={{ color: "#059669" }} />;'],
]);
const hardcoded = auditRuntime(green('rgb(5, 150, 105)', 'rgb(249, 250, 251)'), HARDCODED)
  .find((d) => d.id === 'contrast-low');
check('a hard-coded colour is named as one, with its files',
  /トークンではなく/.test(hardcoded.instruction)
    && /SalesChart\.tsx/.test(hardcoded.instruction)
    && /RankingTable\.tsx/.test(hardcoded.instruction), true);
// The standing advice would be impossible to follow here, so it must not appear.
check('and it is not told to fix a token that does not exist',
  /で定義されています/.test(hardcoded.instruction), false);

// The side named must be the side the suggestion moves. White text on a green
// button is fixed by darkening the BACKGROUND, and naming the foreground's
// token there sends the repair to a value that is correct.
const INK = contrastDoc([
  ['src/styles/tokens.css', ':root { --neutral-50: #faf9f7; --success: #22c55e; }'],
  ['src/components/ui/Button.tsx', 'export const Button = () => <button />;'],
]);
const ink = auditRuntime(green('rgb(250, 249, 247)', 'rgb(34, 197, 94)'), INK)
  .find((d) => d.id === 'contrast-low');
check('the background token is named when the background is what moves',
  /--success で定義されています/.test(ink.instruction), true);
check('and the foreground token is not', /--neutral-50/.test(ink.instruction), false);

// No document, no claim about where anything is defined.
check('without the source it says nothing about definitions',
  /定義されています|トークンではなく/.test(
    auditRuntime(green('rgb(5, 150, 105)', 'rgb(249, 250, 251)'))
      .find((d) => d.id === 'contrast-low').instruction
  ), false);

// --- a screen reached only at the end of a flow ---------------------------------------------
// The walk clicks; it does not fill forms or press keys. 予約確認 after a submitted form and
// 結果 after arrow-keying to the last card were both reported unreachable on 2026-09-14, and
// each sent a repair pass that could not change what the walk does.
{
  const project = (files) => '<!DOCTYPE html><html><body>\n' + Object.entries(files)
    .map(([p, b]) => `@@@makeui:file ${p}\n${b}\n@@@makeui:endfile`).join('\n') + '\n</body></html>';
  const three = { screens: [screen('decks'), screen('study'), screen('edit')], unreachable: ['result'] };
  const routes = "export type ScreenId = 'decks' | 'study' | 'result' | 'edit';\nexport const NAV_ITEMS = [{ id: 'result', label: '結果' }];";
  const has = (src) => auditRuntime({ ...CLEAN, ...three }, src).some((d) => d.id === 'screen-unreachable');
  check('a screen the code navigates to at the end of a flow is not sent to repair',
    has(project({ 'src/routes.ts': routes, 'src/screens/StudyScreen.tsx': "const finish = () => { navigate({ screen: 'result' }); };" })), false);
  check('a screen nothing navigates to is still reported',
    has(project({ 'src/routes.ts': routes, 'src/screens/StudyScreen.tsx': "const finish = () => { navigate({ screen: 'decks' }); };" })), true);
  // The route table and the nav list declare a screen; they do not go there.
  check('the id in routes.ts alone does not count as navigation', has(project({ 'src/routes.ts': routes })), true);
  check('without a source the check is as it was', has(''), true);
  check('a string call counts', has(project({ 'src/routes.ts': routes, 'src/App.tsx': "setScreen('result')" })), false);
  check('a hash assignment counts', has(project({ 'src/routes.ts': routes, 'src/App.tsx': "window.location.hash = '#/result'" })), false);
  check('another screen with a longer id does not count', has(project({ 'src/routes.ts': routes, 'src/App.tsx': "navigate('result-detail')" })), true);
}

// --- screen-hidden --------------------------------------------------------------------
// Found on the carbon run of 2026-09-14: `.screen { display: none }` unless `.is-active`,
// no screen got the class, and a full-height side nav made every screen measure fill 1.0.
{
  const hiddenScreen = { ...screen('dashboard'), fill: 0, hiddenBy: 'div.screen { display: none }' };
  const found = auditRuntime({ ...CLEAN, screens: [hiddenScreen, screen('list')] });
  const d = found.find((x) => x.id === 'screen-hidden');
  check('a screen hidden by CSS is reported', Boolean(d), true);
  check('naming the rule that hid it', d?.instruction.includes('dashboard（div.screen { display: none }）'), true);
  check('and asking to show it, not to add content', /表示される状態に直してください/.test(d?.instruction ?? '') && /中身を足したり作り直したりする必要はありません/.test(d?.instruction ?? ''), true);
  check('it is not also reported as thin, whose repair adds content', found.some((x) => x.id === 'screen-thin'), false);
  const empty = auditRuntime({ ...CLEAN, screens: [{ ...screen('home'), fill: 0, hiddenBy: 'empty' }] }).find((x) => x.id === 'screen-hidden');
  check('an empty content region is reported without a rule', empty?.instruction.includes('home（中身が空）'), true);
  check('a short screen is still thin, not hidden', fires('screen-thin', { screens: [{ ...screen('home'), fill: 0.3 }] }) && !fires('screen-hidden', { screens: [{ ...screen('home'), fill: 0.3 }] }), true);
}

// --- styling that never arrived ---------------------------------------------------------
{
  const nav = auditRuntime({ ...CLEAN, unstyledNav: ['nav.da-nav'] }).find((x) => x.id === 'nav-unstyled');
  check('a navigation in browser bullets is reported, naming the element', nav?.instruction.includes('nav.da-nav'), true);
  check('with the likely cause and what to define', /定義されていない/.test(nav?.instruction ?? '') && /list-style: none/.test(nav?.instruction ?? ''), true);
  const icon = auditRuntime({ ...CLEAN, oversizedIcons: ['div.empty > svg 368x368px'] }).find((x) => x.id === 'icon-oversized');
  check('an oversized icon is reported with its size', icon?.instruction.includes('svg 368x368px'), true);
  check('neither fires on a clean run', ['nav-unstyled', 'icon-oversized'].filter((id) => fires(id, {})), []);
  check('nor when the walk predates the fields', auditRuntime(CLEAN).some((x) => x.id === 'nav-unstyled' || x.id === 'icon-oversized'), false);
}

// --- nav-unstyled names what is undefined, where ---------------------------------------------------
// The carbon run of 2026-09-14: `.breadcrumb` existed; `breadcrumb-list` and `breadcrumb-item` did not.
{
  const fence = (files) => Object.entries(files).map(([p, b]) => `@@@makeui:file ${p}\n${b}\n@@@makeui:endfile`).join('\n');
  const source = fence({
    'src/styles/globals.css': '.breadcrumb { display: flex; }',
    'src/components/ui/Breadcrumb.tsx': 'export default function B() { return <nav className="breadcrumb"><ol className="breadcrumb-list"><li className="breadcrumb-item">x</li></ol></nav> }',
    'src/screens/Other.tsx': 'export default function O() { return <div className="breadcrumb-free card">y</div> }',
  });
  const d = auditRuntime({ ...CLEAN, unstyledNav: ['nav.breadcrumb'] }, source).find((x) => x.id === 'nav-unstyled');
  check('the component rendering the nav and its undefined classes are named', d?.instruction.includes('src/components/ui/Breadcrumb.tsx（breadcrumb-list, breadcrumb-item）'), true);
  check('and handed to the planner as paths', d?.paths, ['src/styles/globals.css', 'src/components/ui/Breadcrumb.tsx']);
  check('a file that merely shares a prefix is not the component', d?.instruction.includes('Other.tsx'), false);
  const bare = auditRuntime({ ...CLEAN, unstyledNav: ['nav.breadcrumb'] }).find((x) => x.id === 'nav-unstyled');
  check('without a source the general instruction stands', [/定義されていないことがほとんど/.test(bare?.instruction ?? ''), bare?.paths], [true, undefined]);
  const hidden = auditRuntime({ ...CLEAN, screens: [{ ...screen('dashboard'), fill: 0, hiddenBy: 'div.screen { display: none }' }] }).find((x) => x.id === 'screen-hidden');
  check('screen-hidden carries a short note for the reply', hidden?.note, '画面の中身が表示されていません（dashboard）。');
}

// --- wiring: the edit path and the stored facts ----------------------------------------------------
{
  const fs = await import('node:fs');
  const meta = fs.readFileSync(path.join(root, 'src/orchestration/meta-orchestrator.ts'), 'utf8');
  check('an edit audits the render with the bound preset', /auditRuntime\(nowFacts, modifiedHtml, preset\)/.test(meta) && /auditRuntime\(wasFacts, html, preset\)/.test(meta), true);
  check('and keeps report-only findings out of the edit repair', /const newly = found\.filter\(\(d\) => repairable\(d\.id\)\)/.test(meta) && /!runtimeBaseline!\.has\(d\.id\) && repairable\(d\.id\)/.test(meta), true);
  const graph = fs.readFileSync(path.join(root, 'src/orchestration/graph.ts'), 'utf8');
  check('a run keeps what hid a screen, the shell and the styling symptoms',
    /\.\.\.\(x\.hiddenBy \? \{ hiddenBy: x\.hiddenBy \} : \{\}\)/.test(graph) && /layout: scoredFacts\.layout/.test(graph) && /unstyledNav: scoredFacts\.unstyledNav/.test(graph) && /oversizedIcons: scoredFacts\.oversizedIcons/.test(graph), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
