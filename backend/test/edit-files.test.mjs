// Tests for applying a change instruction to a React project file by file.
//
// The thing under test is not "did the model answer". It is the set of decisions
// this module makes *instead of* asking the model: that a new screen drags its
// routing with it, that one bad file does not discard the good ones, that a stub
// is not a file, and that the document is re-checked after splicing rather than
// before. Each of those exists because the alternative shipped a change that
// looked applied and was not.
//
//   node test/edit-files.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/orchestration/edit-files.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/ef.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'inherit', cwd: root }
);
const { planFileEdits, applyFileEdits, locateQuotedText } = await import(
  pathToFileURL(path.join(root, 'dist/ef.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const block = (p, body) => `<script type="text/jsx" data-file="${p}">${body}</script>`;

const APP = `export default function App(): JSX.Element {
  const { route } = useNavigation();
  return <div className="shell">{route.screen === 'list' ? <ListScreen /> : <DetailScreen />}</div>;
}`;
const ROUTES = `export type ScreenId = 'list' | 'detail';
export interface NavItem { id: ScreenId; label: string }
export const NAV_ITEMS: NavItem[] = [{ id: 'list', label: '一覧' }, { id: 'detail', label: '詳細' }];`;
const LIST = `export default function ListScreen(): JSX.Element {
  const [q, setQ] = useState<string>('');
  return <section className="screen"><input value={q} onChange={(e) => setQ(e.target.value)} /></section>;
}`;

const PROJECT = `<!DOCTYPE html><html><body><div id="root"></div>
${block('src/main.tsx', `import App from './App';\nApp;`)}
${block('src/App.tsx', APP)}
${block('src/routes.ts', ROUTES)}
${block('src/screens/ListScreen.tsx', LIST)}
${block('src/screens/DetailScreen.tsx', `export default function DetailScreen(): JSX.Element { return <section>d</section>; }`)}
<style data-file="src/styles/globals.css">:root{--accent:#0b6}</style>
</body></html>`;

/** An invoke that answers the planner with `plan` and every file call from `bodies`. */
const stub = (plan, bodies = {}) => {
  const seen = [];
  const fn = async (system, user) => {
    if (/You plan a change/.test(system)) return typeof plan === 'string' ? plan : JSON.stringify(plan);
    const m = /YOUR FILE: (\S+)/.exec(user);
    const p = m ? m[1] : '';
    // `system` too: which reply form was asked for is a decision this module
    // makes, and it is only visible there.
    seen.push({ path: p, user, system });
    const body = bodies[p];
    if (body instanceof Error) throw body;
    return body ?? '';
  };
  fn.seen = seen;
  return fn;
};

/**
 * A planner that answers once per call, from a script.
 *
 * The retry has to be observed rather than inferred: what it costs is one more
 * call and what it saves is a 77,000-token rewrite, so "did it ask twice" is the
 * whole question.
 */
const scriptedPlanner = (replies) => {
  const asked = [];
  const fn = async (system, user) => {
    if (!/You plan a change/.test(system)) return '';
    asked.push(user);
    const next = replies[asked.length - 1];
    if (next instanceof Error) throw next;
    return typeof next === 'string' ? next : JSON.stringify(next ?? {});
  };
  fn.asked = asked;
  return fn;
};

// --- planning -------------------------------------------------------------
let plans = await planFileEdits(PROJECT, '一覧の検索を消して', '', stub({
  files: [{ path: 'src/screens/ListScreen.tsx', reason: 'holds the search field' }],
}));
check('a named file becomes a plan', plans.map((p) => p.path), ['src/screens/ListScreen.tsx']);
check('an existing file is not marked new', plans[0].create, false);
check('the reason travels with it', plans[0].reason, 'holds the search field');

// The planner sees the routing file, because what screens exist is the thing it
// is most often wrong about.
const planner = stub({ files: [{ path: 'src/routes.ts' }] });
await planFileEdits(PROJECT, 'x', '', async (system, user) => {
  if (/You plan a change/.test(system)) {
    check('the planner is shown the routing file', /NAV_ITEMS/.test(user), true);
    check('and not the body of a screen', /setQ/.test(user), false);
  }
  return JSON.stringify({ files: [] });
});

check('no JSON means no plan', (await planFileEdits(PROJECT, 'x', '', stub('sorry, I cannot'))).length, 0);
check('an empty list means no plan', (await planFileEdits(PROJECT, 'x', '', stub({ files: [] }))).length, 0);
check('a path outside the tree is dropped',
  (await planFileEdits(PROJECT, 'x', '', stub({ files: [{ path: '../../etc/passwd' }, { path: '/tmp/a.tsx' }] }))).length, 0);
check('a duplicate path appears once',
  (await planFileEdits(PROJECT, 'x', '', stub({ files: [{ path: 'src/routes.ts' }, { path: 'src/routes.ts' }] }))).length, 1);

// --- where the quoted text lives ------------------------------------------
/*
 * The planner sees the file PATHS and the routing files, and nothing else. So
 * 「一部の画面の上部に「I need to create ~」などの無関係な文言が表示されています」 asks
 * it which file contains a string, from a list of filenames. It cannot know, and
 * one planner reply in the log says so outright: 「I cannot fix this issue
 * because you have not provided the content of」.
 *
 * A decline is not a decline — the caller falls back to rewriting the whole
 * document, about twenty-five times the cost and the path an instruction most
 * often comes back half-applied from. Seven of twenty-six edits in thirty days
 * took it.
 *
 * Which file contains a string is not a judgement, and the repair loop settled
 * this already: `interaction-audit` attaches grep results to a defect and the
 * repair planner is skipped for those. Same technique, other side of the
 * product.
 */
const FILES = new Map([
  ['src/screens/ListScreen.tsx', 'const junk = "I need to create a list"; export default function L(){}'],
  ['src/screens/DetailScreen.tsx', 'export default function D(){ return <b>詳細</b> }'],
  ['src/routes.ts', 'export const NAV_ITEMS = []'],
]);
check('a Japanese-quoted string is located',
  locateQuotedText(FILES, 'ヘッダーの「I need to create」を消してください').map((h) => h.path),
  ['src/screens/ListScreen.tsx']);
check('and a double-quoted one', locateQuotedText(FILES, 'remove the "I need to create a list" text').map((h) => h.path),
  ['src/screens/ListScreen.tsx']);
check('text nothing contains locates nothing',
  locateQuotedText(FILES, '「まったく存在しない文言」を消して'), []);
check('an instruction with no quotes locates nothing',
  locateQuotedText(FILES, 'ヘッダーを作り直して'), []);
/*
 * 「×」 is a real instruction — 「埋まっている枠は×で示す」 — and a one-character
 * search names every file, which is the same as naming none.
 */
check('a one-character quote is not a search', locateQuotedText(FILES, '空き枠を「×」で示して'), []);
// Backticks are out: that is how people write code in prose, and a search for
// `export default` names every screen.
check('a backticked identifier is not a search',
  locateQuotedText(FILES, '`export default` を直して'), []);

// The planner is told, and still decides — a file containing the words is not
// always the file to change.
await planFileEdits(PROJECT, 'ヘッダーの「setQ」を消して', '', async (system, user) => {
  if (/You plan a change/.test(system)) {
    check('the planner is told where the quoted text is',
      /THESE FILES CONTAIN THE TEXT/.test(user) && /ListScreen\.tsx/.test(user), true);
  }
  return JSON.stringify({ files: [{ path: 'src/screens/ListScreen.tsx' }] });
});

/*
 * And when the planner gives up anyway, the grep result is used rather than a
 * whole-document rewrite. This is the seven-in-twenty-six case.
 */
let located = await planFileEdits(PROJECT, '「setQ」という文言を消して', '', stub({ files: [] }));
check('a planner that names nothing falls back to the grep',
  located.map((p) => p.path), ['src/screens/ListScreen.tsx']);
check('and the reason says why that file', /setQ/.test(located[0].reason), true);
// Only when there is something to fall back TO. Without a located file this must
// still decline, so the caller can take the rewrite it has always taken.
check('with nothing located it still declines',
  (await planFileEdits(PROJECT, '全体をもっと良くして', '', stub({ files: [] }))).length, 0);

// The decision this module makes instead of asking for it. A planner that names
// only the screen file produces a screen nothing routes to — which compiles,
// ships, and is reported as done.
plans = await planFileEdits(PROJECT, 'レポート画面を追加して', '', stub({
  files: [{ path: 'src/screens/ReportScreen.tsx', reason: 'new screen' }],
}));
check('a new screen is marked new', plans.find((p) => p.path === 'src/screens/ReportScreen.tsx')?.create, true);
check('and pulls in the routing files',
  plans.map((p) => p.path).sort(),
  ['src/App.tsx', 'src/routes.ts', 'src/screens/ReportScreen.tsx']);
check('the routing files are marked as implied',
  plans.filter((p) => p.implied).map((p) => p.path).sort(), ['src/App.tsx', 'src/routes.ts']);
check('the implied reason names the screen',
  /ReportScreen/.test(plans.find((p) => p.path === 'src/routes.ts').reason), true);

// A planner that already listed them must not get them twice, or listed as implied.
plans = await planFileEdits(PROJECT, 'レポート画面を追加して', '', stub({
  files: [{ path: 'src/screens/ReportScreen.tsx' }, { path: 'src/routes.ts', reason: 'mine' }, { path: 'src/App.tsx' }],
}));
check('an explicitly named routing file is not duplicated', plans.length, 3);
check('and keeps the planner reason', plans.find((p) => p.path === 'src/routes.ts').reason, 'mine');

// Editing a screen without creating one must not drag routing in.
plans = await planFileEdits(PROJECT, '検索を消して', '', stub({ files: [{ path: 'src/screens/ListScreen.tsx' }] }));
check('editing a screen leaves routing alone', plans.length, 1);

// --- the control the user said they would press ---------------------------
// The reported failure. 「お問い合わせのリンクを押したときに表示されるお問い合わせ
// ページを作成してください」 produced the screen, the route and the App branch —
// all correct — and left `<a href="#">お問い合わせ</a>` in the footer untouched,
// so the one thing the user described doing still did nothing.
const WITH_FOOTER = PROJECT.replace(
  '<style data-file="src/styles/globals.css">',
  block('src/components/Footer.tsx', `export default function Footer(): JSX.Element {
  return <footer><a href="#">会社概要</a><a href="#">お問い合わせ</a></footer>;
}`) + '\n<style data-file="src/styles/globals.css">'
);

plans = await planFileEdits(WITH_FOOTER, 'お問い合わせのリンクを押したときに表示されるお問い合わせページを作成してください。', '',
  stub({ files: [{ path: 'src/screens/ContactScreen.tsx', reason: 'new screen' }] }));
check('the file holding the dead link is pulled in',
  plans.map((p) => p.path).sort(),
  ['src/App.tsx', 'src/components/Footer.tsx', 'src/routes.ts', 'src/screens/ContactScreen.tsx']);
const footerPlan = plans.find((p) => p.path === 'src/components/Footer.tsx');
check('and is told which link to wire', /「お問い合わせ」/.test(footerPlan.reason), true);
check('and told to leave the rest alone', /do not touch the other links/.test(footerPlan.reason), true);
// Measured: Footer.tsx came back importing `../hooks/useNavigate`, a file this
// project has never had — the model reached for React Router. The gate reverted
// it, so nothing broke and nothing happened. Quoting the project's own code is a
// better instruction than describing it.
check('and shown how this project actually navigates, quoted from itself',
  /useNavigation\(\)/.test(footerPlan.reason), true);
check('and told not to invent one', /useNavigate を持ち込まない/.test(footerPlan.reason), true);

// With a hooks directory the file is named outright, which is the shape real
// generated projects have.
const WITH_HOOKS = WITH_FOOTER.replace(
  '<style data-file="src/styles/globals.css">',
  block('src/hooks/useNavigate2.ts', 'export function useNavigate2(){ return null; }') +
    '\n<style data-file="src/styles/globals.css">'
);
const hooked = await planFileEdits(WITH_HOOKS, 'お問い合わせのリンクから開くお問い合わせページを作成してください', '',
  stub({ files: [{ path: 'src/screens/ContactScreen.tsx' }] }));
check('the navigation files are named outright',
  /src\/hooks\/useNavigate2\.ts/.test(hooked.find((p) => p.path === 'src/components/Footer.tsx').reason), true);
// Not implied: if the footer will not rewrite, the screen is still worth having.
check('it does not take the screen down with it if it fails', Boolean(footerPlan.implied), false);

// A label the instruction never mentions is not the entry point.
plans = await planFileEdits(WITH_FOOTER, '設定画面を追加してください', '',
  stub({ files: [{ path: 'src/screens/SettingsScreen.tsx' }] }));
check('an unrelated dead link is left alone',
  plans.some((p) => p.path === 'src/components/Footer.tsx'), false);

// And an edit that adds no screen never drags the shell in.
plans = await planFileEdits(WITH_FOOTER, 'お問い合わせの文言を直して', '',
  stub({ files: [{ path: 'src/components/Footer.tsx' }] }));
check('an edit with no new screen plans only what was named',
  plans.map((p) => p.path), ['src/components/Footer.tsx']);

// --- applying -------------------------------------------------------------
const NEW_LIST = `export default function ListScreen(): JSX.Element {
  return <section className="screen"><ul><li>row</li></ul></section>;
}`;

let r = await applyFileEdits(PROJECT, [{ path: 'src/screens/ListScreen.tsx', reason: '', create: false }],
  '検索を消して', '', stub(null, { 'src/screens/ListScreen.tsx': NEW_LIST }));
check('the file is written', r.written, ['src/screens/ListScreen.tsx']);
check('the new body is in the document', r.html.includes('<li>row</li>'), true);
check('the old body is gone', r.html.includes('setQ'), false);
check('the data-file attribute survives', r.html.includes('data-file="src/screens/ListScreen.tsx"'), true);
check('other files are untouched', r.html.includes(ROUTES), true);

// The file call must carry the instruction and the file, and must not be handed
// the whole project to rewrite.
const one = stub(null, { 'src/screens/ListScreen.tsx': NEW_LIST });
await applyFileEdits(PROJECT, [{ path: 'src/screens/ListScreen.tsx', reason: 'holds it', create: false }],
  '検索を消して', 'CONTRACT: no search field', one);
check('the edit call carries the instruction', /検索を消して/.test(one.seen[0].user), true);
check('and the current contents', /setQ/.test(one.seen[0].user), true);
check('and the build contract', /CONTRACT: no search field/.test(one.seen[0].user), true);
check('and not another screen body', /DetailScreen/.test(one.seen[0].user), false);

// A new file is created rather than dropped, and is shown a sibling to copy.
const made = stub(null, {
  'src/screens/ReportScreen.tsx': `export default function ReportScreen(): JSX.Element { return <section className="screen">r</section>; }`,
});
r = await applyFileEdits(PROJECT, [{ path: 'src/screens/ReportScreen.tsx', reason: 'new', create: true }],
  'レポート画面', '', made);
check('a new file is written', r.written, ['src/screens/ReportScreen.tsx']);
check('as its own project file', r.html.includes('data-file="src/screens/ReportScreen.tsx"'), true);
check('the new-file call gets a style reference', /an existing file/.test(made.seen[0].user), true);
check('and the project file list', /- src\/routes\.ts/.test(made.seen[0].user), true);

// --- independence and the guards -----------------------------------------
// One broken response must not discard the good ones. This is the whole reason
// the work is split per file.
r = await applyFileEdits(PROJECT, [
  { path: 'src/screens/ListScreen.tsx', reason: '', create: false },
  { path: 'src/screens/DetailScreen.tsx', reason: '', create: false },
], 'x', '', stub(null, {
  'src/screens/ListScreen.tsx': NEW_LIST,
  'src/screens/DetailScreen.tsx': 'export default function D( { return <b/>; }',
}));
check('a broken file is skipped', r.skipped, ['src/screens/DetailScreen.tsx']);
check('and the good one still lands', r.written, ['src/screens/ListScreen.tsx']);
check('the broken body never reaches the document', r.html.includes('export default function D( {'), false);

// A model that throws on one file is the same case.
r = await applyFileEdits(PROJECT, [
  { path: 'src/screens/ListScreen.tsx', reason: '', create: false },
  { path: 'src/screens/DetailScreen.tsx', reason: '', create: false },
], 'x', '', stub(null, {
  'src/screens/ListScreen.tsx': NEW_LIST,
  'src/screens/DetailScreen.tsx': new Error('throttled'),
}));
check('a failed call is skipped, not fatal', r.written, ['src/screens/ListScreen.tsx']);

// A stub in place of a file.
r = await applyFileEdits(PROJECT, [{ path: 'src/screens/ListScreen.tsx', reason: '', create: false }],
  'x', '', stub(null, { 'src/screens/ListScreen.tsx': 'export {};' }));
check('a stub response is rejected', r.written, []);
check('and the document is unchanged', r.html, PROJECT);

// But a genuine shrink is allowed — "remove the filters" makes files smaller.
const SHRUNK = `export default function ListScreen(): JSX.Element {
  return <section className="screen"><ul><li>a</li></ul></section>;
}`;
r = await applyFileEdits(PROJECT, [{ path: 'src/screens/ListScreen.tsx', reason: '', create: false }],
  'x', '', stub(null, { 'src/screens/ListScreen.tsx': SHRUNK }));
check('a smaller but real file is accepted', r.written, ['src/screens/ListScreen.tsx']);

// CSS has no parser gate, and must not be held to one.
r = await applyFileEdits(PROJECT, [{ path: 'src/styles/globals.css', reason: '', create: false }],
  'x', '', stub(null, { 'src/styles/globals.css': ':root{--accent:#0b6}\n.screen{padding:24px}\n.shell{display:flex}' }));
check('a stylesheet is written', r.written, ['src/styles/globals.css']);
check('into its own style block', /data-file="src\/styles\/globals\.css">[\s\S]*padding:24px/.test(r.html), true);

// --- the routing safety net, at apply time --------------------------------
// A new screen whose routing edit did not come back is worse than no change:
// an unreachable screen reported as success.
r = await applyFileEdits(PROJECT, [
  { path: 'src/screens/ReportScreen.tsx', reason: '', create: true },
  { path: 'src/routes.ts', reason: '', create: false, implied: true },
  { path: 'src/App.tsx', reason: '', create: false, implied: true },
], 'レポート画面', '', stub(null, {
  'src/screens/ReportScreen.tsx': `export default function ReportScreen(): JSX.Element { return <section>r</section>; }`,
  // Long enough to clear the stub guard, so this exercises the parser gate.
  'src/routes.ts': ROUTES.replace("'list' | 'detail'", "'list' | 'detail' | ;") + '\n// padding to keep it full length\n',
  'src/App.tsx': APP.replace("<DetailScreen />", "route.screen === 'report' ? <ReportScreen /> : <DetailScreen />"),
}));
check('the unroutable new screen is dropped', r.written.includes('src/screens/ReportScreen.tsx'), false);
check('and does not reach the document', r.html.includes('ReportScreen.tsx"'), false);
check('the screen file is reported as skipped', r.skipped.includes('src/screens/ReportScreen.tsx'), true);

// When the routing edit does come back, the screen lands with it.
r = await applyFileEdits(PROJECT, [
  { path: 'src/screens/ReportScreen.tsx', reason: '', create: true },
  { path: 'src/routes.ts', reason: '', create: false, implied: true },
], 'レポート画面', '', stub(null, {
  'src/screens/ReportScreen.tsx': `export default function ReportScreen(): JSX.Element { return <section>r</section>; }`,
  'src/routes.ts': ROUTES.replace("'list' | 'detail'", "'list' | 'detail' | 'report'"),
}));
check('a routed new screen is kept', r.written.sort(), ['src/routes.ts', 'src/screens/ReportScreen.tsx']);
check('and the union grew', r.html.includes("'list' | 'detail' | 'report'"), true);

/*
 * The converse, measured on a real edit: ContactScreen failed to parse twice, and
 * routes.ts and the footer link landed anyway — so the link the user pressed
 * navigated to a route that rendered nothing. Everything those files exist for
 * is the screen. Half an edit is not a smaller edit.
 *
 * The answer used to be to drop the whole change, which these four checks
 * asserted. That was right until there was a third option: the outcome it
 * produced was 「お問い合わせページを作成してください」 changing nothing at all and
 * reporting success — no screen, no route, and no sign anything went wrong.
 *
 * A new screen that will not come back is scaffolded now — a heading and a line
 * in the project's own framework — so the route resolves and the rest of the
 * change survives. The guarantee these checks were protecting is unchanged and
 * is asserted below in its new form: nothing may reference a file that is not
 * there. What changed is which of the two ways of satisfying it is taken.
 */
r = await applyFileEdits(WITH_FOOTER, [
  { path: 'src/screens/ContactScreen.tsx', reason: '', create: true },
  { path: 'src/routes.ts', reason: '', create: false, implied: true, servesNewScreen: true },
  { path: 'src/components/Footer.tsx', reason: '', create: false, servesNewScreen: true },
], 'お問い合わせページ', '', stub(null, {
  'src/screens/ContactScreen.tsx': 'export default function C(): JSX.Element { return <div ;;; />; }',
  'src/routes.ts': ROUTES.replace("'list' | 'detail'", "'list' | 'detail' | 'contact'"),
  'src/components/Footer.tsx': `export default function Footer(): JSX.Element {
  return <footer><a href="#">会社概要</a><a href="#/contact">お問い合わせ</a></footer>;
}`,
}));
check('the screen exists rather than the change being lost', r.written.includes('src/screens/ContactScreen.tsx'), true);
check('so the route may describe it', r.html.includes("| 'contact'"), true);
check('and the footer link goes somewhere', r.html.includes('href="#/contact"'), true);
check('the original footer survives', r.html.includes('会社概要'), true);
// The scaffold, not the unparseable body the model returned.
check('the scaffold replaced the broken file', r.html.includes('<div ;;; />'), false);
check('and it is a screen, not a diagnostic', r.html.includes('この画面はまだ内容がありません'), true);

// When the screen does land, everything that serves it lands with it.
r = await applyFileEdits(WITH_FOOTER, [
  { path: 'src/screens/ContactScreen.tsx', reason: '', create: true },
  { path: 'src/routes.ts', reason: '', create: false, implied: true, servesNewScreen: true },
  { path: 'src/components/Footer.tsx', reason: '', create: false, servesNewScreen: true },
], 'お問い合わせページ', '', stub(null, {
  'src/screens/ContactScreen.tsx':
    'export default function ContactScreen(): JSX.Element { return <form><input name="email" /></form>; }',
  'src/routes.ts': ROUTES.replace("'list' | 'detail'", "'list' | 'detail' | 'contact'"),
  'src/components/Footer.tsx': `export default function Footer(): JSX.Element {
  return <footer><a href="#">会社概要</a><a href="#/contact">お問い合わせ</a></footer>;
}`,
}));
check('the whole change lands together', r.written.length, 3);
check('and the link now goes somewhere', r.html.includes('href="#/contact"'), true);

// An edit that touches no screen is not subject to the net at all.
r = await applyFileEdits(PROJECT, [{ path: 'src/routes.ts', reason: '', create: false, implied: true }],
  'x', '', stub(null, { 'src/routes.ts': ROUTES.replace("'list' | 'detail'", "'list' | 'detail' | ;") + '\n// padding\n' }));
check('a broken routing edit alone just fails', r.written, []);
check('and nothing is dropped for it', r.skipped, ['src/routes.ts']);

// --- imports that do not resolve ------------------------------------------
// An edit that adds a component adds an import of it. If the component's own
// file did not come back, the importing file is valid TypeScript that throws on
// its first require — and takes the whole application down with it, which is a
// far worse outcome than the edit simply not happening.
r = await applyFileEdits(PROJECT, [
  { path: 'src/screens/ListScreen.tsx', reason: '', create: false },
  { path: 'src/components/EmptyState.tsx', reason: '', create: true },
], '空状態を追加', '', stub(null, {
  'src/screens/ListScreen.tsx': `import EmptyState from '../components/EmptyState';
export default function ListScreen(): JSX.Element {
  return <section className="screen"><EmptyState /></section>;
}`,
  'src/components/EmptyState.tsx': 'export default',   // rejected: does not parse
}));
check('the importing file is reverted with the module it wanted', r.written, []);
check('and the document still loads', r.html.includes('setQ'), true);
check('the unresolvable import never lands', r.html.includes('EmptyState'), false);

// Both together is the case that must work.
r = await applyFileEdits(PROJECT, [
  { path: 'src/screens/ListScreen.tsx', reason: '', create: false },
  { path: 'src/components/EmptyState.tsx', reason: '', create: true },
], '空状態を追加', '', stub(null, {
  'src/screens/ListScreen.tsx': `import EmptyState from '../components/EmptyState';
export default function ListScreen(): JSX.Element {
  return <section className="screen"><EmptyState /></section>;
}`,
  'src/components/EmptyState.tsx':
    'export default function EmptyState(): JSX.Element { return <p className="empty">まだありません</p>; }',
}));
check('both land when the new module is written',
  r.written.sort(), ['src/components/EmptyState.tsx', 'src/screens/ListScreen.tsx']);
check('and the import is in the document', r.html.includes("from '../components/EmptyState'"), true);

// --- the production failure, exactly -------------------------------------
// Transcribed from real logs, twice within one hour:
//
//   File edit reverted — broken after splicing  src/screens/ContactScreen.tsx
//   Per-file edit applied  written:["src/routes.ts","src/App.tsx"]  skipped:["ContactScreen.tsx"]
//
// App.tsx shipped importing a screen that had just been dropped. The user saw
// `Module not found: './screens/ContactScreen'` and a blank application, and on
// other runs saw nothing happen at all. The import gate existed — it just ran
// on the document *before* the revert, where the unparseable file was still
// present and the import therefore resolved.
const CONTACT_PLAN = [
  { path: 'src/screens/ContactScreen.tsx', reason: '', create: true },
  { path: 'src/routes.ts', reason: '', create: false, implied: true },
  { path: 'src/App.tsx', reason: '', create: false, implied: true },
];
const APP_WITH_CONTACT = `import ContactScreen from './screens/ContactScreen';
export default function App(): JSX.Element {
  const { route } = useNavigation();
  return <div className="shell">{route.screen === 'contact' ? <ContactScreen /> : <ListScreen />}</div>;
}`;

r = await applyFileEdits(PROJECT, CONTACT_PLAN, 'お問い合わせページを作成してください', '', stub(null, {
  // Unparseable both times, so the retry cannot save it either.
  'src/screens/ContactScreen.tsx': `export default function ContactScreen(): JSX.Element {
  return <form className="contact"><input name="email" ;;; /></form>;
}`,
  'src/routes.ts': ROUTES.replace("'list' | 'detail'", "'list' | 'detail' | 'contact'"),
  'src/App.tsx': APP_WITH_CONTACT,
}));
/*
 * The guarantee is the same and it is met the other way round now: the import
 * resolves because the screen EXISTS, scaffolded, rather than because both were
 * removed. `Module not found` was the fault, and it is still impossible — what
 * changed is that the user gets their route instead of getting nothing.
 */
check('the screen exists, scaffolded',
  r.written.includes('src/screens/ContactScreen.tsx'), true);
check('so App.tsx may keep its import',
  r.written.includes('src/App.tsx'), true);
check('and the import resolves to a file that is there',
  r.html.includes("from './screens/ContactScreen'")
    && r.html.includes('src/screens/ContactScreen.tsx'), true);
check('the unparseable body did not ship', r.html.includes('input name="email" ;;;'), false);

// The same edit when the screen does parse: everything lands.
r = await applyFileEdits(PROJECT, CONTACT_PLAN, 'お問い合わせページを作成してください', '', stub(null, {
  'src/screens/ContactScreen.tsx':
    `export default function ContactScreen(): JSX.Element {
  return <form className="contact"><input name="email" /><button>送信</button></form>;
}`,
  'src/routes.ts': ROUTES.replace("'list' | 'detail'", "'list' | 'detail' | 'contact'"),
  'src/App.tsx': APP_WITH_CONTACT,
}));
check('a screen that parses lands with its routing',
  r.written.sort(), ['src/App.tsx', 'src/routes.ts', 'src/screens/ContactScreen.tsx']);
check('and App.tsx keeps its import', r.html.includes("from './screens/ContactScreen'"), true);

// --- the retry ------------------------------------------------------------
// One retry, carrying the parser's complaint. Not re-sampling the same prompt:
// the second call is given the error and the offending line.
let calls = 0;
const flaky = async (system, user) => {
  if (/You plan a change/.test(system)) return '{}';
  if (!/YOUR FILE: src\/screens\/ContactScreen\.tsx/.test(user)) {
    return user.includes('routes.ts')
      ? ROUTES.replace("'list' | 'detail'", "'list' | 'detail' | 'contact'")
      : APP_WITH_CONTACT;
  }
  calls++;
  return calls === 1
    ? `export default function ContactScreen(): JSX.Element { return <form ;;; />; }`
    : `export default function ContactScreen(): JSX.Element {
  return <form className="contact"><input name="email" /><button>送信</button></form>;
}`;
};
r = await applyFileEdits(PROJECT, CONTACT_PLAN, 'お問い合わせページ', '', flaky);
check('a broken first attempt is retried once', calls, 2);
check('and the corrected file lands', r.written.includes('src/screens/ContactScreen.tsx'), true);
check('with the whole edit intact', r.written.length, 3);

// The retry must carry the error, or it is just the same prompt twice.
let second = '';
await applyFileEdits(PROJECT, [{ path: 'src/screens/ListScreen.tsx', reason: '', create: false }],
  'x', '', async (system, user) => {
    if (/You plan a change/.test(system)) return '{}';
    if (/パースできませんでした/.test(user)) { second = user; return LIST; }
    return 'export default function ListScreen(): JSX.Element { return <div ;;; />; }';
  });
check('the retry names the parser error', /Unexpected token/.test(second), true);
check('and quotes the offending line', /該当行:/.test(second), true);
// It asks for a smaller file rather than the same one repaired. Measured: the
// "fix just this error" framing preserved a 280-line screen with a modal, and
// the second attempt broke in a different place. The failures are all at the
// top of the size range, so the retry changes the size.
check('and asks for a smaller file, not the same one patched',
  /もっと小さく作り直して/.test(second), true);
check('naming the size that failed', /行ありました/.test(second), true);

// --- a project that is not React ------------------------------------------
//
// The whole of this module was written for React and said so: the planner
// prompt opened "You plan a change to a TypeScript React project", the path
// filter admitted (tsx|ts|css|md), and a screen was /\.tsx$/. Handed a Vue
// project it therefore did the worst available thing — it accepted the
// instruction, produced an empty plan, and let the caller fall through to a
// whole-document rewrite that had been told it was holding an HTML page. The
// user saw their Vue project come back as React.
//
// These check the decisions that failed, on the frameworks that were failing.
const fence = (p, body) => `@@@makeui:file ${p}\n${body}\n@@@makeui:endfile\n`;

const VUE_PROJECT = `<!DOCTYPE html><html><body><div id="root"></div>
${fence('src/main.ts', `import { createApp } from 'vue';\nimport App from './App.vue';\ncreateApp(App).mount('#app');`)}
${fence('src/App.vue', `<template><div class="shell"><ListScreen v-if="route.screen === 'list'" /></div></template>
<script setup lang="ts">
import ListScreen from './screens/ListScreen.vue';
const route = { screen: 'list' };
</script>`)}
${fence('src/routes.ts', ROUTES)}
${fence('src/composables/useNavigation.ts', `import { reactive } from 'vue';\nexport function useNavigation() { return reactive({ route: { screen: 'list' } }); }`)}
${fence('src/screens/ListScreen.vue', `<template><section class="screen">一覧</section></template>\n<script setup lang="ts"></script>`)}
${fence('src/styles/globals.css', ':root{--accent:#0b6}')}
</body></html>`;

const vuePlans = await planFileEdits(VUE_PROJECT, 'お問い合わせ画面を追加して', '', stub({
  files: [{ path: 'src/screens/ContactScreen.vue', reason: 'new screen' }],
}));
check('a .vue screen survives the path filter',
  vuePlans.map((p) => p.path).sort(),
  ['src/App.vue', 'src/routes.ts', 'src/screens/ContactScreen.vue']);
check('and App.vue counts as routing, so the new screen is reachable',
  vuePlans.find((p) => p.path === 'src/App.vue')?.implied, true);

const vueStub = stub(
  { files: [{ path: 'src/screens/ListScreen.vue', reason: 'change the heading' }] },
  { 'src/screens/ListScreen.vue': `<template><section class="screen">在庫一覧</section></template>\n<script setup lang="ts"></script>` }
);
const vueApplied = await applyFileEdits(
  VUE_PROJECT,
  await planFileEdits(VUE_PROJECT, '見出しを変えて', '', vueStub),
  '見出しを変えて', '', vueStub
);
check('a .vue file is written back', vueApplied.written, ['src/screens/ListScreen.vue']);
check('and the new body is in the document', vueApplied.html.includes('在庫一覧'), true);
check('the per-file call names Vue, not React',
  /Vue project/.test(vueStub.seen.find((c) => c.path === 'src/screens/ListScreen.vue').system), true);

// --- the reply form: blocks or a whole file ---------------------------------
/*
 * An edit changes a median 4% of the file it touches and has always re-emitted
 * 100% of it. The repair path's measured replies at that change share come to
 * 14% of the file, so the form moves here — above a size floor, because below
 * it the blocks cost more than the file (see patch-reply.ts).
 */
const PADDING = Array.from({ length: 60 }, (_, i) => `  const label${i}: string = '行${i}';`).join('\n');
const BIG_LIST = `export default function ListScreen(): JSX.Element {
${PADDING}
  return <section className="screen"><h1>在庫一覧</h1></section>;
}`;
const BIG_PROJECT = `<!DOCTYPE html><html><body><div id="root"></div>
${block('src/main.tsx', `import App from './App';\nApp;`)}
${block('src/App.tsx', APP)}
${block('src/routes.ts', ROUTES)}
${block('src/screens/ListScreen.tsx', BIG_LIST)}
<style data-file="src/styles/globals.css">:root{--accent:#0b6}</style>
</body></html>`;
check('the fixture is over the floor', BIG_LIST.length >= 2000, true);

const PATCH = `<<<<<<< SEARCH
  return <section className="screen"><h1>在庫一覧</h1></section>;
=======
  return <section className="screen"><h1>商品一覧</h1></section>;
>>>>>>> REPLACE`;

const bigPlan = { files: [{ path: 'src/screens/ListScreen.tsx', reason: '見出しを変える' }] };
let s = stub(bigPlan, { 'src/screens/ListScreen.tsx': PATCH });
r = await applyFileEdits(BIG_PROJECT, await planFileEdits(BIG_PROJECT, '見出しを商品一覧に', '', s),
  '見出しを商品一覧に', '', s);
const fileCall = s.seen.find((c) => c.path === 'src/screens/ListScreen.tsx');
check('a file over the floor is asked for as blocks', /<<<<<<< SEARCH/.test(fileCall.system), true);
check('and not as a whole file', /Return the COMPLETE file/.test(fileCall.system), false);
check('the blocks are applied', r.written, ['src/screens/ListScreen.tsx']);
check('the change is in the document', r.html.includes('商品一覧'), true);
check('and the 60 lines nobody asked about are still there', r.html.includes("const label59: string = '行59';"), true);
check('one call, not two', s.seen.filter((c) => c.path === 'src/screens/ListScreen.tsx').length, 1);

// A whole file is still a legal reply to a block request — the rules say so for
// a change that rewrites most of a file — and it is spliced exactly as before.
s = stub(bigPlan, { 'src/screens/ListScreen.tsx': BIG_LIST.replace('在庫一覧', '商品一覧') });
r = await applyFileEdits(BIG_PROJECT, await planFileEdits(BIG_PROJECT, 'x', '', s), 'x', '', s);
check('a whole file answering a block request is still accepted', r.written, ['src/screens/ListScreen.tsx']);
check('and it is what gets written', r.html.includes('商品一覧'), true);

// A block that matches nothing costs one more call, asking for the file — the
// same recovery the repair path makes. Dropping the file instead would lose the
// user's change over a copying error.
let asked = 0;
const missing = async (system, user) => {
  if (/You plan a change/.test(system)) return JSON.stringify(bigPlan);
  asked += 1;
  return asked === 1
    ? '<<<<<<< SEARCH\n  この行はファイルにない\n=======\n  x\n>>>>>>> REPLACE'
    : BIG_LIST.replace('在庫一覧', '商品一覧');
};
r = await applyFileEdits(BIG_PROJECT, [{ path: 'src/screens/ListScreen.tsx', reason: '', create: false }],
  'x', '', missing);
check('a patch that matches nothing is retried as a whole file', asked, 2);
check('and the edit still lands', r.html.includes('商品一覧'), true);

// Below the floor, and for a file being created, the form does not change.
s = stub({ files: [{ path: 'src/screens/ListScreen.tsx', reason: '' }] },
  { 'src/screens/ListScreen.tsx': LIST.replace('screen', 'screen wide') });
await applyFileEdits(PROJECT, await planFileEdits(PROJECT, 'x', '', s), 'x', '', s);
check('a short file is asked for whole',
  /Return the COMPLETE file/.test(s.seen.find((c) => c.path === 'src/screens/ListScreen.tsx').system), true);

s = stub({ files: [{ path: 'src/screens/ReportScreen.tsx', reason: 'new' }] },
  { 'src/screens/ReportScreen.tsx': 'export default function ReportScreen(): JSX.Element { return <section>r</section>; }' });
await applyFileEdits(BIG_PROJECT,
  [{ path: 'src/screens/ReportScreen.tsx', reason: 'new', create: true }], 'x', '', s);
check('a new file is asked for whole — there is nothing to search',
  /Return the COMPLETE file/.test(s.seen.find((c) => c.path === 'src/screens/ReportScreen.tsx').system), true);

console.log(`
${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
