// Direct manipulation, in the version that edits the source.
//
// The same operations can be faked with CSS — `display: none` to delete, `order`
// to reorder — with no new machinery, because `directEdit` already writes
// override rules. That version is the one worth refusing: a hidden element is
// still in the file, so the next model edit still sees it, the conformance pass
// still measures it, and the exported project still ships it. The screen would
// look right and the project would be wrong.
//
// Two pure modules make the honest version possible. `sourceAnchors` writes the
// producing line onto each host element during the PREVIEW compile only, which
// is the path from a clicked node back to code that the app has never had —
// `directEdit` says as much about why text editing works on a mock and not on a
// project. `structuralEdit` then finds that element's extent and removes or
// swaps it.
//
// Most of what follows is about refusing. An edit landing in the wrong place is
// worse than one that does not happen: the user watches the screen change in a
// way they did not ask for, in a file they were not looking at.
//
//   node test/structural-edit.test.mjs      (from frontend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'dist-test/se-entry.ts');
fs.mkdirSync(path.dirname(entry), { recursive: true });
fs.writeFileSync(entry, [
  "export * from '../src/utils/editing/sourceAnchors'",
  "export * from '../src/utils/editing/structuralEdit'",
].join('\n'));
execSync(
  `npx esbuild "${entry}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist-test/se.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const m = await import(pathToFileURL(path.join(root, 'dist-test/se.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok && detail !== undefined) console.log(`      ${String(detail).split('\n').join('\n      ')}`);
  ok ? pass++ : fail++;
};

// --- anchoring --------------------------------------------------------------

const SRC = `export function Panel({ items }: { items: string[] }) {
  return (
    <div className="panel">
      <h2>在庫</h2>
      <ul className="list">
        {items.map((i) => <li key={i}>{i}</li>)}
      </ul>
      <Button label="追加" />
    </div>
  )
}`;

const anchored = m.anchorJsx('src/Panel.tsx', SRC);
check('every host element gets an anchor, and only those',
  (anchored.match(/data-mkui-src=/g) || []).length === 4,
  (anchored.match(/data-mkui-src="[^"]*"/g) || []).join(' '));

check('the anchor names the line the tag opens on',
  anchored.includes('<div data-mkui-src="src/Panel.tsx:3"')
  && anchored.includes('<h2 data-mkui-src="src/Panel.tsx:4"')
  && anchored.includes('<li data-mkui-src="src/Panel.tsx:6"'),
  anchored);

// A component's call site is not where its DOM comes from. Anchoring it would
// point an edit at a line that does not describe the node that was clicked.
check('a component is not anchored', !/<Button data-mkui-src/.test(anchored));

check('a self-closing tag stays self-closing',
  /<Button label="追加" \/>/.test(anchored), anchored.slice(anchored.indexOf('<Button')));

// The only way to mistake a `<` for a tag is to read one inside quoting.
const QUOTED = `const a = "<div>";
const b = '<span>';
const c = \`<p>\`;
// <section>
/* <article> */
const lt = 1 < 2;
const el = <main>x</main>;`;
const q = m.anchorJsx('f.tsx', QUOTED);
check('a tag inside a string, comment or template is left alone',
  (q.match(/data-mkui-src=/g) || []).length === 1, q);
check('the one real tag is still anchored', /<main data-mkui-src="f.tsx:7"/.test(q), q);

check('a less-than is not a tag', !/1 <[a-z]* data-mkui/.test(q), q);

// --- the `<` that is not a tag ----------------------------------------------
//
// This shipped and broke every stored project using a lowercase generic.
// `useState<string>('')` was read as a tag named `string` — lowercase, so it
// passed the host-element test — and the anchor was written into the type
// argument: `useState<string data-mkui-src="…">('')`. Reported from a real
// project as `Unexpected token, expected ";" (10:56)`.
//
// The token before the `<` is what settles it. After a value it is a comparison
// or a type argument; after an operator, a bracket, or a keyword expecting an
// expression, it can be a tag.
const GENERICS = `import { useState } from 'react'
export function Screen() {
  const [name, setName] = useState<string>('')
  const [n] = useState<number>(0)
  const map: Record<string, string> = {}
  const arr = useState<Array<string>>([])
  const ok = a < b && c[0] < d
  return (
    <div className="x">
      {name ? <span>y</span> : <em>n</em>}
      {items.map((i) => <li key={i}>{i}</li>)}
    </div>
  )
}`;
const g = m.anchorJsx('f.tsx', GENERICS);
check('a lowercase generic is not a tag', !/useState<string data-mkui/.test(g), g.split('\n')[2]);
check('a generic with two arguments is not a tag', !/Record<string data-mkui/.test(g), g.split('\n')[4]);
check('a nested generic is not a tag', !/Array<string data-mkui/.test(g), g.split('\n')[5]);
check('a comparison is not a tag', g.includes('const ok = a < b && c[0] < d'), g.split('\n')[6]);
check('the real elements are still anchored', (g.match(/data-mkui-src/g) || []).length === 4,
  (g.match(/<[a-z]+ data-mkui-src/g) || []).join(' '));
check('a tag after return is anchored', /<div data-mkui-src/.test(g));
check('a tag after ? and after : is anchored',
  /<span data-mkui-src/.test(g) && /<em data-mkui-src/.test(g));
check('a tag after => is anchored', /<li data-mkui-src/.test(g));

const round = m.readAnchor('src/screens/List.tsx:42');
check('an anchor reads back', round?.path === 'src/screens/List.tsx' && round?.line === 42, JSON.stringify(round));
check('a malformed anchor is refused', m.readAnchor('nonsense') === null);
check('a missing anchor is refused', m.readAnchor(undefined) === null);

// --- finding an element -----------------------------------------------------

check('an element is found by the line it opens on', m.elementRange(SRC, 4)?.tag === 'h2');
check('a nested same-name element does not end the outer one',
  m.elementRange(SRC, 3)?.end === SRC.lastIndexOf('</div>') + '</div>'.length,
  JSON.stringify(m.elementRange(SRC, 3)));
check('a self-closing element ends at its own slash',
  SRC.slice(m.elementRange(SRC, 8).start, m.elementRange(SRC, 8).end) === '<Button label="追加" />',
  SRC.slice(m.elementRange(SRC, 8)?.start, m.elementRange(SRC, 8)?.end));
check('a line with no element is refused', m.elementRange(SRC, 1) === null);
check('a line past the end is refused', m.elementRange(SRC, 999) === null);

// --- deleting ---------------------------------------------------------------

const withoutH2 = m.deleteElement(SRC, 4);
check('the element is gone', !withoutH2.includes('<h2>'), withoutH2);
check('its siblings are untouched',
  withoutH2.includes('<ul className="list">') && withoutH2.includes('<Button label="追加" />'));
check('no blank line is left behind', !/\n\s*\n/.test(withoutH2), withoutH2);
check('deleting a container takes its children',
  !m.deleteElement(SRC, 5).includes('<li key={i}>'), m.deleteElement(SRC, 5));

// --- reordering -------------------------------------------------------------

const moved = m.moveElement(SRC, 4, 1);
check('the element swaps with the one after it',
  moved.indexOf('<ul') < moved.indexOf('<h2>'), moved);
check('nothing else moves',
  moved.indexOf('<div') < moved.indexOf('<ul') && moved.indexOf('<h2>') < moved.indexOf('<Button'),
  moved);
check('a swap is reversible',
  m.moveElement(moved, moved.slice(0, moved.indexOf('<h2>')).split('\n').length, -1) === SRC,
  m.moveElement(moved, moved.slice(0, moved.indexOf('<h2>')).split('\n').length, -1));

check('the first child has nothing before it', m.moveElement(SRC, 4, -1) === null);
check('the last child has nothing after it', m.moveElement(SRC, 8, 1) === null);

// --- and the refusals that keep this safe -----------------------------------
//
// Anything other than whitespace between two elements means their relationship
// is not "adjacent siblings", and moving one past something whose role is
// unknown is the guess this module exists to avoid.
const WITH_TEXT = `<div>
  <span>a</span>
  ここに説明が入ります
  <span>b</span>
</div>`;
check('text between siblings blocks a swap', m.moveElement(WITH_TEXT, 2, 1) === null);

const WITH_EXPR = `<div>
  <span>a</span>
  {count > 0 && <Badge n={count} />}
  <span>b</span>
</div>`;
check('an expression between siblings blocks a swap', m.moveElement(WITH_EXPR, 2, 1) === null);

const UNBALANCED = `<div>
  <span>a
</div>`;
check('an element that does not close is refused', m.elementRange(UNBALANCED, 2) === null);

// An attribute holding a tag-like string must not be read as structure.
const ATTR = `<div>
  <input placeholder="<b>bold</b>" />
  <span>after</span>
</div>`;
check('a tag inside an attribute value does not confuse the extent',
  ATTR.slice(m.elementRange(ATTR, 2).start, m.elementRange(ATTR, 2).end)
    === '<input placeholder="<b>bold</b>" />',
  ATTR.slice(m.elementRange(ATTR, 2)?.start, m.elementRange(ATTR, 2)?.end));

// --- templates: Vue and Svelte ----------------------------------------------
//
// The same attribute, in the two languages whose markup is not JSX. Measured in
// a browser against the real compilers: both emit an unknown `data-` attribute
// as a static one, so neither framework has to know it exists. What differs is
// only where the markup is — a `<template>` block, or everything outside
// `<script>` and `<style>`.
//
// The scanner needed one thing for them. JSX requires the slash — `<img />` —
// and a template does not, so a `<br>` was pushed onto the tag stack and never
// popped. It failed safely, refusing rather than returning a wrong range, but it
// refused for every element after a void one as well.
const VUE = `<template>
  <div class="page">
    <h1 class="title">在庫 {{ n }}</h1>
    <img src="/a.png" alt="a">
    <button class="add" @click="n++">追加</button>
  </div>
</template>
<script setup>
const n = 3
</script>`;

const vue = m.anchorVue('src/App.vue', VUE);
check('a vue template is anchored', vue.includes('<div data-mkui-src="src/App.vue:2"'), vue.slice(0, 140));
check('the script block is left alone', vue.includes('<script setup>\nconst n = 3'), vue.slice(vue.indexOf('<script')));

const imgRange = m.elementRange(VUE, 4);
check('a void element in a template is measurable',
  imgRange && VUE.slice(imgRange.start, imgRange.end) === '<img src="/a.png" alt="a">',
  imgRange && VUE.slice(imgRange.start, imgRange.end));
check('and its neighbours still are',
  m.elementRange(VUE, 3)?.tag === 'h1' && m.elementRange(VUE, 5)?.tag === 'button',
  `${m.elementRange(VUE, 3)?.tag} / ${m.elementRange(VUE, 5)?.tag}`);

const vueMoved = m.moveElement(VUE, 3, 1);
check('a void element can be moved past',
  vueMoved !== null && vueMoved.indexOf('<img') < vueMoved.indexOf('<h1'), vueMoved);

// --- text, on a project ------------------------------------------------------
//
// `directEdit` does this for a single-page mock by selector, and says why it
// could not for a project: the rendered DOM had no path back to the file. The
// anchor is that path, so the operation becomes available — for the elements
// where it is honest, which is fewer than it first looks.
const TEXTS = `<div>
  <h1 class="title">在庫一覧</h1>
  <h2>在庫 {n}</h2>
  <p>説明<strong>強調</strong></p>
  <img src="/a.png" alt="a">
  <span>
    余白つき
  </span>
</div>`;

check('plain text is readable', m.elementText(TEXTS, 2) === '在庫一覧', m.elementText(TEXTS, 2));
check('surrounding whitespace is not part of it', m.elementText(TEXTS, 6) === '余白つき', JSON.stringify(m.elementText(TEXTS, 6)));

// The two refusals that matter. Replacing the content wholesale would delete a
// binding, or a nested element, while looking like a wording change.
check('an element holding a binding is refused', m.elementText(TEXTS, 3) === null, m.elementText(TEXTS, 3));
check('an element holding another element is refused', m.elementText(TEXTS, 4) === null, m.elementText(TEXTS, 4));
check('a void element has no text', m.elementText(TEXTS, 5) === null, m.elementText(TEXTS, 5));

const renamed = m.setElementText(TEXTS, 2, '在庫の一覧');
check('the text is replaced', renamed?.includes('<h1 class="title">在庫の一覧</h1>'), renamed?.split('\n')[1]);
check('nothing else changes', renamed?.split('\n').length === TEXTS.split('\n').length);

const spaced = m.setElementText(TEXTS, 6, '書き換え');
check('the whitespace around it is kept',
  spaced?.includes('<span>\n    書き換え\n  </span>'), JSON.stringify(spaced?.slice(spaced.indexOf('<span>'), spaced.indexOf('</span>') + 7)));

// Neither is text in any of the three languages: one opens an element, the other
// an expression. A text box that quietly produced markup would not be one.
check('markup typed into the box is refused', m.setElementText(TEXTS, 2, 'a <b>b</b>') === null);
check('an expression typed into the box is refused', m.setElementText(TEXTS, 2, '{n}') === null);
check('writing to an element with a binding is refused', m.setElementText(TEXTS, 3, 'x') === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
