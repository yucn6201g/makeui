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

export type OutputKind = 'react' | 'vue' | 'svelte';

const KINDS: OutputKind[] = ['react', 'vue', 'svelte'];

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
- 画面を追加したら ScreenId・NAV_ITEMS・App.tsx の分岐すべてに必ず接続する`,
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
- 画面を追加したら ScreenId・NAV_ITEMS・App.vue の分岐すべてに必ず接続する`,
    storePattern: /\b(?:reactive|ref)\s*(?:<[^()]*>)?\s*\(|defineStore/,
    iteration: /\bv-for\s*=|\.map\s*\(/,
    storeFile: 'src/store/index.ts',
    storeHint: 'reactive() のシングルトン、各画面は useStore() 経由',
    handlerPatterns: [/@click[=\s]/g, /@submit[=.\s]/g, /@change[=\s]/g, /v-on:/g],
  },

  svelte: {
    id: 'svelte',
    label: 'Svelte',
    entry: 'src/main.ts',
    sourceExt: ['.svelte', '.ts'],
    routesFile: 'src/routes.ts',
    layout: `  src/main.ts                   entry: mount(App, { target: document.getElementById('app') })
  src/App.svelte                shell: chrome + the active screen
  src/routes.ts                 navigation contract — types only
  src/lib/navigation.svelte.ts  the hash router — routing only, no markup
  src/lib/store.svelte.ts       shared state with $state runes, exported once
  src/lib/types.ts              State and the action payload types
  src/screens/*.svelte          ONE FILE PER SCREEN, named <Name>Screen.svelte
  src/components/ui/*.svelte    reusable primitives only
  src/components/icons/*.svelte every icon, as an inline SVG component`,
    rules: `- Import paths are RELATIVE, always. There is no @/ alias and no $lib/ — the
  preview resolves what is written, and an alias resolves to nothing: the module
  is reported missing and the file that imported it is reverted. Measured over 30
  days, 37 repairs were thrown away for @/store, @/routes, @/composables/... and
  $lib/types. Write ../lib/store and ../../routes.
- Svelte 5 with runes. State is \`$state(...)\`, derived values are \`$derived(...)\`,
  effects are \`$effect(...)\`. Do NOT use the Svelte 3/4 store contract, \`export let\`
  for props, or \`on:click\` — props come from \`$props()\` and handlers are \`onclick\`.
- Props, exactly. \`export let\` is not merely old style: in a file that also uses a
  rune it is a compile error, and mixing the two is the most common way a
  generated component fails to build. Write it like this — one destructuring of
  \`$props()\`, defaults inline, and \`class\` renamed because it is a keyword:

      <script>
        let { variant = 'primary', disabled = false, class: className = '', children } = $props();
        let busy = $state(false);
      </script>
      <button class="btn {variant} {className}" {disabled} onclick={() => busy = true}>
        {@render children?.()}
      </button>

  Slot content is \`children\` from \`$props()\` rendered with \`{@render children?.()}\`,
  not \`<slot />\`.
- \`$derived\` has exactly two forms and no third. Use \`$derived(expr)\` for a single
  expression, and \`$derived.by(() => { … return x })\` when the computation needs
  statements. \`$derived(() => { … })()\` — calling the function to get its value —
  is a COMPILE ERROR: the rune must BE the initializer, and there the initializer
  is a call. Measured: a filtered list written that way stopped the whole build.
- Runes are SYNTAX, not imports. Never write \`import { $state } from 'svelte'\` —
  there is nothing by that name to import. Doing so makes the compiler treat it
  as an ordinary binding, so it is not compiled away and the page throws
  \`$state is not a function\` on load, with nothing failing at build time.
- A \`.svelte.ts\` module MUST NOT export a rune directly. \`export const route =
  $derived(x)\` is a compile error ("Cannot export derived state from a module").
  Export a plain function instead, and let callers invoke it:

      let currentRoute = $state({ screen: 'home' });
      export function route() { return currentRoute; }      // read
      export function navigate(next) { currentRoute = next; } // write

  \`export const store = $state({...})\` is fine, and the reason is that it is
  never REASSIGNED — only its properties are. \`export let route = $state({...})\`
  followed anywhere by \`route = next\` is refused with 「Cannot export state from a
  module if it is reassigned」, which is a different error from the one above and
  the more common one: measured on the stored corpus, a navigation module written
  exactly that way took its whole project's score to the floor. Assign to a
  property (\`routeState.current = next\`) or export a setter, never to the exported
  binding itself.
- Runes take NO type argument. \`$state<string | null>(null)\` and \`$props<{ a: A }>()\`
  are both 「Unexpected token」 — a parse error, so the file does not build and
  nothing on the screen renders. The type goes on the binding:

      let selected: string | null = $state(null);
      interface Props { rows: Row[]; onPick: (id: string) => void }
      let { rows, onPick }: Props = $props();

  This is the single most common build failure in the stored Svelte corpus, and
  it looks correct to anyone who writes TypeScript generics by habit.
- Event modifiers are gone. There is no \`on:submit|preventDefault\` and no
  \`onsubmit|preventDefault\` — the second is not a valid attribute NAME and fails the
  build outright. Call it in the handler:

      <form onsubmit={(e) => { e.preventDefault(); save(); }}>

- ONE top-level \`<script>\` per component, plus at most one \`<script module>\`. A second
  \`<script>\` — imports in one and state in another, say — is 「A component can have a
  single top-level <script> element」 and the component does not compile.
- Shared state lives in a \`.svelte.ts\` module (runes only work in those), exported
  once and imported where needed.
- NEVER name an export \`state\`, \`props\`, \`derived\` or \`effect\`. With a binding
  called \`state\` in scope, Svelte reads \`$state(...)\` as a store subscription on
  it rather than as the rune — so every rune in that file compiles to
  \`store_get(state, '$state')\`, the module is not a store, and the page throws
  \`state.subscribe is not a function\` on first render. Nothing fails at build
  time. Measured: eight components poisoned by one import, and a blank page.
  Call it \`appState\`, \`cartState\` or \`shopStore\`.
- NO packages at all. Routing and state are yours; svelte itself is the only import.
  There is therefore no <Link> and no router component: links are <a href="#/screen">
  or an onclick that calls navigate(). An unimported component compiles fine and
  renders nothing, so the screen looks finished while nothing on it works.
- Every component used in markup must be imported in that file's <script>.
- A Svelte component NEVER returns markup and NEVER contains JSX. There is no
  \`return (<div>…</div>)\` and no early return — the <script> block holds only
  declarations, and ALL markup lives in the template area below it. To show a
  different view when data is missing, use {#if} / {:else} in that template:

      <script>
        let { item } = $props();
      </script>
      {#if !item}
        <div class="empty">見つかりません</div>
      {:else}
        <article>{item.name}</article>
      {/if}

  Measured: an early \`return (<div class="screen">…)\` inside <script> — React
  written in a Svelte file — stopped the whole project building.
- Interactive elements MUST NOT nest. A <button> inside a <button>, or an <a>
  inside an <a>, is a COMPILE ERROR in Svelte — not a warning — and it stops the
  whole project building. Measured: a card written as a giant <button> with a
  「借りる」 button inside it failed with \`<button> cannot be a descendant of
  <button>\`. For a clickable card carrying its own actions, make the card a
  <div> with onclick and role="button" tabindex="0", and keep the real <button>
  elements as its children.`,

    providedModules: ['svelte', 'svelte/store', 'svelte/internal/client', 'svelte/internal/disclose-version', 'svelte/internal/flags/legacy'],
    componentExt: '.svelte',
    editExt: ['.svelte', '.ts', '.css', '.md'],
    allowedPath: /^(src|docs)\/[\w./-]+\.(svelte|ts|css|md)$/,
    screenFile: /^src\/(screens|pages)\/[\w-]+\.svelte$/,
    routingFiles: /^src\/(routes\.ts|App\.svelte)$/,
    packages: `なし（svelte 本体以外は一切追加できません）`,
    editGuard: `- 画面とコンポーネントは .svelte。Svelte 5 のルーン構文（$state / $derived / $props）を維持する。
  \`export let\` は使わない — ルーンを使うファイルに書くとコンパイルエラーになります
- .tsx / .jsx を新規作成しない。JSX はこのプロジェクトでは一切使えません。
  <script> ブロックに \`return (<div>…</div>)\` を書かない。マークアップは必ずテンプレート領域に置き、
  出し分けは {#if} / {:else} で書く
- \`$derived(() => {…})()\` と書かない。文が必要なときは \`$derived.by(() => {…})\`
- ルーンは構文であって import ではありません。\`import { $state } from 'svelte'\` は書かない
- .svelte.ts から \`$derived\` を直接 export しない（コンパイルエラー）。関数にして export する
- <button> の中に <button>、<a> の中に <a> を入れない — Svelte ではコンパイルエラーです
- テンプレートで使うコンポーネントは、そのファイルの <script> で必ず import する
- 画面を追加したら ScreenId・NAV_ITEMS・App.svelte の分岐すべてに必ず接続する`,
    storePattern: /(?:\$state|\bwritable|\breadable)\s*(?:<[^()]*>)?\s*\(/,
    iteration: /\{#each\b|\.map\s*\(/,
    storeFile: 'src/store/index.svelte.ts',
    storeHint: '$state を持つオブジェクトを export、各画面はそれを import',
    handlerPatterns: [/\bonclick=/g, /\bonsubmit=/g, /\bonchange=/g, /\bon:(click|submit|change)/g],
  },
};

export function frameworkFor(kind: OutputKind | undefined): FrameworkSpec {
  return FRAMEWORKS[kind && isOutputKind(kind) ? kind : DEFAULT_OUTPUT_KIND];
}

