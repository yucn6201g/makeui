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
};

for (const kind of ['react', 'vue']) {
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

// A module is imported for the values it exports. Stubbing it breaks every file
// that reads it — trading one failure for several.
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
check('and the file with named exports',
  unbuildableFiles(namedExports, 'react', toRunnableDocument).map((f) => f.path), ['src/components/ui/Card.tsx']);

// A project that builds has nothing to name, on any framework.
for (const kind of ['react', 'vue']) {
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
