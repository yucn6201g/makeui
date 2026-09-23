/**
 * The frameworks a project can be generated in.
 *
 * This replaced a boolean in all but name — `outputKind === 'react'` with plain
 * HTML as the else — which worked while there were two options and stops working
 * at four. Everything the pipeline needs to know that differs per framework is
 * gathered here, so adding one is a table entry and a compiler rather than a
 * search for every `=== 'react'` in the codebase.
 *
 * HTML is gone. It was a single self-contained file, which meant it shared none
 * of the machinery the project formats share — no file layout, no module graph,
 * no per-file repair — and every one of those paths carried an "or else it is
 * HTML" branch to support one output nobody was choosing for real work.
 *
 * Angular is deliberately absent, and the reason is measured rather than
 * aesthetic: the preview compiles TypeScript with Sucrase, and Sucrase passes
 * decorators through untouched and emits no `design:paramtypes`. A generated
 * `@Component({...}) class AppComponent {}` comes out as syntax no browser will
 * run. Supporting it needs a second, much heavier transpiler plus the Angular
 * JIT compiler and zone.js — megabytes inlined into every preview document.
 */

export type OutputKind = 'react' | 'vue';

const KINDS: OutputKind[] = ['react', 'vue'];

export function isOutputKind(value: unknown): value is OutputKind {
  return typeof value === 'string' && KINDS.includes(value as OutputKind);
}

/**
 * What a stored project without a recorded format is.
 *
 * Nothing new is generated as HTML, but 34 of the 50 stored projects were, and a
 * record written before the field existed has no format at all. Reading those as
 * React is wrong but harmless — the document does not parse as a project, the
 * bundler says so, and the preview shows a build error rather than pretending.
 */
export const DEFAULT_OUTPUT_KIND: OutputKind = 'react';

export interface FrameworkSpec {
  id: OutputKind;
  /** Shown in the composer. */
  label: string;
  /** The module the bundler starts from. */
  entry: string;
  /** Extensions that hold source the compiler must handle. */
  sourceExt: string[];
  /** Where the screen union and route type live. */
  routesFile: string;
  /** The file layout the assembler is told to produce, verbatim. */
  layout: string;
  /** Framework-specific rules appended to the assembler's contract. */
  rules: string;

  /*
   * Everything below serves the EDIT and REPAIR passes rather than generation.
   *
   * They were written against React and only React — a path regex that admitted
   * `.tsx` and nothing else, a screen pattern that could not see a `.vue`, a
   * prompt that opened "You plan a change to a TypeScript React project". The
   * result was not a worse edit on a Vue project, it was a different one: the
   * planner named files the regex rejected, the plan came back empty, the edit
   * fell through to the whole-document rewrite, and that rewrite was told it was
   * holding an HTML document. A Vue project went in and something else came out,
   * which is the 「形式がReactで固定される」 the user reported.
   */

  /** The extension a screen or component file carries in this framework. */
  componentExt: string;
  /** Every extension the edit and repair passes may read and write. */
  editExt: string[];
  /** A path a planner is allowed to name. Anything else is a hallucination. */
  allowedPath: RegExp;
  /** A screen file, by the layout convention above. */
  screenFile: RegExp;
  /** The files that decide which screens exist, shown to the planner in full. */
  routingFiles: RegExp;
  /** What may be imported as a package, phrased for a prompt. */
  packages: string;
  /**
   * The bare specifiers the preview actually provides.
   *
   * Anything else a file imports without a leading `./` is a package nobody
   * installed, and it throws `Module not found` at first require — a blank page.
   * Measured on a real Svelte run: `$app/navigation`, which is SvelteKit's, on a
   * project that is not a SvelteKit project. Nothing checked bare specifiers at
   * all, so it compiled clean and failed at load.
   */
  providedModules: string[];
  /** How this framework's files must be kept intact by a whole-document rewrite. */
  editGuard: string;
  /**
   * How this framework spells shared state, and where it keeps it.
   *
   * The audit asked every project for `useReducer`. A Vue project has no such
   * thing, so it was told — every run — to write `src/store/AppProvider.tsx`
   * with `useApp()`, React files named in React, into a Vue project whose own
   * store was already there and working. The repair pass acts on what the audit
   * reports, so this did not merely mismeasure; it prescribed damage.
   */
  /**
   * How this framework declares shared state.
   *
   * Each spelling allows a generic type argument, nested ones included
   * (`useReducer<Reducer<State, Action>>(…)`). It read `reactive\s*\(`, and
   * TypeScript writes the store as `reactive<State>({ … })` — so the check saw
   * no store, and all 27 documents that raised `store` across the corpus were
   * told to write `src/store/index.ts` while already exporting one from that
   * exact path.
   */
  storePattern: RegExp;
  /**
   * How this framework repeats an element over a list.
   *
   * `static-chart` asked every chart for `.map(`, which is React's spelling —
   * so a Vue `v-for="(segment, i) in segments"` and a Svelte `{#each}` read as
   * a chart with no data behind it. Same shape of mistake as the fallback test
   * in `route-unrendered`: one framework's idiom standing in for the idea.
   */
  iteration: RegExp;
  storeFile: string;
  storeHint: string;
  /**
   * Every spelling of an event handler, for counting controls that do nothing.
   *
   * `onClick=` is React's. Vue writes `@click` (or `v-on:click`), Svelte 5
   * writes `onclick` and Svelte 4 `on:click`. Counting only the React spelling
   * reported a fully wired Vue project as "10 buttons, 0 handlers" — it was not
   * measuring dead controls, it was measuring which framework this is.
   */
  handlerPatterns: RegExp[];
}

export const FRAMEWORKS: Record<OutputKind, FrameworkSpec> = {
  react: {
    id: 'react',
    label: 'React',
    entry: 'src/main.tsx',
    sourceExt: ['.tsx', '.ts'],
    routesFile: 'src/routes.ts',
    layout: `  src/main.tsx                  entry: createRoot(...).render(<AppProvider><App/></AppProvider>)
  src/App.tsx                   shell: chrome + the active screen
  src/routes.ts                 navigation contract — types only, no JSX
  src/hooks/useNavigation.ts    the hash router — routing only, contains NO JSX
  src/store/AppProvider.tsx     context + reducer + useApp. Holds JSX, so .tsx
  src/store/types.ts            State and the Action discriminated union
  src/screens/*.tsx             ONE FILE PER SCREEN, named <Name>Screen.tsx
  src/components/ui/*.tsx       reusable primitives only
  src/components/icons/*.tsx    every icon, as an inline SVG component`,
    rules: `- Import paths are RELATIVE, always. There is no @/ alias and no $lib/ — the
  preview resolves what is written, and an alias resolves to nothing: the module
  is reported missing and the file that imported it is reverted. Measured over 30
  days, 37 repairs were thrown away for @/store, @/routes, @/composables/... and
  $lib/types. Write ../lib/store and ../../routes.
- TypeScript throughout. A .ts file must contain NO JSX — TypeScript reads '<' there
  as a type parameter, not an element. If a file returns markup, it is .tsx.
- Only 'react' and 'react-dom/client' may be imported as packages.`,

    providedModules: ['react', 'react-dom', 'react-dom/client'],
    componentExt: '.tsx',
    editExt: ['.tsx', '.ts', '.css', '.md'],
    allowedPath: /^(src|docs)\/[\w./-]+\.(tsx|ts|css|md)$/,
    screenFile: /^src\/(screens|pages)\/[\w-]+\.tsx$/,
    routingFiles: /^src\/(routes|App)\.tsx?$/,
    packages: `react と react-dom/client のみ`,
    editGuard: `- TypeScript を維持する（.tsx / .ts のみ。.jsx / .js を新規作成しない。any を使わない）
- マークアップを返すファイルは .tsx。.ts に JSX を書くと '<' が型引数として読まれ、必ず壊れます
- 共有状態は既存の reducer に追加する（アクションは判別可能なユニオンで）
- 画面を追加したら ScreenId と App.tsx の分岐に必ず接続する。NAV_ITEMS に入れるのは何も選んでいない状態で意味のある最上位画面だけ（詳細・確認・完了・チェックアウトは元の操作から遷移し、前提が無いときは案内と戻るリンクを出す）`,
    storePattern: /\b(?:useReducer|createContext)\s*(?:<[^()]*>)?\s*\(/,
    iteration: /\.map\s*\(/,
    storeFile: 'src/store/AppProvider.tsx',
    storeHint: 'useReducer + Context、各画面は useApp() 経由',
    handlerPatterns: [/onClick=/g, /onSubmit=/g, /onChange=/g],
  },

  vue: {
    id: 'vue',
    label: 'Vue',
    entry: 'src/main.ts',
    sourceExt: ['.vue', '.ts'],
    routesFile: 'src/routes.ts',
    layout: `  src/main.ts                   entry: createApp(App).mount('#app')
  src/App.vue                   shell: chrome + the active screen
  src/routes.ts                 navigation contract — types only
  src/composables/useNavigation.ts  the hash router — routing only, no template
  src/store/index.ts            reactive store: state + actions, shared via a module singleton
  src/store/types.ts            State and the action payload types
  src/screens/*.vue             ONE FILE PER SCREEN, named <Name>Screen.vue
  src/components/ui/*.vue       reusable primitives only
  src/components/icons/*.vue    every icon, as an inline SVG component`,
    rules: `- Import paths are RELATIVE, always. There is no @/ alias and no $lib/ — the
  preview resolves what is written, and an alias resolves to nothing: the module
  is reported missing and the file that imported it is reverted. Measured over 30
  days, 37 repairs were thrown away for @/store, @/routes, @/composables/... and
  $lib/types. Write ../lib/store and ../../routes.
- Vue 3 Single File Components. Every .vue file is <template> + <script setup lang="ts">
  + optional <style scoped>. Composition API only — no Options API, no defineComponent.
- Only 'vue' may be imported as a package. NO vue-router, NO pinia: routing is the
  hash composable and state is the reactive store, both written by you.
- Therefore <router-link> and <router-view> DO NOT EXIST. Writing one is not a
  compile error and not a visible error either — Vue renders it as an inert
  unknown element, so the screen looks finished and nothing navigates. Links are
  <a href="#/screen"> or a @click that calls navigate() from useNavigation.
- location.hash is NOT reactive. \`watch(() => location.hash, …)\` and a \`computed\`
  reading it never update, so a router built on them changes the address and
  never the screen — every button in the app does nothing. The composable keeps a
  module-level ref of the current route and updates it in
  \`window.addEventListener('hashchange', …)\`. Measured: 9 of 24 stored Vue projects
  watched location.hash, and the 4 without a hashchange listener could not navigate.
- Every component a template uses must be imported in that file's <script setup>.
  There is no global registration.
- The store is a module-level \`reactive({...})\` exported once and imported where
  needed. That is what makes a change on one screen visible on every other.`,

    providedModules: ['vue'],
    componentExt: '.vue',
    editExt: ['.vue', '.ts', '.css', '.md'],
    allowedPath: /^(src|docs)\/[\w./-]+\.(vue|ts|css|md)$/,
    screenFile: /^src\/(screens|pages)\/[\w-]+\.vue$/,
    routingFiles: /^src\/(routes\.ts|App\.vue)$/,
    packages: `vue のみ（vue-router と pinia は入っていません）`,
    editGuard: `- 画面とコンポーネントは .vue の単一ファイルコンポーネント。<template> + <script setup lang="ts">
  + 任意の <style scoped> という構成を維持する。Options API・defineComponent は使わない
- .tsx / .jsx を新規作成しない。JSX はこのプロジェクトでは一切使えません
- <router-link> と <router-view> は存在しません。書いてもエラーにならず、ただ何も起きません。
  リンクは <a href="#/screen">、または useNavigation の navigate() を呼ぶ @click です
- テンプレートで使うコンポーネントは、そのファイルの <script setup> で必ず import する
  （グローバル登録はありません。import 忘れは無言で何も描画されません）
- 共有状態は src/store の reactive オブジェクトに追加する
- 画面を追加したら ScreenId と App.vue の分岐に必ず接続する。NAV_ITEMS に入れるのは何も選んでいない状態で意味のある最上位画面だけ（詳細・確認・完了・チェックアウトは元の操作から遷移し、前提が無いときは案内と戻るリンクを出す）`,
    storePattern: /\b(?:reactive|ref)\s*(?:<[^()]*>)?\s*\(|defineStore/,
    iteration: /\bv-for\s*=|\.map\s*\(/,
    storeFile: 'src/store/index.ts',
    storeHint: 'reactive() のシングルトン、各画面は useStore() 経由',
    handlerPatterns: [/@click[=\s]/g, /@submit[=.\s]/g, /@change[=\s]/g, /v-on:/g],
  },
};

export function frameworkFor(kind: OutputKind | undefined): FrameworkSpec {
  return FRAMEWORKS[kind && isOutputKind(kind) ? kind : DEFAULT_OUTPUT_KIND];
}

