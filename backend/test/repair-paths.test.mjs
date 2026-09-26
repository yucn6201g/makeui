// The repair planner has to be allowed to name a component.
//
// `planFileRepairs` asks a model which files each defect belongs to, then
// filters the answer so a hallucinated path cannot enter the plan. That filter
// was React's, hard-coded:
//
//     if (!/^(src|docs)\/[\w./-]+\.(tsx|ts|css|md)$/.test(path)) continue
//
// So for a Vue or Svelte project EVERY component the planner named was silently
// dropped — src/App.vue, src/screens/HomeScreen.svelte, every card and badge
// under src/components/ui — and the plan came back holding only the .ts and .css
// files. The repair pass could not touch a component in two of the three
// frameworks.
//
// That is the whole reason `decomposition`, `shell-without-nav`, `icons` and
// `emoji` survived three repair passes on measured Vue and Svelte runs while the
// same defects were fixed on React ones. It reads as the model being worse at
// those frameworks; it was the plan being thrown away.
//
// The edit path had already been corrected for exactly this — there is a comment
// in edit-files.ts calling it "the silent half of the Vue" problem — and this
// copy was missed.
//
//   node test/repair-paths.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/orchestration/repair/repair-files.ts')}" --bundle --platform=node --format=esm ` +
    `--loader:.txt=text --outfile="${path.join(root, 'dist/rp.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'inherit', cwd: root }
);
const { planFileRepairs } = await import(pathToFileURL(path.join(root, 'dist/rp.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const fence = (p, body) => `@@@makeui:file ${p}\n${body}\n@@@makeui:endfile\n`;
const project = (...blocks) => `<!DOCTYPE html><html><body>\n${blocks.join('')}</body></html>`;

const DEFECT = [{ id: 'decomposition', instruction: '共通部品を切り出してください。' }];

const PROJECTS = {
  react: project(
    fence('src/main.tsx', "import App from './App'"),
    fence('src/App.tsx', 'export default function App() { return <main /> }'),
    fence('src/screens/HomeScreen.tsx', 'export default function H() { return <main /> }'),
    fence('src/styles/globals.css', '.card {}')
  ),
  vue: project(
    fence('src/main.ts', "import App from './App.vue'"),
    fence('src/App.vue', '<template><main /></template>'),
    fence('src/screens/HomeScreen.vue', '<template><main /></template>'),
    fence('src/styles/globals.css', '.card {}')
  ),
  svelte: project(
    fence('src/main.ts', "import App from './App.svelte'"),
    fence('src/App.svelte', '<main></main>'),
    fence('src/screens/HomeScreen.svelte', '<main></main>'),
    fence('src/styles/globals.css', '.card {}')
  ),
};

// The paths a planner would plausibly return for each framework, including one
// new file — creating components is what `decomposition` asks for.
const ANSWERS = {
  react: ['src/screens/HomeScreen.tsx', 'src/components/ui/Card.tsx', 'src/styles/globals.css'],
  vue: ['src/screens/HomeScreen.vue', 'src/components/ui/Card.vue', 'src/styles/globals.css'],
  svelte: ['src/screens/HomeScreen.svelte', 'src/components/ui/Card.svelte', 'src/styles/globals.css'],
};

for (const kind of ['react', 'vue']) {
  const stub = async () => JSON.stringify({ assignments: [{ defect: 1, paths: ANSWERS[kind] }] });
  const plans = await planFileRepairs(PROJECTS[kind], DEFECT, stub);
  check(`${kind}: every named path survives the filter`,
    plans.map((p) => p.path).sort(), [...ANSWERS[kind]].sort());
  check(`${kind}: the component is in the plan`,
    plans.some((p) => /HomeScreen\.(tsx|vue|svelte)$/.test(p.path)), true);
  check(`${kind}: a new component is planned as a creation`,
    plans.find((p) => /Card\.(tsx|vue|svelte)$/.test(p.path))?.create, true);
}

// The filter still has to refuse what it was written to refuse.
const bad = ['../../etc/passwd', '/etc/passwd', 'node_modules/x/index.js', 'package.json', 'src/App.py'];
for (const kind of ['react', 'vue']) {
  const stub = async () => JSON.stringify({ assignments: [{ defect: 1, paths: bad }] });
  const plans = await planFileRepairs(PROJECTS[kind], DEFECT, stub);
  check(`${kind}: paths outside the project are still refused`, plans.map((p) => p.path), []);
}

// A component of the WRONG framework is a hallucination too — a .vue file has no
// business in a React plan, and admitting one is how a project changes shape.
const crossed = { react: 'src/components/ui/Card.vue', vue: 'src/components/ui/Card.tsx', svelte: 'src/components/ui/Card.vue' };
for (const kind of ['react', 'vue']) {
  const stub = async () => JSON.stringify({ assignments: [{ defect: 1, paths: [crossed[kind]] }] });
  const plans = await planFileRepairs(PROJECTS[kind], DEFECT, stub);
  check(`${kind}: a component from another framework is refused`, plans.map((p) => p.path), []);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
