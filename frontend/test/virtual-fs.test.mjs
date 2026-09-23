// How the app turns one stored document into the files it shows and compiles.
//
// Everything user-facing goes through `splitHtmlToFiles` — the preview, the code
// tab, the thumbnail, the ZIP export and the framework detection — so when it
// misreads a document, all of them break at once and in the same way.
//
// That happened. The fenced-transport check was
// `new RegExp(\`^${FILE_OPEN}\\s\`, 'm')` written with ONE backslash. Inside a
// template literal `\s` is an unknown escape, the backslash is dropped, and the
// pattern compiles to `^@@@makeui:files` — which cannot match `@@@makeui:file `.
// So no fenced project was ever recognised: each one fell through to the DOM
// parser, came back as a single `index.html`, and the preview rendered the
// project's own source as a web page, with the HTML parser silently eating every
// JSX element it did not recognise.
//
//   node test/virtual-fs.test.mjs      (from frontend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/utils/virtualFs.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist-test/vfs.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const vfs = await import(pathToFileURL(path.join(root, 'dist-test/vfs.test.mjs')).href);

let pass = 0,
  fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// Built by concatenation so this file holds no literal closing script tag.
const S = '<' + 'script';
const ES = '</' + 'script>';

// --- the fenced transport ---------------------------------------------------
const REACT = [
  '@@@makeui:file src/main.tsx',
  "import React from 'react';",
  "import App from './App';",
  '@@@makeui:endfile',
  '@@@makeui:file src/App.tsx',
  'export default function App() { return <div className="app">hi</div>; }',
  '@@@makeui:endfile',
  '@@@makeui:file src/styles/globals.css',
  ':root { --c: #000 }',
  '@@@makeui:endfile',
].join('\n');

const reactFiles = vfs.splitHtmlToFiles(REACT);
check('a fenced React project is unpacked', reactFiles.map((f) => f.path), [
  'src/main.tsx',
  'src/App.tsx',
  'src/styles/globals.css',
]);
// The whole point: it must NOT come back as one HTML file.
check('and is not read as a single page', reactFiles.some((f) => f.path === 'index.html'), false);
// Indexed defensively: when this regressed, `reactFiles` held one `index.html`
// and a direct `[1].content` threw, which reports as a crashed test run rather
// than a failed assertion and hides which assertion actually broke.
check('JSX survives intact', /<div className="app">hi<\/div>/.test(reactFiles[1]?.content ?? ''), true);

// A Vue project, whose components carry their own closing script tag — the
// hazard that the fence exists to survive.
const VUE = [
  '@@@makeui:file src/App.vue',
  '<template><p>hi</p></template>',
  `${S} setup lang="ts">`,
  'const a = 1;',
  ES,
  '<style scoped>p{color:red}</style>',
  '@@@makeui:endfile',
  '@@@makeui:file src/main.ts',
  "import { createApp } from 'vue';",
  '@@@makeui:endfile',
].join('\n');
const vueFiles = vfs.splitHtmlToFiles(VUE);
check('a fenced Vue project is unpacked', vueFiles.map((f) => f.path), ['src/App.vue', 'src/main.ts']);
check('the SFC keeps its own closing script tag', (vueFiles[0]?.content ?? '').includes(ES), true);
check('and keeps its style block', /<style scoped>/.test(vueFiles[0]?.content ?? ''), true);

const SVELTE = [
  '@@@makeui:file src/App.svelte',
  `${S}>`,
  'let n = $state(0);',
  ES,
  '<button onclick={() => n++}>{n}</button>',
  '@@@makeui:endfile',
].join('\n');

// --- the old transport must not be mistaken for the new one -----------------
//
// The script-block reader needs `DOMParser`, which node does not have, and this
// project has no jsdom — so what that branch RETURNS cannot be asserted here,
// only which branch it takes. That is still the half worth pinning: the sixteen
// stored React projects on the old form break if this routes them to the fenced
// reader, and the bug this file exists for was exactly a misrouting.
const OLD =
  `<!DOCTYPE html><html><body>` +
  `${S} type="text/jsx" data-file="src/main.tsx">\nimport App from './App';\n${ES}` +
  `<style data-file="src/styles.css">\n:root{--c:#000}\n</style>` +
  `</body></html>`;
// Without a DOM the parse throws and the module falls back to a single
// `index.html`. Reaching that fallback proves it did not take the fenced path —
// the fenced reader would have returned [] for a document with no fence.
const oldFiles = vfs.splitHtmlToFiles(OLD);
check('an old document is not read as fenced', oldFiles.map((f) => f.path), ['index.html']);

// --- and a genuine HTML page is still a page --------------------------------
const PAGE = '<!DOCTYPE html><html><body><h1>hello</h1></body></html>';
check('a plain HTML page stays one file', vfs.splitHtmlToFiles(PAGE).length >= 1, true);
check('nothing is invented from an empty document', vfs.splitHtmlToFiles(''), []);
check('nor from null', vfs.splitHtmlToFiles(null), []);

// --- the shape that actually shipped ----------------------------------------
// A fence opener anywhere in the document counts, not only on line 1: the stored
// document may carry a doctype or a blank line ahead of the first file.
const LEADING = `<!DOCTYPE html>\n\n${REACT}`;
check('a fence after a preamble is still found', vfs.splitHtmlToFiles(LEADING).map((f) => f.path), [
  'src/main.tsx',
  'src/App.tsx',
  'src/styles/globals.css',
]);

// --- what the project list asks about a stored document ----------------------
// Both of the card's jobs go through `needsCompileToRender`: whether to compile
// before painting a thumbnail, and which format name to print. It used to test
// for `<script type="text/jsx">` — the OLD transport — so every fenced project
// answered "no". One wrong answer, two visible symptoms: the card painted the
// project's own source as text, and React, Vue and Svelte were all labelled HTML.
execSync(
  `npx esbuild "${path.join(root, 'src/utils/thumbnail.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist-test/thumb.test.mjs')}" "--external:virtual:*" ` +
    `"--alias:@vue/compiler-sfc=@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js"`,
  { stdio: 'pipe', cwd: root }
);
const thumb = await import(pathToFileURL(path.join(root, 'dist-test/thumb.test.mjs')).href);

check('a fenced React project needs compiling', thumb.needsCompileToRender(REACT), true);
check('a fenced Vue project needs compiling', thumb.needsCompileToRender(VUE), true);
// And so it is never handed to the static-thumbnail path, which would paint the
// document's own text.
check('and so gets no static thumbnail', thumb.toThumbnailDoc(VUE), null);
// A genuine page is still a page: it must keep its static thumbnail, which is
// the whole reason that path exists.
check('a real HTML page still gets one', typeof thumb.toThumbnailDoc(PAGE), 'string');
check('and is not sent to the compiler', thumb.needsCompileToRender(PAGE), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
