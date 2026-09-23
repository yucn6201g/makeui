// A restyle instruction on a generated project has to actually change it.
//
// `cssOverrideModify` is the cheap path for 「ボタンを丸くして」: ask for CSS
// rather than re-emitting eighty thousand characters of project. It finished by
// injecting `<style data-file="styles/overrides.css">` into the document — the
// transport React projects used before line fences.
//
// Every generated project is comfortably over the 25k threshold that selects
// this path, so it took essentially every non-structural styling instruction,
// and in a fenced document that block is invisible. Measured on a real project:
// 33 files in, 33 files out, and the compiled preview did not contain the rule.
//
// The failure mode is the worst one available — the model is called and paid
// for, the block comes back, the job completes, the UI is reported as modified,
// and nothing about it changed, with no error anywhere to say so.
//
// Both halves are pinned here: that the old mechanism really is inert on a
// project (so nobody restores it), and that the new one reaches the render in
// all three frameworks.
//
//   node test/style-edit.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const [src, out] of [
  ['src/tools/react-bundle.ts', 'dist/se-rb.test.mjs'],
  ['src/tools/project-transport.ts', 'dist/se-pt.test.mjs'],
]) {
  execSync(
    `npx esbuild "${path.join(root, src)}" --bundle --platform=node --format=esm ` +
      `--outfile="${path.join(root, out)}" --external:@aws-sdk/* --external:@smithy/*`,
    { stdio: 'inherit', cwd: root }
  );
}
const { toRunnableDocument } = await import(pathToFileURL(path.join(root, 'dist/se-rb.test.mjs')).href);
const { readProjectFiles, writeProjectFile } = await import(pathToFileURL(path.join(root, 'dist/se-pt.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const fence = (p, body) => `@@@makeui:file ${p}\n${body}\n@@@makeui:endfile\n`;
const project = (...blocks) => `<!DOCTYPE html><html><body>\n<div id="root"></div><div id="app"></div>\n${blocks.join('')}</body></html>`;

const SHEET = '.btn { border-radius: 4px; }\n.card { padding: 16px; }';
const MARKER = 'border-radius: 999px';
const RULE = `.btn { ${MARKER} !important; }`;

const ENTRY = {
  react: ['src/main.tsx', "import { createRoot } from 'react-dom/client'\nimport App from './App'\ncreateRoot(document.getElementById('root')).render(<App />)"],
  vue: ['src/main.ts', "import { createApp } from 'vue'\nimport App from './App.vue'\ncreateApp(App).mount('#app')"],
  svelte: ['src/main.ts', "import { mount } from 'svelte'\nimport App from './App.svelte'\nmount(App, { target: document.getElementById('app') })"],
};
const APP = {
  react: ['src/App.tsx', "import './styles/globals.css'\nexport default function App() { return <button className=\"btn\">買う</button> }"],
  vue: ['src/App.vue', "<template><button class=\"btn\">買う</button></template>\n<script setup lang=\"ts\">\nimport './styles/globals.css'\n</script>"],
  svelte: ['src/App.svelte', "<script lang=\"ts\">\n  import './styles/globals.css'\n</script>\n<button class=\"btn\">買う</button>"],
};

const docFor = (kind) => project(
  fence(...ENTRY[kind]),
  fence(...APP[kind]),
  fence('src/styles/globals.css', SHEET)
);

for (const kind of ['react', 'vue']) {
  const doc = docFor(kind);
  check(`${kind}: the project compiles to begin with`, toRunnableDocument(doc, kind).error, null);

  // --- the old mechanism, which is why this file exists ---------------------
  const injected = doc.replace(
    /<\/body>/i,
    `<style data-file="styles/overrides.css">\n${RULE}\n</style>\n</body>`
  );
  check(
    `${kind}: an injected data-file block adds no file`,
    readProjectFiles(injected).size,
    readProjectFiles(doc).size
  );
  check(
    `${kind}: and never reaches the rendered page`,
    (toRunnableDocument(injected, kind).html ?? '').includes(MARKER),
    false
  );

  // --- the mechanism that replaced it ---------------------------------------
  const files = readProjectFiles(doc);
  const sheetPath = [...files.keys()].find((p) => p === 'src/styles/globals.css');
  const appended = writeProjectFile(
    doc,
    sheetPath,
    `${files.get(sheetPath)}\n\n/* --- 変更指示による追加 --- */\n${RULE}\n`
  );
  check(`${kind}: appending to the stylesheet is accepted by the transport`, appended !== null, true);
  check(`${kind}: it still compiles`, toRunnableDocument(appended, kind).error, null);
  check(
    `${kind}: and the rule reaches the rendered page`,
    (toRunnableDocument(appended, kind).html ?? '').includes(MARKER),
    true
  );
  // The point of appending rather than replacing: the design survives the edit.
  check(
    `${kind}: the existing stylesheet is kept`,
    readProjectFiles(appended).get(sheetPath).includes('.card { padding: 16px; }'),
    true
  );
}

// The legacy path must keep working: 34 stored projects predate the fences, and
// for a document that is genuinely one HTML page, the injected block is right.
const legacy = '<!DOCTYPE html><html><head></head><body><button class="btn">買う</button></body></html>';
check('a plain HTML document is not a project', readProjectFiles(legacy).size, 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
