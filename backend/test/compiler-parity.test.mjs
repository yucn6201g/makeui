// The two compilers have to agree, because only one of them is the truth.
//
// A generated project is compiled twice by different code:
//
//   backend/src/tools/framework-compile.ts   — what the pipeline verifies with,
//     what decides whether a document "builds", what the score is computed on
//   frontend/src/utils/frameworkCompile.ts   — what the user's preview runs
//
// They are deliberately parallel, and they are two separate files. If they ever
// disagree, the failure is the worst-shaped one this product has: the backend
// verifies a project as sound, the score comes out high, the job reports
// success, and the user opens a blank page. Nothing in either half would notice,
// because each is internally consistent.
//
// Measured over 192 files from nine real runs when this was written: zero
// divergences. That is the state worth keeping, not a happy accident to
// rediscover after a user reports it.
//
// The corpus here is synthetic and small on purpose — this pins the contract
// between the two modules, not the quality of any particular generation. The
// cases are the ones where the two could plausibly drift: SFC parsing, scoped
// style extraction, rune modules, TypeScript stripping, JSX.
//
//   node test/compiler-parity.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frontend = path.resolve(root, '../frontend');

// The frontend module is only reachable when its dependencies are installed.
// In CI both `npm ci` steps run before either test suite; locally someone may
// have only ever installed the backend, and skipping is better than failing on
// something that is not a defect.
if (!fs.existsSync(path.join(frontend, 'node_modules'))) {
  console.log('SKIP  frontend dependencies are not installed — parity not checked');
  console.log('\n0 passed, 0 failed');
  process.exit(0);
}

execSync(
  `npx esbuild "${path.join(root, 'src/tools/framework-compile.ts')}" --bundle --platform=node --format=esm ` +
    `--loader:.txt=text --outfile="${path.join(root, 'dist/cp-backend.test.mjs')}" --external:@aws-sdk/*`,
  { stdio: 'inherit', cwd: root }
);
execSync(
  // `virtual:` specifiers are Vite's, for the vendored runtimes; they belong to
  // runtimeScripts(), which this does not call. The Vue alias picks the browser
  // build the backend imports directly — the CJS one drags in optional template
  // engines that are not installed and have nothing to do with compiling an SFC.
  `npx esbuild "${path.join(frontend, 'src/utils/frameworkCompile.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/cp-frontend.test.mjs')}" "--external:virtual:*" ` +
    `--alias:@vue/compiler-sfc=@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js`,
  { stdio: 'inherit', cwd: frontend }
);

const B = await import(pathToFileURL(path.join(root, 'dist/cp-backend.test.mjs')).href);
const F = await import(pathToFileURL(path.join(root, 'dist/cp-frontend.test.mjs')).href);
const sucrase = await import('sucrase');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/** Compiles one file both ways and reports how they differed, if at all. */
async function parity(kind, filePath, source) {
  let backendErr = null, frontendErr = null;
  let backendOut = null, frontendOut = null;
  try { backendOut = B.compileFile(kind, filePath, source); }
  catch (e) { backendErr = String(e?.message ?? e); }
  try { frontendOut = await F.compileFile(kind, filePath, source, sucrase); }
  catch (e) { frontendErr = String(e?.message ?? e); }

  if (Boolean(backendErr) !== Boolean(frontendErr)) {
    return `one accepted and the other refused — backend: ${backendErr ?? 'ok'} / frontend: ${frontendErr ?? 'ok'}`;
  }
  if (backendErr) return 'agree';                       // both refused; the message may differ
  if (backendOut.code !== frontendOut.code) return 'the emitted code differs';
  if ((backendOut.css ?? '') !== (frontendOut.css ?? '')) return 'the extracted CSS differs';
  return 'agree';
}

const CASES = [
  ['react', 'src/App.tsx',
    "import { useState } from 'react'\n" +
    "interface Props { items: string[] }\n" +
    "export default function App({ items }: Props) {\n" +
    "  const [n, setN] = useState<number>(0)\n" +
    "  return <ul className=\"list\">{items.map((x) => <li key={x} onClick={() => setN(n + 1)}>{x}</li>)}</ul>\n" +
    "}"],
  ['react', 'src/lib/format.ts',
    "export type Money = number\nexport const yen = (v: Money): string => `¥${v.toLocaleString()}`"],

  ['vue', 'src/App.vue',
    '<template>\n  <button class="btn" @click="add">{{ label }}</button>\n</template>\n' +
    '<script setup lang="ts">\n' +
    "import { ref, computed } from 'vue'\n" +
    'const props = defineProps<{ start: number }>()\n' +
    'const n = ref(props.start)\n' +
    'const label = computed(() => `${n.value} 点`)\n' +
    'function add() { n.value++ }\n' +
    '</script>\n' +
    '<style scoped>\n.btn { border-radius: 4px; }\n</style>'],
  // Scoped style extraction is the part most likely to drift: it depends on the
  // scope id, and the two derive it independently.
  ['vue', 'src/components/ui/Card.vue',
    '<template><article class="card"><slot /></article></template>\n' +
    '<style scoped>\n.card { padding: 16px; }\n.card:hover { box-shadow: 0 1px 3px #0002; }\n</style>'],

  ['svelte', 'src/App.svelte',
    '<script lang="ts">\n' +
    "  import { store } from './lib/store.svelte'\n" +
    '  let n = $state(0)\n' +
    '  const doubled = $derived(n * 2)\n' +
    '</script>\n' +
    '<button class="btn" onclick={() => n++}>{doubled}</button>\n' +
    '<style>\n.btn { border-radius: 4px; }\n</style>'],
  ['svelte', 'src/lib/store.svelte.ts',
    'export interface State { cart: string[] }\nexport const store = $state<State>({ cart: [] })'],
];

for (const [kind, filePath, source] of CASES) {
  check(`${kind}: ${filePath}`, await parity(kind, filePath, source), 'agree');
}

// A file that cannot compile must be refused by both. One compiler accepting
// what the other rejects is the divergence that ships a blank page.
const BROKEN = [
  ['vue', 'src/Bad.vue', '<template><div></template>\n<script setup>const x = </script>'],
  ['svelte', 'src/Bad.svelte', '<script>\n  const x = ;\n</script>\n<div>'],
  ['react', 'src/Bad.tsx', 'export default function App() { return <div> }'],
];
for (const [kind, filePath, source] of BROKEN) {
  check(`${kind}: both refuse ${filePath}`, await parity(kind, filePath, source), 'agree');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
