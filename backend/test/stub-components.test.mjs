// One component that will not build must cost that component, not the app.
//
// A project compiles as a unit, so a single unparseable file has always meant a
// blank page — every screen gone because one icon had a stray brace. Every
// deterministic repair in framework-fixups.ts exists because a specific idiom
// was measured doing exactly that, and three sessions running, the next
// generation found a different one:
//
//     v145   a class-based router               (ours — Sucrase lowering)
//     v151   {width={size}} in one icon of nine
//     v153   {#const …} in two screens
//
// Each was fixed and the following run failed on something new. A list of known
// mistakes cannot be finished, and "a generated UI must never fail to display"
// does not bend — so the last step handles the class rather than the instance.
//
//   node test/stub-components.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const [src, out] of [
  ['src/tools/framework-fixups.ts', 'dist/sb-ff.test.mjs'],
  ['src/tools/react-bundle.ts', 'dist/sb-rb.test.mjs'],
]) {
  execSync(
    `npx esbuild "${path.join(root, src)}" --bundle --platform=node --format=esm --loader:.txt=text ` +
      `--outfile="${path.join(root, out)}" --external:@aws-sdk/* --external:@smithy/*`,
    { stdio: 'inherit', cwd: root }
  );
}
const { stubUnbuildableComponents, unbuildableFiles } = await import(pathToFileURL(path.join(root, 'dist/sb-ff.test.mjs')).href);
const { toRunnableDocument } = await import(pathToFileURL(path.join(root, 'dist/sb-rb.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const fence = (p, body) => `@@@makeui:file ${p}\n${body}\n@@@makeui:endfile\n`;
const doc = (...blocks) =>
  `<!DOCTYPE html><html><body>\n<div id="root"></div><div id="app"></div>\n${blocks.join('')}</body></html>`;

// A working three-file project per framework, plus one component that is broken
// in a way nothing above recognises — which is the case this exists for.
const SHAPES = {
  react: {
    entry: ['src/main.tsx', "import { createRoot } from 'react-dom/client'\nimport App from './App'\ncreateRoot(document.getElementById('root')).render(<App />)"],
    app: ['src/App.tsx', "import Card from './components/ui/Card'\nexport default function App() { return <main><Card /></main> }"],
    good: ['src/components/ui/Card.tsx', 'export default function Card() { return <article className="card" /> }'],
    broken: ['src/components/ui/Card.tsx', 'export default function Card() { return <article className="card" }'],
  },
  vue: {
    entry: ['src/main.ts', "import { createApp } from 'vue'\nimport App from './App.vue'\ncreateApp(App).mount('#app')"],
    app: ['src/App.vue', "<template><main><Card /></main></template>\n<script setup lang=\"ts\">\nimport Card from './components/ui/Card.vue'\n</script>"],
    good: ['src/components/ui/Card.vue', '<template><article class="card" /></template>'],
    broken: ['src/components/ui/Card.vue', '<template><article class="card"</template>\n<script setup>const x = </script>'],
  },
  svelte: {
    entry: ['src/main.ts', "import { mount } from 'svelte'\nimport App from './App.svelte'\nmount(App, { target: document.getElementById('app') })"],
    app: ['src/App.svelte', "<script lang=\"ts\">\n  import Card from './components/ui/Card.svelte'\n</script>\n<main><Card /></main>"],
    good: ['src/components/ui/Card.svelte', '<article class="card"></article>'],
    broken: ['src/components/ui/Card.svelte', '<script>\n  const x = ;\n</script>\n<article class="card"></article>'],
  },
};

for (const kind of ['react', 'vue', 'svelte']) {
  const s = SHAPES[kind];
  const sound = doc(fence(...s.entry), fence(...s.app), fence(...s.good));
  const broken = doc(fence(...s.entry), fence(...s.app), fence(...s.broken));

  check(`${kind}: the sound project builds`, toRunnableDocument(sound, kind).error, null);
  check(`${kind}: the broken one does not`, Boolean(toRunnableDocument(broken, kind).error), true);

  const rescued = stubUnbuildableComponents(broken, kind, toRunnableDocument);
  check(`${kind}: the broken component is replaced`, rescued.stubbed, [s.broken[0]]);
  check(`${kind}: and the project builds`, toRunnableDocument(rescued.html, kind).error, null);
  // The placeholder has to be visible: a silently missing card leaves the user
  // hunting for a screen that never rendered.
  check(`${kind}: the placeholder says which file it was`,
    rescued.html.includes(s.broken[0].split('/').pop()), true);
  check(`${kind}: the shell is untouched`, rescued.html.includes(s.app[1]), true);
  check(`${kind}: no other file is replaced`,
    (rescued.html.match(/@@@makeui:file /g) || []).length, 3);

  // A project that builds must come back exactly as it came in.
  const untouched = stubUnbuildableComponents(sound, kind, toRunnableDocument);
  check(`${kind}: a sound project is not stubbed`, untouched.stubbed, []);
  check(`${kind}: and is returned byte for byte`, untouched.html === sound, true);
}

// --- what it must refuse ------------------------------------------------------
// The shell is the application; a stub of it leaves nothing to navigate, which
// is not a smaller failure than the build error.
const brokenShell = doc(
  fence(...SHAPES.svelte.entry),
  fence('src/App.svelte', '<script>\n  const x = ;\n</script>\n<main></main>'),
  fence(...SHAPES.svelte.good)
);
check('the shell is never stubbed', stubUnbuildableComponents(brokenShell, 'svelte', toRunnableDocument).stubbed, []);

// A module is imported for the values it exports. Stubbing it breaks every file
// that reads it — trading one failure for several.
const brokenModule = doc(
  fence(...SHAPES.svelte.entry),
  fence('src/App.svelte', "<script lang=\"ts\">\n  import { store } from './lib/store.svelte';\n</script>\n<main>{store.n}</main>"),
  fence('src/lib/store.svelte.ts', 'export const store = $state({ n: ;')
);
check('a rune module is never stubbed', stubUnbuildableComponents(brokenModule, 'svelte', toRunnableDocument).stubbed, []);

// React only in practice: something imports those by name and the stub has none.
const namedExports = doc(
  fence(...SHAPES.react.entry),
  fence('src/App.tsx', "import { Card, Badge } from './components/ui/Card'\nexport default function App() { return <main><Card /><Badge /></main> }"),
  fence('src/components/ui/Card.tsx', 'export function Card() { return <article }\nexport function Badge() { return <b /> }')
);
check('a file with named exports is never stubbed',
  stubUnbuildableComponents(namedExports, 'react', toRunnableDocument).stubbed, []);

// In a .svelte file `export let variant` declares a PROP, not a module export,
// and nothing imports it by name. Reading React's rule here skipped a component
// whose project then stayed blank for no reason — measured.
const svelteProps = doc(
  fence(...SHAPES.svelte.entry),
  fence(...SHAPES.svelte.app),
  fence('src/components/ui/Card.svelte', "<script>\n  export let variant = 'primary';\n  const x = ;\n</script>\n<article></article>")
);
check('Svelte 4 props do not count as named exports',
  stubUnbuildableComponents(svelteProps, 'svelte', toRunnableDocument).stubbed, ['src/components/ui/Card.svelte']);

// The placeholder must not be a diagnostic dead end. Measured at v160: all three
// screens of a Svelte project were stubbed, the app rendered its shell with a
// placeholder where every screen should have been, and the only record was a
// list of three filenames — three failures with one probable cause, and nothing
// anywhere saying what it was.
const diagnosed = stubUnbuildableComponents(
  doc(fence(...SHAPES.svelte.entry), fence(...SHAPES.svelte.app), fence(...SHAPES.svelte.broken)),
  "svelte", toRunnableDocument);
check("the reason travels with the file", diagnosed.reasons.length, 1);
check("naming the file", diagnosed.reasons[0].path, SHAPES.svelte.broken[0]);
// One line of it: the compiler's message runs to a docs URL on the next line,
// which is noise in a log entry and pushes the useful half out of view.
check('and carrying the compiler message, on one line',
  diagnosed.reasons[0].error.length > 0 && !diagnosed.reasons[0].error.includes('\n'), true);

// --- what the compiler names, as against what the stub will take --------------
//
// Everything the stub refuses above is still a file that will not build, and
// three of those four cases are ones a repair could fix — the shell especially,
// since nothing else can rescue it. Gating the build repair on the stub's list
// therefore skipped exactly the cases where repairing matters most. Measured on
// v195: an `{@const}` where Svelte does not allow one, in App.svelte, on a
// project with five screens and seventeen components. Nothing could be stubbed,
// nothing was repaired, and the page rendered nothing at all.
check('the shell the stub refuses is still named',
  unbuildableFiles(brokenShell, 'svelte', toRunnableDocument).map((f) => f.path), ['src/App.svelte']);
check('and so is the module',
  unbuildableFiles(brokenModule, 'svelte', toRunnableDocument).map((f) => f.path), ['src/lib/store.svelte.ts']);
check('and the file with named exports',
  unbuildableFiles(namedExports, 'react', toRunnableDocument).map((f) => f.path), ['src/components/ui/Card.tsx']);

// The compiler's own message travels with the path — it is what makes the
// repair possible, and a paraphrase would drop the position.
check('the error comes with it',
  unbuildableFiles(brokenShell, 'svelte', toRunnableDocument)[0].error.length > 0, true);

// A project that builds has nothing to name, on any framework.
for (const kind of ['react', 'vue', 'svelte']) {
  const s = SHAPES[kind];
  check(`${kind}: a sound project names nothing`,
    unbuildableFiles(doc(fence(...s.entry), fence(...s.app), fence(...s.good)), kind, toRunnableDocument), []);
  // And a component that the stub would take is named too — the two lists agree
  // wherever stubbing is willing to act.
  check(`${kind}: a broken component is named as well`,
    unbuildableFiles(doc(fence(...s.entry), fence(...s.app), fence(...s.broken)), kind, toRunnableDocument)
      .map((f) => f.path),
    [s.broken[0]]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
