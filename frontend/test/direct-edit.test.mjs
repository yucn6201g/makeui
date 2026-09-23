// Tests for editing a generated document by hand.
//
// Covers the CSS path only. The text path goes through DOMParser, which Node
// does not have, and which is the platform's own parser rather than code written
// here — the risk in this module is the stylesheet string surgery, where a rule
// can be matched wrongly and silently write into the wrong place.
//
//   node test/direct-edit.test.mjs      (from frontend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/utils/directEdit.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'node_modules/.cache/de.test.mjs')}"`,
  { stdio: 'inherit', cwd: root }
);
const { applyStyleEdit, readOverrides, isReactDocument } = await import(
  pathToFileURL(path.join(root, 'node_modules/.cache/de.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const PAGE = `<!DOCTYPE html><html><head>
<style data-file="styles/base.css">.card { color: #333; padding: 16px }</style>
</head><body><div class="card">x</div></body></html>`;

const REACT = `<!DOCTYPE html><html><body><div id="root"></div>
<script type="text/jsx" data-file="src/App.tsx">export default function App(){ return null }</script>
<style data-file="src/styles/globals.css">:root { --accent: #0b6 }</style>
</body></html>`;

// --- detection -------------------------------------------------------------
check('a React project is detected', isReactDocument(REACT), true);
check('a single page is not', isReactDocument(PAGE), false);

// --- first edit ------------------------------------------------------------
let out = applyStyleEdit(PAGE, { selector: '.card', property: 'color', value: '#111' });
check('an override block is created', out.includes('data-file="styles/overrides.css"'), true);
check('the declaration is written', /\.card \{ color: #111; \}/.test(out), true);
check('the generated stylesheet is untouched', out.includes('.card { color: #333; padding: 16px }'), true);
// Position is what makes the override win, so it must come after the original.
check('the override comes after the generated CSS',
  out.indexOf('overrides.css') > out.indexOf('base.css'), true);
check('it is inside <head>', out.indexOf('overrides.css') < out.indexOf('</head>'), true);

// --- second edit on the same selector --------------------------------------
let two = applyStyleEdit(out, { selector: '.card', property: 'background', value: '#fff' });
check('a second property joins the same rule', (two.match(/overrides\.css/g) || []).length, 1);
check('both declarations are present', readOverrides(two, '.card'), { color: '#111', background: '#fff' });

// Re-editing a property replaces it rather than appending a duplicate.
let three = applyStyleEdit(two, { selector: '.card', property: 'color', value: '#222' });
check('re-editing replaces the value', readOverrides(three, '.card').color, '#222');
check('and does not duplicate it', (three.match(/color:/g) || []).length, 2); // one generated, one override

// --- removal ---------------------------------------------------------------
let gone = applyStyleEdit(three, { selector: '.card', property: 'color', value: '' });
check('an empty value removes the declaration', readOverrides(gone, '.card'), { background: '#fff' });
let empty = applyStyleEdit(gone, { selector: '.card', property: 'background', value: '' });
check('removing the last one removes the rule', readOverrides(empty, '.card'), {});
check('and leaves no empty rule behind', /\.card\s*\{\s*\}/.test(empty), false);

// --- selectors that are not plain class names ------------------------------
out = applyStyleEdit(PAGE, { selector: '#main > .row:first-child', property: 'gap', value: '8px' });
check('a selector with metacharacters round-trips',
  readOverrides(out, '#main > .row:first-child'), { gap: '8px' });
// A selector that is a prefix of another must not be matched by it.
let both = applyStyleEdit(applyStyleEdit(PAGE,
  { selector: '.card', property: 'color', value: '#111' }),
  { selector: '.card-title', property: 'color', value: '#222' });
check('a prefix selector keeps its own rule', readOverrides(both, '.card'), { color: '#111' });
check('and the longer one keeps its own', readOverrides(both, '.card-title'), { color: '#222' });

// --- React writes into the project's own stylesheet -------------------------
out = applyStyleEdit(REACT, { selector: '.toolbar', property: 'gap', value: '12px' });
check('React edits land in the project stylesheet',
  out.includes('data-file="src/styles/globals.css"') && !out.includes('overrides.css'), true);
check('the existing tokens survive', out.includes('--accent: #0b6'), true);
check('and the declaration is there', readOverrides(out, '.toolbar'), { gap: '12px' });

// --- documents that are missing the usual anchors ---------------------------
out = applyStyleEdit('<div class="card">x</div>', { selector: '.card', property: 'color', value: 'red' });
check('a fragment still gets its stylesheet', out.includes('<style data-file="styles/overrides.css">'), true);
check('nothing is written for an empty value on a new selector',
  applyStyleEdit(PAGE, { selector: '.nope', property: 'color', value: '' }).includes('overrides.css'), false);

// --- a fenced project ---------------------------------------------------------
// The inspector wrote `<style data-file="styles/overrides.css">` into the
// document for every kind of output. A project's preview is compiled from its
// files, and that block is not one of them: measured, `splitHtmlToFiles`
// returned the same three files before and after the block was injected. So the
// inspector reported 保存しました, the document grew, and the preview did not
// change — an edit that fails without failing.
const fence = (p, body) => `@@@makeui:file ${p}\n${body}\n@@@makeui:endfile\n`;
const SHEET = '.btn { border-radius: 4px; }\n.card { padding: 16px; }';
const PROJECT = `<!DOCTYPE html><html><body>\n<div id="root"></div>\n`
  + fence('src/main.tsx', "import { createRoot } from 'react-dom/client'\nimport App from './App'\ncreateRoot(document.getElementById('root')).render(<App />)")
  + fence('src/App.tsx', 'export default function App() { return <button className="btn">買う</button> }')
  + fence('src/styles/globals.css', SHEET)
  + `</body></html>`;

const edited = applyStyleEdit(PROJECT, { selector: '.btn', property: 'border-radius', value: '999px' });

// The edit has to land in a file, because a file is the only thing that renders.
check('a project gains no stray <style> block',
  edited.includes('<style data-file'), false);
check('the edit lands in the project stylesheet',
  /@@@makeui:file src\/styles\/globals\.css[\s\S]*border-radius: 999px[\s\S]*@@@makeui:endfile/.test(edited), true);
check('and the file count is unchanged',
  (edited.match(/@@@makeui:file /g) || []).length, 3);
// Overriding by position is the whole mechanism: appended after the generated
// rules, so it wins whatever the original said.
check('the generated CSS is kept',
  edited.includes('.card { padding: 16px; }'), true);
check('and the edit comes after it',
  edited.indexOf('999px') > edited.indexOf('.card { padding: 16px; }'), true);

// Read-back must see the user's edit and not the generated value, or a second
// edit of the same property has nothing to replace.
check('the edit reads back', readOverrides(edited, '.btn'), { 'border-radius': '999px' });
check('the generated rule does not read back as an edit',
  readOverrides(PROJECT, '.btn'), {});

// A second edit replaces rather than stacking.
const twice = applyStyleEdit(edited, { selector: '.btn', property: 'border-radius', value: '2px' });
check('a second edit replaces the first', readOverrides(twice, '.btn'), { 'border-radius': '2px' });
check('and does not accumulate marker sections',
  (twice.match(/makeui:hand-edits/g) || []).length, 1);

// Two properties on one selector coexist.
const twoProps = applyStyleEdit(twice, { selector: '.btn', property: 'color', value: '#fff' });
check('a second property is added beside the first',
  readOverrides(twoProps, '.btn'), { 'border-radius': '2px', color: '#fff' });

// Removing the last edit takes the section with it, so the stylesheet does not
// keep an empty region that reads as an edit nobody made.
const cleared = applyStyleEdit(
  applyStyleEdit(twoProps, { selector: '.btn', property: 'color', value: '' }),
  { selector: '.btn', property: 'border-radius', value: '' }
);
check('clearing every edit removes the marker', cleared.includes('makeui:hand-edits'), false);
check('and leaves the generated stylesheet intact',
  cleared.includes('.card { padding: 16px; }') && cleared.includes('.btn { border-radius: 4px; }'), true);
check('and the project still has its three files',
  (cleared.match(/@@@makeui:file /g) || []).length, 3);

// Vue goes the same way — the stylesheet is found by what the project
// has, not by the framework it is written in.
for (const [kind, entry, app, ext] of [
  ['vue', ['src/main.ts', "import { createApp } from 'vue'\nimport App from './App.vue'\ncreateApp(App).mount('#app')"], ['src/App.vue', '<template><button class="btn">買う</button></template>'], 'vue'],
]) {
  const doc = `<!DOCTYPE html><html><body>\n<div id="app"></div>\n`
    + fence(...entry) + fence(...app) + fence('src/styles/globals.css', SHEET) + `</body></html>`;
  const out = applyStyleEdit(doc, { selector: '.btn', property: 'border-radius', value: '999px' });
  check(`${kind}: the edit lands in the stylesheet file`,
    /@@@makeui:file src\/styles\/globals\.css[\s\S]*999px/.test(out), true);
  check(`${kind}: and reads back`, readOverrides(out, '.btn'), { 'border-radius': '999px' });
  check(`${kind}: with no stray <style> block`, out.includes('<style data-file'), false);
}

// A fenced project must be refused by the text-editing guard too. It was not:
// the guard read data-file, so text editing was offered on every current
// project. applyTextEdit parses the whole document and re-serialises it, and a
// fenced project's source sits in the body as text — so one round trip turns
// every `<button …>` in every source file into `&lt;button …&gt;`. Corruption
// rather than a no-op, which is why this is pinned separately.
check("a fenced React project is a project", isReactDocument(PROJECT), true);
for (const [kind, file] of [["vue","src/App.vue"]]) {
  const doc = `<!DOCTYPE html><html><body>
` + fence(file, "<button class=\"btn\">x</button>") + `</body></html>`;
  check(kind + ": is a project too", isReactDocument(doc), true);
}
check("a single page is still not one", isReactDocument(PAGE), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
