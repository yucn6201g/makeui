// Building the project one file at a time instead of one document at a time.
//
// The thing under test is not "did the model answer". It is the set of
// decisions this module makes so that a per-file build is safe to prefer over
// the single-call one:
//
//   - paths are COMPOSED from the framework's layout, never taken from the
//     model. The edit planner already paid for the other arrangement: it asked
//     for paths, got `.tsx` in a Vue project, and threw the whole plan away.
//   - the build DECLINES rather than shipping something broken. A missing
//     foundation or a screen that will not parse means the caller falls back to
//     the single-call assembler, which at least produces a coherent whole.
//   - every screen the manifest names is in the finished document, because the
//     shell imports all of them.
//
//   node test/build-files.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/orchestration/build-files.ts')}" --bundle --platform=node --format=esm ` +
    `--loader:.txt=text --outfile="${path.join(root, 'dist/bf.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'inherit', cwd: root }
);
const { buildProjectFiles, planProjectFiles } = await import(
  pathToFileURL(path.join(root, 'dist/bf.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const ctx = (kind = 'react') => ({
  kind,
  spec: [
    '# SCREENS AND INFORMATION ARCHITECTURE',
    '',
    'inventory — 棚ごとの在庫一覧。検索、絞り込み、行クリックで詳細へ。'.repeat(12),
    '',
    'request — 発注申請フォーム。品目、数量、希望納期、備考。送信で申請一覧に追加。'.repeat(12),
    '',
    '# INTERACTION INVENTORY',
    '',
    'inventory の検索欄に入力すると items がフィルタされ、一覧が再描画される。'.repeat(12),
  ].join('\n'),
  prompt: '備品在庫管理',
  presetSpec: '',
  stockBlock: '',
  formControlSizing: 'FORM SIZING RULES',
  projectContract: 'PROJECT CONTRACT',
});

const MANIFEST = {
  screens: [
    { id: 'inventory', name: 'Inventory', role: '在庫一覧' },
    { id: 'request', name: 'Request', role: '発注申請' },
  ],
  components: [{ name: 'StatusBadge', role: '状態バッジ' }],
  data: [{ name: 'items', role: 'モックデータ' }],
  lib: [{ name: 'format', role: '整形' }],
};

const fence = (p, body) => `@@@makeui:file ${p}\n${body}\n@@@makeui:endfile\n`;

const FOUNDATION_REACT =
  fence('src/main.tsx', `import { createRoot } from 'react-dom/client';\nimport App from './App';\ncreateRoot(document.getElementById('root')!).render(<App />);`) +
  fence('src/App.tsx', `import InventoryScreen from './screens/InventoryScreen';\nexport default function App(): JSX.Element { return <InventoryScreen />; }`) +
  fence('src/routes.ts', `export type ScreenId = 'inventory' | 'request';\nexport const NAV_ITEMS = [{ id: 'inventory', label: '在庫' }];`) +
  fence('src/hooks/useNavigation.ts', `export function useNavigation() { return { route: { screen: 'inventory' } }; }`) +
  fence('src/styles/globals.css', `:root{--accent:#0b6bcb}\n.card{border:1px solid #dde3ea}`);

const SCREEN_BODY = `export default function Screen(): JSX.Element {
  return <section className="card">中身</section>;
}`;

/**
 * An invoke that answers each stage in turn: the manifest, the foundation, then
 * one body per file. `bodies` may name a path to override or to break.
 */
const stub = ({ manifest = MANIFEST, foundation = FOUNDATION_REACT, bodies = {}, defaultBody = SCREEN_BODY } = {}) => {
  const seen = [];
  /*
   * The per-file prompt is split now, so `system` is `{ cached, tail? }` rather
   * than a string. `text()` reads either, the way `fullText` does in the product.
   */
  const text = (s) => (typeof s === 'string' ? s : `${s.cached}${s.tail ?? ''}`);
  const fn = async (system, user, maxTokens) => {
    seen.push({ system: text(system), user, maxTokens });
    if (/turn a UI design specification into the file list/.test(text(system))) {
      return typeof manifest === 'string' ? manifest : JSON.stringify(manifest);
    }
    if (/FOUNDATION of a/.test(text(system))) return foundation;
    /*
     * The path comes from the USER message, which is where it is stated.
     *
     * It used to be the first line of the system prompt as well, and that
     * duplicate is what made the prompt uncacheable — Bedrock matches a prefix
     * from byte one, so a path ahead of the invariant contract meant 30 calls
     * wrote the same 4,106-token prefix and read none of it back. This stub read
     * the copy that was removed; it reads the one that was always the contract.
     */
    const m = /^YOUR FILE: (\S+)$/m.exec(user);
    const p = m ? m[1] : '';
    const body = bodies[p];
    if (body instanceof Error) throw body;
    return body ?? defaultBody;
  };
  fn.seen = seen;
  return fn;
};

// --- the manifest becomes paths, not the other way round -------------------
let m = await planProjectFiles(ctx('react'), stub());
check('screen paths are composed for React',
  m.screens.map((f) => f.path),
  ['src/screens/InventoryScreen.tsx', 'src/screens/RequestScreen.tsx']);
check('and the screen id from the specification is carried',
  m.screens.map((f) => f.screenId), ['inventory', 'request']);
check('components, data and helpers get their own directories',
  [m.components[0].path, m.data[0].path, m.lib[0].path],
  ['src/components/ui/StatusBadge.tsx', 'src/data/items.ts', 'src/lib/format.ts']);

m = await planProjectFiles(ctx('vue'), stub());
check('the same manifest becomes .vue paths in a Vue project',
  m.screens.map((f) => f.path),
  ['src/screens/InventoryScreen.vue', 'src/screens/RequestScreen.vue']);
m = await planProjectFiles(ctx('svelte'), stub());
check('and .svelte paths in a Svelte project',
  m.screens.map((f) => f.path),
  ['src/screens/InventoryScreen.svelte', 'src/screens/RequestScreen.svelte']);

// A name the model wrote badly is still turned into a valid identifier rather
// than a path the bundler cannot resolve.
m = await planProjectFiles(ctx('react'), stub({
  manifest: { screens: [{ id: 'stock list', name: 'stock list', role: 'x' }], components: [], data: [], lib: [] },
}));
check('a loose name becomes a valid component file',
  m.screens.map((f) => f.path), ['src/screens/StockListScreen.tsx']);

// --- the assembled document ------------------------------------------------
let built = await buildProjectFiles(ctx('react'), stub());
const paths = built.html ? [...built.html.matchAll(/@@@makeui:file (.+)/g)].map((x) => x[1].trim()) : [];
check('the foundation and every planned file are in the document', paths, [
  'src/main.tsx',
  'src/App.tsx',
  'src/routes.ts',
  'src/hooks/useNavigation.ts',
  'src/styles/globals.css',
  'src/data/items.ts',
  'src/lib/format.ts',
  'src/components/ui/StatusBadge.tsx',
  'src/screens/InventoryScreen.tsx',
  'src/screens/RequestScreen.tsx',
]);
check('and it is a document the rest of the pipeline can read',
  built.html.startsWith('<!DOCTYPE html>') && built.html.trimEnd().endsWith('</html>'), true);

// --- what every per-file call is actually shown ----------------------------
const probe = stub();
await buildProjectFiles(ctx('react'), probe);
const screenCall = probe.seen.find((c) => /YOUR FILE: src\/screens\/RequestScreen\.tsx/.test(c.user));
check('a file call exists for each screen', Boolean(screenCall), true);
// Without the design tokens and the class list, each screen invents its own look
// and the project ends up as twenty first drafts rather than one product.
check('and it carries the design tokens', /--accent:#0b6bcb/.test(screenCall.user), true);
check('and the names of the classes it may use', /[.]card/.test(screenCall.user), true);
// But NOT the declarations. This block travels with every per-file call, so what
// goes in it is multiplied by the file count — measured at 958,000 tokens of code
// assembly on the first real run against 84,000 for the same brief in one call,
// with the stylesheet most of the difference. A screen needs to know which
// classes exist, not what each one does.
check('and not the declarations, which every file would otherwise pay for',
  /border:1px solid #dde3ea/.test(screenCall.user), false);
check('and the route contract', /export type ScreenId/.test(screenCall.user), true);
check('and the list of files it may import', /src\/data\/items\.ts/.test(screenCall.user), true);
check('and its own role from the manifest', /発注申請/.test(screenCall.user), true);
// The point of the split: the screen gets its own section rather than a share of
// one response covering thirty files.
check('and the part of the specification that names it', /request/.test(screenCall.user), true);

// A sibling that already landed is offered as the house style — the same device
// edit-files uses when it writes a new screen next to a dozen existing ones.
check('a later file is shown one that already landed',
  probe.seen.some((c) => /a finished file from this project/.test(c.user)), true);

// --- declining is a supported outcome --------------------------------------
built = await buildProjectFiles(ctx('react'), stub({ manifest: { screens: [], components: [], data: [], lib: [] } }));
check('no screens means no per-file build', built.html, null);

built = await buildProjectFiles(ctx('react'), stub({ manifest: 'not json at all' }));
check('an unparseable manifest declines rather than throwing', built.html, null);

built = await buildProjectFiles(ctx('react'), stub({ foundation: 'I could not do that.' }));
check('a foundation with no entry file declines', built.html, null);

// A screen that will not parse cannot simply be dropped: the shell imports every
// screen the manifest named, so the document would ship an unresolvable import.
built = await buildProjectFiles(ctx('react'), stub({
  bodies: { 'src/screens/RequestScreen.tsx': 'export default function X(): JSX.Element { return <div ;;; />; }' },
}));
check('a screen that will not parse declines the whole build', built.html, null);

// A component is different: it is not in the shell's import list, so losing one
// costs a piece of the UI rather than the whole project.
built = await buildProjectFiles(ctx('react'), stub({
  bodies: { 'src/components/ui/StatusBadge.tsx': 'export default function B(): JSX.Element { return <span ;;; />; }' },
}));
check('a component that will not parse is dropped, not fatal', Boolean(built.html), true);
check('and it is reported as skipped', built.skipped, ['src/components/ui/StatusBadge.tsx']);

// --- a Vue project is built as Vue, end to end -----------------------------
const VUE_FOUNDATION =
  fence('src/main.ts', `import { createApp } from 'vue';\nimport App from './App.vue';\ncreateApp(App).mount('#app');`) +
  fence('src/App.vue', `<template><InventoryScreen /></template>\n<script setup lang="ts">\nimport InventoryScreen from './screens/InventoryScreen.vue';\n</script>`) +
  fence('src/routes.ts', `export type ScreenId = 'inventory' | 'request';`) +
  fence('src/styles/globals.css', `:root{--accent:#0b6bcb}`);
built = await buildProjectFiles(ctx('vue'), stub({
  foundation: VUE_FOUNDATION,
  defaultBody: `<template><section class="card">中身</section></template>\n<script setup lang="ts"></script>`,
  bodies: {
    'src/data/items.ts': `export interface Item { id: string }\nexport const ITEMS: Item[] = [{ id: 'a' }];`,
    'src/lib/format.ts': `export function fmt(n: number): string { return String(n); }`,
  },
}));
const vuePaths = built.html ? [...built.html.matchAll(/@@@makeui:file (.+)/g)].map((x) => x[1].trim()) : [];
check('a Vue project is assembled from .vue files',
  vuePaths.filter((p) => p.endsWith('.vue')).length, 4);
check('and carries no React files at all',
  vuePaths.some((p) => /\.(tsx|jsx)$/.test(p)), false);

// --- one fence per path ----------------------------------------------------
//
// The foundation call is told the screens belong to someone else. Measured on a
// real run it wrote six of them anyway, and the assembly appended the real ones
// after — so the document carried every screen twice. Nothing failed loudly:
// readProjectFiles keeps the last entry for a path, so the app compiled from the
// right file. The Code tab does not deduplicate, so the user would have seen
// each screen listed twice next to 30KB of dead stubs.
const OVERREACHING_FOUNDATION = FOUNDATION_REACT +
  fence('src/screens/InventoryScreen.tsx', 'export default function S(): JSX.Element { return <div>stub</div>; }') +
  fence('src/screens/RequestScreen.tsx', 'export default function S(): JSX.Element { return <div>stub</div>; }');

built = await buildProjectFiles(ctx('react'), stub({ foundation: OVERREACHING_FOUNDATION }));
const dupPaths = [...built.html.matchAll(/@@@makeui:file (.+)/g)].map((x) => x[1].trim());
check('a path the foundation should not have written appears once',
  dupPaths.length, new Set(dupPaths).size);
check('and the version that survives is the one written for that file alone',
  /stub/.test(built.html), false);

// --- the screens are told how to call the components ----------------------
//
// The failure per-file assembly brings with it, measured on a real run that
// scored 30. DataTable was written by one call as
// `{ columns, data, keyExtractor, onRowClick? }`; InventoryScreen was written by
// another and rendered `<DataTable columns={columns} rows={rows} onRowClick=… />`.
// Both files are internally correct, both compile, and the app threw
// `keyExtractor is not a function` on first render — a blank page.
//
// A file list says a component exists. It does not say how to call it.
const apiProbe = stub({
  bodies: {
    'src/components/ui/StatusBadge.tsx':
      `interface StatusBadgeProps {
  status: 'low' | 'ok';
  keyExtractor: (row: Row) => string;
}
export default function StatusBadge({ status, keyExtractor }: StatusBadgeProps): JSX.Element {
  return <span className="badge">{status}</span>;
}`,
  },
});
await buildProjectFiles(ctx('react'), apiProbe);
const screenPrompt = apiProbe.seen.find((c) => /YOUR FILE: src\/screens\/InventoryScreen\.tsx/.test(c.user));
check('a screen is shown the props of a component it can use',
  /interface StatusBadgeProps/.test(screenPrompt.user), true);
check('including the ones it must not omit',
  /keyExtractor/.test(screenPrompt.user), true);

// The component itself is written first and has nothing of its own to call, so
// its own signature in its own prompt would be describing the file to the call
// that is writing it.
const componentPrompt = apiProbe.seen.find((c) => /YOUR FILE: src\/components\/ui\/StatusBadge\.tsx/.test(c.user));
check('a component is not shown its own signature',
  /COMPONENT API/.test(componentPrompt.user), false);

// --- the foundation is gated too --------------------------------------------
//
// Every per-file write is parse-checked and retried; the one call whose output
// every other file imports was the one nobody checked. Measured on a real Vue
// run: ProductCard.vue shipped with two defineProps() calls — a hard
// @vue/compiler-sfc error — and the preview showed the error instead of a UI.
const BROKEN_FOUNDATION = FOUNDATION_REACT.replace(
  `export default function App(): JSX.Element { return <InventoryScreen />; }`,
  `export default function App(): JSX.Element { return <InventoryScreen ;;; />; }`
);

built = await buildProjectFiles(ctx('react'), stub({ foundation: BROKEN_FOUNDATION }));
check('a foundation that will not parse declines the build', built.html, null);

// One retry, carrying the compiler complaint — a different prompt, not the same
// one resampled. A foundation that comes back correct the second time is used.
let foundationCalls = 0;
const retryStub = (system, user, maxTokens) => {
  const t = typeof system === 'string' ? system : `${system.cached}${system.tail ?? ''}`;
  if (/turn a UI design specification into the file list/.test(t)) return Promise.resolve(JSON.stringify(MANIFEST));
  if (/FOUNDATION of a/.test(t)) {
    foundationCalls++;
    return Promise.resolve(foundationCalls === 1 ? BROKEN_FOUNDATION : FOUNDATION_REACT);
  }
  return Promise.resolve(SCREEN_BODY);
};
built = await buildProjectFiles(ctx('react'), retryStub);
check('and a foundation that comes back correct on the retry is used', Boolean(built.html), true);
check('which took exactly two foundation calls', foundationCalls, 2);

// --- the assembled project has to compile, not just parse -------------------
//
// A different question from the per-file gate: a project compiles as a graph, so
// an import resolving to nothing passes every file check and fails here. This is
// the last point at which declining is free.
built = await buildProjectFiles(ctx('react'), stub({
  bodies: {
    'src/screens/InventoryScreen.tsx':
      `import { missing } from '../lib/nothingWroteThis';
export default function S(): JSX.Element { return <div>{missing}</div>; }`,
  },
}));
check('a project with an import nothing wrote declines', built.html, null);

// --- one screen leads, the rest follow it ----------------------------------
//
// The screens all ran in one wave, so none of them ever saw a finished screen:
// each was written against the stylesheet and a component, and each made its own
// decisions about page structure, heading rhythm and section spacing. Reported
// as 「一部画面では良いデザインが生成されていますが、それ以外の画面はレベルの低い
// デザイン」. A shared vocabulary of class names is not a shared idea of what a
// page looks like.
const leadProbe = stub({
  bodies: {
    'src/screens/InventoryScreen.tsx':
      `export default function InventoryScreen(): JSX.Element {
  return <section className="screen"><header className="page-header"><h1>在庫</h1></header></section>;
}`,
  },
});
await buildProjectFiles(ctx('react'), leadProbe);
const second = leadProbe.seen.find((c) => /YOUR FILE: src\/screens\/RequestScreen\.tsx/.test(c.user));
check('the second screen is shown the first one, not a component',
  /InventoryScreen\.tsx \(a finished file/.test(second.user), true);
check('with its markup, so the page structure carries over',
  /page-header/.test(second.user), true);

/*
 * --- the per-file prompt is one prefix, sent unchanged --------------------------
 *
 * Bedrock matches a cached prefix from the FIRST byte. The path used to be the
 * first line of this prompt — `You write ONE file of a … project: src/…` — so
 * every call had a different byte one and the identical contract behind it could
 * never be reused. Measured on the most expensive run in a 14-day window: 30
 * calls, 4,106 cache-write tokens each, 123,183 written and zero read. The prefix
 * was always long enough; it was the ordering.
 *
 * This is the property, not the fix: whatever the prompt says, every per-file
 * call in a build must send the same one.
 */
{
  const s2 = stub();
  await buildProjectFiles(ctx('react'), s2);
  const perFile = s2.seen.filter((c) => /You write ONE file of a/.test(c.system));
  check('the build made several per-file calls', perFile.length > 1, true);
  check('and every one sent an identical system prompt',
    new Set(perFile.map((c) => c.system)).size, 1);
  // The half that would silently undo it: a path anywhere in the prefix.
  check('no path appears in the prompt at all',
    perFile.some((c) => /src\/\w+\//.test(c.system)), false);
  // And the file each call is for is still stated, in the message that varies.
  check('the file is named in the user message instead',
    perFile.every((c) => /^YOUR FILE: \S+$/m.test(c.user)), true);
  check('a different file every call',
    new Set(perFile.map((c) => /^YOUR FILE: (\S+)$/m.exec(c.user)[1])).size, perFile.length);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
