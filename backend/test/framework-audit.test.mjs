// Audit checks that were reading React out of every project.
//
// The transport moved from `data-file=` to line fences and the frameworks moved
// from one to three; these three checks were written before either and kept
// answering the old question. All three were measured on real runs.
//
//   STORE — `if (!/useReducer/.test(all))`
//     A Vue project has no useReducer, so every Vue run was told to write
//     `src/store/AppProvider.tsx` with `useApp()` — React files, named in
//     React — into a project whose own `src/store/index.ts` was there and
//     working. The scorer's copy of this rule was made framework-aware; this
//     copy was missed. The repair pass acts on what the audit reports, so this
//     did not merely mismeasure, it prescribed damage.
//
//   DEAD CONTROLS — counting `onClick=`
//     Vue spells it `@click`, Svelte 5 `onclick`, Svelte 4 `on:click`.
//     Measured: "ボタンが 10 個ある一方でハンドラが 0 個" on a Vue project where
//     all ten were wired. The count was not measuring dead controls, it was
//     measuring which framework this is.
//
//   DECOMPOSITION — nobody checked it at all
//     SCREEN_COMPLETENESS asks both build paths for 8–16 components and the
//     scorer awards points at 6 and 12. Both are one-way: ignore the
//     instruction and the score is just lower, with nothing telling the repair
//     pass why. Measured on a Vue run — 5 screens, a 12KB stylesheet, and no
//     `src/components/` at all. It rendered clean and scored 30.
//
//   node test/framework-audit.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/orchestration/interaction-audit.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/fa.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'inherit', cwd: root }
);
const { auditInteractivity } = await import(pathToFileURL(path.join(root, 'dist/fa.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${got}\n      want ${want}`);
  ok ? pass++ : fail++;
};

const fence = (p, body) => `@@@makeui:file ${p}\n${body}\n@@@makeui:endfile\n`;
const project = (...blocks) => `<!DOCTYPE html><html><body>\n${blocks.join('')}</body></html>`;
const has = (kind, id, ...blocks) =>
  auditInteractivity(project(...blocks), kind).some((d) => d.id === id);

// A minimum viable project per framework: entry, three screens, a router, a
// store. Each test then swaps in the one file it is about.
const EXT = { react: '.tsx', vue: '.vue', svelte: '.svelte' };
const ENTRY = {
  react: ['src/main.tsx', `import { createRoot } from 'react-dom/client'\nimport App from './App'\ncreateRoot(document.getElementById('root')).render(<App />)`],
  vue: ['src/main.ts', `import { createApp } from 'vue'\nimport App from './App.vue'\ncreateApp(App).mount('#app')`],
  svelte: ['src/main.ts', `import { mount } from 'svelte'\nimport App from './App.svelte'\nmount(App, { target: document.getElementById('app') })`],
};
const ROUTER = `export function useNavigation() {
  window.addEventListener('hashchange', () => {})
  return { route: { screen: 'home' } }
}`;
const STORE = {
  react: ['src/store/AppProvider.tsx', `import { useReducer } from 'react'\nexport function useApp() { return useReducer(r => r, {}) }`],
  vue: ['src/store/index.ts', `import { reactive } from 'vue'\nexport const store = reactive({ cart: [] })`],
  svelte: ['src/store/index.svelte.ts', `export const store = $state({ cart: [] })`],
};

const base = (kind, ...extra) => [
  fence(...ENTRY[kind]),
  fence(`src/screens/HomeScreen${EXT[kind]}`, '<main class="screen" />'),
  fence(`src/screens/ListScreen${EXT[kind]}`, '<main class="screen" />'),
  fence(`src/screens/CartScreen${EXT[kind]}`, '<main class="screen" />'),
  fence(kind === 'vue' ? 'src/composables/useNavigation.ts' : 'src/hooks/useNavigation.ts', ROUTER),
  fence(...STORE[kind]),
  ...extra,
];

// ── The store, in each framework's own spelling ──────────────────────────────
for (const kind of ['react', 'vue', 'svelte']) {
  check(`${kind}: its own store is recognised`, has(kind, 'store', ...base(kind)), false);
  check(
    `${kind}: a project with no store at all is still reported`,
    has(kind, 'store',
      ...base(kind).filter((b) => !b.includes('src/store/')),
      fence('src/data/products.ts', 'export const PRODUCTS = []')),
    true
  );
}

// ── Handlers, in each framework's own spelling ───────────────────────────────
// Ten buttons, ten handlers. Only the spelling changes.
const wired = {
  react: Array.from({ length: 10 }, (_, i) => `<button onClick={() => go(${i})}>買う</button>`).join('\n'),
  vue: Array.from({ length: 10 }, (_, i) => `<button @click="go(${i})">買う</button>`).join('\n'),
  svelte: Array.from({ length: 10 }, (_, i) => `<button onclick={() => go(${i})}>買う</button>`).join('\n'),
};
const bare = Array.from({ length: 10 }, () => '<button>買う</button>').join('\n');

for (const kind of ['react', 'vue', 'svelte']) {
  check(
    `${kind}: ten wired buttons are not dead controls`,
    has(kind, 'dead-controls', ...base(kind, fence(`src/components/ui/Buy${EXT[kind]}`, wired[kind]))),
    false
  );
  check(
    `${kind}: ten bare buttons still are`,
    has(kind, 'dead-controls', ...base(kind, fence(`src/components/ui/Buy${EXT[kind]}`, bare))),
    true
  );
}
// Svelte 4's spelling has to keep working — stored projects use it.
check(
  'svelte: the on:click spelling counts too',
  has('svelte', 'dead-controls', ...base('svelte',
    fence('src/components/ui/Buy.svelte',
      Array.from({ length: 10 }, (_, i) => `<button on:click={() => go(${i})}>買う</button>`).join('\n')))),
  false
);

// ── Decomposition ────────────────────────────────────────────────────────────
const uiComponents = (kind, n) =>
  Array.from({ length: n }, (_, i) =>
    fence(`src/components/ui/Part${i}${EXT[kind]}`, '<div class="card" />'));

for (const kind of ['react', 'vue', 'svelte']) {
  check(
    `${kind}: no components under a full screen set is reported`,
    has(kind, 'decomposition', ...base(kind)),
    true
  );
  check(
    `${kind}: six components clears the bar`,
    has(kind, 'decomposition', ...base(kind, ...uiComponents(kind, 6))),
    false
  );
}
// Below the screen minimum the screens come first — reporting both spends a
// repair round on the smaller half of one problem.
check(
  'react: not asked of a project that has no screens yet',
  has('react', 'decomposition',
    fence(...ENTRY.react),
    fence('src/screens/HomeScreen.tsx', '<main />'),
    fence(...STORE.react)),
  false
);

// The instruction used to list cards, badges, table rows and empty states — a
// good list, and the same list whatever it was sent to. The document already
// says which of those it repeats: a class written into three or more screen
// files is markup that exists three or more times. Across the corpus 74 of the
// 89 documents that raise this now name their own repetition.
const instruction = (kind, ...blocks) =>
  auditInteractivity(project(...blocks), kind).find((d) => d.id === 'decomposition')?.instruction ?? '';

const around = (kind, ...screens) => [
  fence(...ENTRY[kind]),
  ...screens,
  fence(kind === 'vue' ? 'src/composables/useNavigation.ts' : 'src/hooks/useNavigation.ts', ROUTER),
  fence(...STORE[kind]),
];
const screen = (kind, name, markup, padTo = 0) =>
  fence(`src/screens/${name}Screen${EXT[kind]}`, markup + '\n'.repeat(padTo));

const said = instruction('vue', ...around('vue',
  screen('vue', 'Home', '<div class="page-header"><button class="btn-primary">送信</button></div>', 240),
  screen('vue', 'List', '<div class="page-header"><button class="btn-primary">送信</button></div>'),
  screen('vue', 'Detail', '<div class="page-header"><button class="btn-primary">送信</button></div>')));
check('the repeated class is named', /btn-primary/.test(said), true);
check('with the screens holding it',
  /DetailScreen\.vue、HomeScreen\.vue、ListScreen\.vue/.test(said), true);
check('and so is the other one', /page-header/.test(said), true);
// The longest screen file is where extraction starts, and only when it is long
// enough to be worth saying so.
check('an oversized screen is named', /HomeScreen\.vue（24\d行）/.test(said), true);
check('a short one is not', /ListScreen\.vue（\d+行）/.test(said), false);

// A class in only two screens is not repetition worth a component.
const twice = instruction('vue', ...around('vue',
  screen('vue', 'Home', '<div class="btn-primary" />'),
  screen('vue', 'List', '<div class="btn-primary" />'),
  screen('vue', 'Detail', '<div class="other" />')));
check('two screens is not repetition', /実際に重複している/.test(twice), false);
// And the generic advice survives, because a document with nothing repeated
// still needs to be told what to build.
check('the general list is still there', /カード、バッジ/.test(twice), true);

// A generic type argument does not stop something being a store. `storePattern`
// read `reactive\s*\(`, and TypeScript writes it `reactive<State>({ … })`, so
// all 27 documents that raised `store` across the corpus were told to write
// `src/store/index.ts` while already exporting one from that exact path.
const TYPED_STORE = {
  react: ['src/store/AppProvider.tsx', "import { useReducer } from 'react'\nexport function useApp() { return useReducer<Reducer<State, Action>>(r, {}) }"],
  vue: ['src/store/index.ts', "import { reactive } from 'vue'\nexport const state = reactive<State>({ cart: [] })"],
  svelte: ['src/store/index.svelte.ts', 'export const store = $state<AppState>({ cart: [] })'],
};
for (const kind of ['react', 'vue', 'svelte']) {
  check(`${kind}: a store with a generic type argument is a store`,
    has(kind, 'store', ...base(kind).filter((b) => !b.includes('src/store/')), fence(...TYPED_STORE[kind])),
    false);
  // And a project with genuinely no shared state is still reported.
  check(`${kind}: no store at all is still reported`,
    has(kind, 'store', ...base(kind).filter((b) => !b.includes('src/store/')),
      fence('src/data/products.ts', 'export const PRODUCTS = []')),
    true);
}

// `placeholder` read the joined bodies, which carry SPECIFICATION.md and the
// design guidelines — and those name the placeholders as things not to write.
// 2 of the 11 corpus findings were the document being reported for the prose
// telling it not to do the thing. It also named nothing, and the file and line
// are known where it is raised.
const instruction2 = (kind, id, ...blocks) =>
  auditInteractivity(project(...blocks), kind).find((d) => d.id === id)?.instruction ?? '';
const stub = (kind) => instruction2(kind, 'placeholder', ...around(kind,
  screen(kind, 'Cart', "<script>function checkout() { toast('チェックアウト機能は準備中です') }</script>"),
  screen(kind, 'List', '<div />'),
  screen(kind, 'Home', '<div />')));
for (const kind of ['react', 'vue', 'svelte']) {
  check(`${kind}: a placeholder in code is reported`, stub(kind).length > 0, true);
  check(`${kind}: with the file and line`,
    stub(kind).includes(`src/screens/CartScreen${EXT[kind]}:`), true);
  // The specification says not to write these, and saying so is not doing it.
  check(`${kind}: the guidelines naming them is not the document doing it`,
    instruction2(kind, 'placeholder', ...around(kind,
      screen(kind, 'Home', '<div />'), screen(kind, 'List', '<div />'), screen(kind, 'Detail', '<div />'),
      fence('SPECIFICATION.md', '「Coming Soon」や「準備中です」と書かないこと'))).length,
    0);
}

// ── Icons, on the same terms ─────────────────────────────────────────────────
//
// 106 corpus documents have an icons/ folder and render none of it.
for (const kind of ['react', 'vue', 'svelte']) {
  const ICON = fence(`src/components/icons/ChevronIcon${EXT[kind]}`, '<svg viewBox="0 0 24 24" />');
  check(`${kind}: icons nothing renders are reported`,
    has(kind, 'icons', ...base(kind), ICON), true);
  check(`${kind}: a rendered icon clears it`,
    has(kind, 'icons', ...base(kind), ICON,
      fence(`src/screens/HomeScreen${EXT[kind]}`, '<main><ChevronIcon /></main>')), false);
}

// ── Native dialogs ───────────────────────────────────────────────────────────
//
// All 57 corpus findings are real `alert()` / `confirm()` calls — there is no
// false positive here. But they are two different jobs wearing one sentence:
//
//     alert('必須項目を入力してください')          → an inline field error
//     confirm('この申請を削除してもよろしいですか') → a modal with two buttons
//
// Told to build a modal, a repair building one for a validation message has
// made the form worse.
const dialog = (kind, ...blocks) =>
  auditInteractivity(project(...blocks), kind).find((d) => d.id === 'native-dialog')?.instruction ?? '';

const validation = dialog('vue', ...around('vue',
  screen('vue', 'Form', "<script setup>function save() { if (!name) { alert('必須項目を入力してください'); return } }</script>"),
  screen('vue', 'List', '<template><div /></template>'),
  screen('vue', 'Detail', '<template><div /></template>')));
check('an alert is routed to an inline error', /インラインのエラー文/.test(validation), true);
check('and named with its message',
  /src\/screens\/FormScreen\.vue の alert\('必須項目を入力してください'\)/.test(validation), true);
check('a document with no confirm is not told to build a modal',
  /2ボタンを持つモーダル/.test(validation), false);

const destructive = dialog('vue', ...around('vue',
  screen('vue', 'Detail', "<script setup>function del() { if (confirm('削除してもよろしいですか')) remove() }</script>"),
  screen('vue', 'List', '<template><div /></template>'),
  screen('vue', 'Home', '<template><div /></template>')));
check('a confirm is routed to a modal', /2ボタンを持つモーダル/.test(destructive), true);
check('and not to an inline error', /インラインのエラー文/.test(destructive), false);

// ── Illustrations, in each framework's own spelling ──────────────────────────
//
// The filter read `\.tsx$`, so on Vue and Svelte it matched nothing whatever the
// project held, and `imagery-missing` fired for ever — including on the runs
// that had just created EmptyState, ContentFrame and Wordmark. Measured across
// the stored corpus: 39 of the 67 documents that hold illustrations of their own
// framework were still being told they had none.
//
// That is worse than a stray finding. The repair creates the three files, the
// defect fires again anyway, the count does not fall, the pass is judged "no
// improvement", and everything it wrote is discarded with it.
const ART = (kind, name, body) =>
  fence(`src/components/illustrations/${name}${EXT[kind]}`, body ?? '<svg viewBox="0 0 160 120" />');

for (const kind of ['react', 'vue', 'svelte']) {
  check(`${kind}: a project with no illustrations is reported`,
    has(kind, 'imagery-missing', ...base(kind)), true);
  // Rendered, not merely present. The instruction has always said 「ファイルを
  // 作るだけでは不十分です」 and nothing checked it, so a repair could create
  // three files, close the finding, and leave the screen with no artwork on it.
  // 134 corpus documents have the folder and render none of it.
  const showsArt = fence(`src/screens/HomeScreen${EXT[kind]}`, '<main><EmptyState /></main>');
  check(`${kind}: its own illustrations are recognised`,
    has(kind, 'imagery-missing', ...base(kind, showsArt, ART(kind, 'EmptyState'), ART(kind, 'ContentFrame'))), false);
  check(`${kind}: illustrations nothing renders are reported`,
    has(kind, 'imagery-missing', ...base(kind, ART(kind, 'EmptyState'), ART(kind, 'ContentFrame'))), true);
  // And it asks for the half that is missing, not for more files.
  const unused = auditInteractivity(
    project(...base(kind, ART(kind, 'EmptyState'), ART(kind, 'ContentFrame'))), kind
  ).find((d) => d.id === 'imagery-missing')?.instruction ?? '';
  check(`${kind}: and says not to create more`, /新しいファイルは作らないでください/.test(unused), true);
  check(`${kind}: naming the files that exist`, unused.includes(`EmptyState${EXT[kind]}`), true);
  // An import with no other mention is not use — 76 corpus files are exactly
  // that shape. A component handed around as a value is.
  const importedOnly = fence(`src/screens/HomeScreen${EXT[kind]}`,
    `import EmptyState from '../components/illustrations/EmptyState${EXT[kind]}'`);
  check(`${kind}: importing without rendering is not using`,
    has(kind, 'imagery-missing', ...base(kind, importedOnly, ART(kind, 'EmptyState'))), true);
  const asValue = fence(`src/screens/HomeScreen${EXT[kind]}`,
    `import EmptyState from '../components/illustrations/EmptyState${EXT[kind]}'\nconst art = { empty: EmptyState }`);
  check(`${kind}: handing it around as a value is`,
    has(kind, 'imagery-missing', ...base(kind, asValue, ART(kind, 'EmptyState'))), false);
  // A helper module in that folder is not an illustration. Deliberately not
  // tested with another framework's file: a `.vue` inside a React project moves
  // what `detectKind` decides the project IS, so the assertion would be about
  // kind detection rather than about this filter.
  check(`${kind}: a module in that folder does not count`,
    has(kind, 'imagery-missing', ...base(kind),
      fence('src/components/illustrations/palette.ts', 'export const stroke = "#ccc"')), true);
  // `static-chart` read the same list, so it never looked at a Vue or Svelte
  // chart either — and it asked all three for `.map(`, which is React's.
  //
  // A chart nothing renders is not what this is about. All 53 corpus findings
  // were a `DataGraphIllustration` appearing exactly once in the document, in
  // its own file header: nothing imports it and the reviewer never sees it.
  const renders = (name) =>
    fence(`src/screens/HomeScreen${EXT[kind]}`, `<main><${name} /></main>`);
  check(`${kind}: a chart drawn from fixed values is reported`,
    has(kind, 'static-chart', ...base(kind), renders('SalesChart'),
      ART(kind, 'SalesChart', '<svg><rect height="40" /><rect height="70" /></svg>')), true);
  check(`${kind}: a chart nothing renders is not`,
    has(kind, 'static-chart', ...base(kind),
      ART(kind, 'SalesChart', '<svg><rect height="40" /><rect height="70" /></svg>')), false);
  check(`${kind}: a chart that maps over its data is not`,
    has(kind, 'static-chart', ...base(kind), renders('SalesChart'),
      ART(kind, 'SalesChart', '<svg>{data.map((d) => <rect height={d.n} />)}</svg>')), false);
}

// Each framework's own way of repeating an element. Asking all three for
// `.map(` reported a Vue `v-for` and a Svelte `{#each}` as a chart with no data
// behind it — 42 chart files across the corpus, every one of them correct.
check('vue: v-for is iteration',
  has('vue', 'static-chart', ...base('vue'),
    fence('src/screens/HomeScreen.vue', '<template><SalesChart /></template>'),
    ART('vue', 'SalesChart', '<template><svg><rect v-for="d in data" :height="d.n" /></svg></template>')),
  false);
check('svelte: {#each} is iteration',
  has('svelte', 'static-chart', ...base('svelte'),
    fence('src/screens/HomeScreen.svelte', '<main><SalesChart /></main>'),
    ART('svelte', 'SalesChart', '<svg>{#each data as d}<rect height={d.n} />{/each}</svg>')),
  false);

// Charts live where the project puts them: src/components/ui/ (151 files across
// the corpus), src/components/charts/ (89), src/screens/charts/ (36). Reading
// only src/components/illustrations/ measured a corner of the problem.
check('react: a chart under components/ui is in scope',
  has('react', 'static-chart', ...base('react'),
    fence('src/screens/HomeScreen.tsx', 'export default () => <main><SalesChart /></main>;'),
    fence('src/components/ui/SalesChart.tsx',
      'export function SalesChart() { return <svg><rect height="40" /><rect height="70" /></svg>; }')),
  true);
// A 24x24 glyph of a bar chart is an icon, and fixed rects are right there.
check('react: an icon named BarChart is not a chart',
  has('react', 'static-chart', ...base('react'),
    fence('src/screens/HomeScreen.tsx', 'export default () => <main><BarChart /></main>;'),
    fence('src/components/icons/BarChart.tsx',
      'export function BarChart() { return <svg viewBox="0 0 24 24"><rect x="3" y="3" width="4" height="16" /></svg>; }')),
  false);
// A wrapper passes its content through; there is no geometry in it to drive.
check('vue: a chart wrapper with a slot is not a chart',
  has('vue', 'static-chart', ...base('vue'),
    fence('src/screens/HomeScreen.vue', '<template><ChartContainer /></template>'),
    fence('src/components/ui/ChartContainer.vue',
      '<template><div class="chart"><h2>{{ title }}</h2><svg /><slot /></div></template>')),
  false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
