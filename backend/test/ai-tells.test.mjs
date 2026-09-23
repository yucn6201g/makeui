// Tests for the checks that catch a page looking machine-made.
//
// Written because one of them was switched off exactly where it was needed
// most. The default-palette check ran only when no preset was bound, on the
// reasoning that a preset already dictates the palette — it dictates it, it does
// not enforce it, so indigo could appear in a `warm` document and nothing would
// say so. Selecting a design system and still getting a machine-looking page is
// the one thing a preset is chosen to prevent.
//
//   node test/ai-tells.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/orchestration/design-audit.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/at.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'inherit', cwd: root }
);
const { auditAiTells, auditStylingDiscipline } = await import(pathToFileURL(path.join(root, 'dist/at.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const ids = (html, preset, kind = 'html') => auditAiTells(html, preset, kind).map((d) => d.id);
const page = (css, body = '<h1>在庫一覧</h1><p>今月の入出庫を表示します。</p>') =>
  `<!DOCTYPE html><html><head><style data-file="styles/base.css">${css}</style></head><body>${body}</body></html>`;

const INDIGO = page(':root{--accent:#6366f1}.btn{background:#8b5cf6}');
const CLEAN = page(':root{--accent:#B85C38}.btn{background:#B85C38}');

// --- the change -----------------------------------------------------------
check('the default palette is caught with no preset',
  ids(INDIGO, 'none').includes('default-palette'), true);
check('and with one bound — the case that was switched off',
  ids(INDIGO, 'carbon').includes('default-palette'), true);
check('and with any other system too',
  ids(INDIGO, 'digital-agency').includes('default-palette'), true);

// The instruction has to be actionable, and under a bound system "pick a colour
// from the domain" is the wrong advice: there is a palette, and it is not this.
const bound = auditAiTells(INDIGO, 'carbon', 'html').find((d) => d.id === 'default-palette');
check('under a system it names the system', /carbon/.test(bound.instruction), true);
check('and forbids inventing a replacement', /新しい色を作らない/.test(bound.instruction), true);
const free = auditAiTells(INDIGO, 'none', 'html').find((d) => d.id === 'default-palette');
check('with no system it asks for one drawn from the domain',
  /ドメインから選んだアクセント色/.test(free.instruction), true);

// --- and the negatives ----------------------------------------------------
check('an on-system document is not reported', ids(CLEAN, 'carbon').includes('default-palette'), false);
check('nor with no preset', ids(CLEAN, 'none').includes('default-palette'), false);
check('a clean page reports nothing at all', ids(CLEAN, 'carbon'), []);

// --- the other tells ------------------------------------------------------
check('gradient headline text is caught',
  ids(page('h1{background-clip:text;-webkit-background-clip:text}'), 'carbon').includes('gradient-text'), true);
check('a glass header is caught',
  ids(page('header{backdrop-filter:blur(12px)}'), 'carbon').includes('glass-nav'), true);
check('a coloured glow is caught',
  ids(page('.card{box-shadow:0 0 40px rgba(99,102,241,.5)}'), 'carbon').includes('glow-shadow'), true);
// A neutral shadow is how a real design system does elevation.
check('a neutral shadow is not',
  ids(page('.card{box-shadow:0 0 40px rgba(0,0,0,.08)}'), 'carbon').includes('glow-shadow'), false);
// A modal scrim legitimately blurs; only the header and nav are the template.
check('a blurred modal scrim is not a glass header',
  ids(page('.scrim{backdrop-filter:blur(4px)}'), 'carbon').includes('glass-nav'), false);

check('emoji in the interface are caught',
  ids(page('', '<button>保存 ✨</button>'), 'carbon').includes('emoji'), true);

// The document's own prose about the rules is not a violation of them. This
// fired on four of six runs once: a generated design-guidelines page listing
// 「回避: #6366f1」 was read as using it.
check('the guidelines page is not read as breaking its own rules',
  ids(page('', '<script type="text/markdown" data-file="docs/design-guidelines.md">回避すべき色: #6366f1, #8b5cf6</script>'), 'carbon')
    .includes('default-palette'), false);
// But a colour swatch actually rendered in the UI is the real thing, whatever
// the surrounding copy says about it.
check('a swatch rendered in the interface still counts',
  ids(page('.swatch{background:#6366f1}', '<div class="swatch"></div>'), 'carbon')
    .includes('default-palette'), true);

// --- where the styling actually lives --------------------------------------
//
// Measured on a real `standard` run that every existing audit passed: eight
// screens, 91,625 characters, `className=` used ZERO times and `style={{…}}`
// used 115 times, against a globals.css of 5,194 characters carrying ten class
// rules. Nothing in the pipeline could see it, because every other check asks
// what the markup contains and none of them asked where the styling lives.
//
// It is not a matter of taste. An inline style cannot carry :hover,
// :focus-visible, :disabled or a media query, so a project written this way has
// no interaction states and no responsive behaviour anywhere — however many the
// stylesheet declares.
const fence = (p, body) => `@@@makeui:file ${p}\n${body}\n@@@makeui:endfile\n`;
// The first fence has to start its own line. A fence is a WHOLE line by
// definition, so `<body>@@@makeui:file …` is not one — and the reader quietly
// drops that file while still recognising the document as fenced, because the
// SECOND fence is at a line start. Worth knowing when writing a fixture by hand.
const project = (...blocks) => `<!DOCTYPE html><html><body>\n${blocks.join('')}</body></html>`;

const RICH_CSS = Array.from({ length: 20 }, (_, i) => `.c${i}{padding:8px}`).join('\n');
const inlineScreen = (n) =>
  `export default function S${n}() { return <div style={{padding: 8}}><span style={{color:'#333'}}>x</span><b style={{margin:4}}>y</b></div>; }`;
const classedScreen = (n) =>
  `export default function S${n}() { return <div className="card"><span className="badge">x</span></div>; }`;

const sids = (doc) => auditStylingDiscipline(doc, 'react').map((d) => d.id);

check('a project styled entirely inline is reported',
  sids(project(
    fence('src/styles/globals.css', RICH_CSS),
    fence('src/screens/AScreen.tsx', inlineScreen(1)),
    fence('src/screens/BScreen.tsx', inlineScreen(2)),
    fence('src/screens/CScreen.tsx', inlineScreen(3)),
    fence('src/screens/DScreen.tsx', inlineScreen(4)),
  )).includes('inline-styling'), true);

check('a project that uses its classes is not',
  sids(project(
    fence('src/styles/globals.css', RICH_CSS),
    fence('src/screens/AScreen.tsx', classedScreen(1)),
    fence('src/screens/BScreen.tsx', classedScreen(2)),
    fence('src/screens/CScreen.tsx', classedScreen(3)),
  )).includes('inline-styling'), false);

// A few inline styles are correct and unavoidable — a width from a percentage,
// a swatch showing a colour that came from data. A rule that flagged those
// would be one nobody could satisfy.
check('a handful of inline styles alongside classes is left alone',
  sids(project(
    fence('src/styles/globals.css', RICH_CSS),
    fence('src/screens/AScreen.tsx',
      `export default function A() { return <div className="bar"><i className="fill" style={{width: pct + '%'}} /></div>; }`),
    fence('src/screens/BScreen.tsx', classedScreen(2)),
  )).includes('inline-styling'), false);

check('a stylesheet too thin to dress the screens is reported',
  sids(project(
    fence('src/styles/globals.css', ':root{--a:#000}\n.card{padding:8px}'),
    fence('src/screens/AScreen.tsx', classedScreen(1)),
    fence('src/screens/BScreen.tsx', classedScreen(2)),
    fence('src/screens/CScreen.tsx', classedScreen(3)),
    fence('src/screens/DScreen.tsx', classedScreen(4)),
    fence('src/screens/EScreen.tsx', classedScreen(5)),
    fence('src/screens/FScreen.tsx', classedScreen(6)),
  )).includes('thin-stylesheet'), true);

check('and a stylesheet that carries the design is not',
  sids(project(
    fence('src/styles/globals.css', RICH_CSS),
    fence('src/screens/AScreen.tsx', classedScreen(1)),
    fence('src/screens/BScreen.tsx', classedScreen(2)),
  )).includes('thin-stylesheet'), false);

// A document that is not a project has no stylesheet of its own to judge.
check('a plain document is not judged on a stylesheet it does not have',
  sids('<!DOCTYPE html><html><body><h1>hi</h1></body></html>'), []);

// And the whole audit reaches the repair pass through auditAiTells.
check('the finding travels with the other tells',
  auditAiTells(project(
    fence('src/styles/globals.css', RICH_CSS),
    fence('src/screens/AScreen.tsx', inlineScreen(1)),
    fence('src/screens/BScreen.tsx', inlineScreen(2)),
    fence('src/screens/CScreen.tsx', inlineScreen(3)),
    fence('src/screens/DScreen.tsx', inlineScreen(4)),
  ), 'none', 'react').map((d) => d.id).includes('inline-styling'), true);

// --- where the CSS went ------------------------------------------------------
// Everything above counts .css files, so a Vue or Svelte project that puts its
// styling in per-component <style> blocks reads as having almost no styling —
// and then passes, because thin-stylesheet is scaled to the screen count and a
// handful of shared rules clears it. Measured across nine runs of one brief:
//
//     React   globals.css 21-27k, 116-160 rules, scoped blocks  0
//     Vue     globals.css  6-12k,  13- 77 rules, scoped 17-23k over  6-12 blocks
//     Svelte  globals.css  0-10k,   0- 53 rules, scoped 16-31k over  9-16 blocks
//
// They were not writing less CSS than React. They were writing more of it, once
// per component — so every component defined its own card, its own button and
// its own spacing, and no two screens agreed. That is the cross-screen
// inconsistency users report, and the one thing no per-component check can see.
const scopedComponent = (n, ext) => {
  const css = Array.from({ length: 14 }, (_, i) => `.c${n}-${i} { padding: ${i}px; }`).join('\n');
  return ext === 'vue'
    ? `<template><div class="c${n}-0">x</div></template>\n<style scoped>\n${css}\n</style>`
    : `<div class="c${n}-0">x</div>\n<style>\n${css}\n</style>`;
};
const scopedProject = (kind) => {
  const ext = kind === 'vue' ? 'vue' : 'svelte';
  return project(
    fence('src/styles/globals.css', ':root{--a:#000}\n.app{display:flex}'),
    ...Array.from({ length: 5 }, (_, i) =>
      fence(`src/components/ui/Part${i}.${ext}`, scopedComponent(i, ext))),
    ...Array.from({ length: 3 }, (_, i) =>
      fence(`src/screens/S${i}Screen.${ext}`, `<div class="card">x</div>`)),
  );
};

for (const kind of ['vue']) {
  const ids = auditStylingDiscipline(scopedProject(kind), kind).map((d) => d.id);
  check(`${kind}: styling that lives in the components is reported`,
    ids.includes('scoped-styling'), true);
}

// The classes more than one component defines for itself, named.
//
// The instruction explained the consequence well and named nothing, so a repair
// pass had to decide for itself which of twenty files to open. These are the
// ones the argument is about: on a v195 Vue document, `.empty-state` was written
// separately in four components and `.modal-overlay` in three — four cards that
// will drift, which is the concrete case for a shared vocabulary rather than the
// general one.
const duplicated = (kind) => {
  const ext = kind === 'vue' ? 'vue' : 'svelte';
  const style = (css) => (kind === 'vue' ? `<template><div /></template>\n<style scoped>\n${css}\n</style>` : `<div />\n<style>\n${css}\n</style>`);
  const empty = '.empty-state { padding: 32px; }\n.empty-state-icon { width: 64px; }\n.empty-state-title { font-weight: 600; }';
  return project(
    fence('src/styles/globals.css', ':root{--a:#000}\n.app{display:flex}'),
    // Four components each defining the same empty state for themselves, plus
    // enough scoped rules elsewhere to cross the ratio.
    ...Array.from({ length: 4 }, (_, i) =>
      fence(`src/components/ui/Empty${i}.${ext}`, style(empty))),
    ...Array.from({ length: 5 }, (_, i) =>
      fence(`src/components/ui/More${i}.${ext}`, style(
        Array.from({ length: 8 }, (_, j) => `.m${i}-${j} { margin: ${j}px; }`).join('\n')))),
  );
};

for (const kind of ['vue']) {
  const found = auditStylingDiscipline(duplicated(kind), kind).find((d) => d.id === 'scoped-styling');
  check(`${kind}: the duplicated classes are named`,
    /\.empty-state（4ファイル）/.test(found?.instruction ?? ''), true);
  // A class only one component defines is that component's own layout, which is
  // exactly what scoped styling is for.
  check(`${kind}: a class only one component defines is not`,
    /\.m0-0/.test(found?.instruction ?? ''), false);
}

// The ratio, not the count. A scoped block for layout that genuinely belongs to
// one component is correct, and a rule that flagged those could not be satisfied.
const sharedProject = (kind) => {
  const ext = kind === 'vue' ? 'vue' : 'svelte';
  return project(
    fence('src/styles/globals.css', RICH_CSS + '\n' + Array.from({ length: 60 }, (_, i) => `.s${i}{margin:${i}px}`).join('\n')),
    ...Array.from({ length: 5 }, (_, i) =>
      fence(`src/components/ui/Part${i}.${ext}`,
        `<div class="card">x</div>\n<style>\n.part${i}-grid { grid-template-columns: 1fr 2fr; }\n</style>`)),
    ...Array.from({ length: 3 }, (_, i) =>
      fence(`src/screens/S${i}Screen.${ext}`, `<div class="card">x</div>`)),
  );
};
for (const kind of ['vue']) {
  check(`${kind}: a shared stylesheet with a few scoped rules is not`,
    auditStylingDiscipline(sharedProject(kind), kind).map((d) => d.id).includes('scoped-styling'), false);
}

// React has no scoped block to misuse; its measured failure is the inline style,
// which is checked above. Running this on React could only produce noise.
check('react is not asked about scoped styles',
  auditStylingDiscipline(project(
    fence('src/styles/globals.css', RICH_CSS),
    fence('src/screens/AScreen.tsx', classedScreen(1)),
  ), 'react').map((d) => d.id).includes('scoped-styling'), false);

// A project with NO stylesheet at all is the worst case and used to be the one
// case excused: `thin-stylesheet` was guarded by `cssChars > 0`, meant to keep
// it off plain HTML, and by that point the document is already known to be a
// project. Measured: a Svelte run that shipped no src/styles/globals.css
// whatsoever, 125 rules across fifteen scoped blocks, reported clean.
check('a project with no stylesheet at all is reported',
  auditStylingDiscipline(project(
    fence('src/screens/AScreen.tsx', classedScreen(1)),
    fence('src/screens/BScreen.tsx', classedScreen(2)),
    fence('src/screens/CScreen.tsx', classedScreen(3)),
  ), 'react').map((d) => d.id).includes('thin-stylesheet'), true);

// One problem, reported once. `thin-stylesheet` reads the same fact — globals
// holds too few rules for the screen count — and asks for those classes to be
// written from scratch. When the styling is scoped they are already written,
// once per component, and writing them again is not the repair. 92 of the 99
// documents raising `thin-stylesheet` across the corpus also raised
// `scoped-styling`.
for (const kind of ['vue']) {
  const ids = auditStylingDiscipline(duplicated(kind), kind).map((d) => d.id);
  check(`${kind}: scoped styling is reported`, ids.includes('scoped-styling'), true);
  check(`${kind}: and the thin sheet is not reported beside it`,
    ids.includes('thin-stylesheet'), false);
}
// The seven documents that raise it alone have no stylesheet anywhere, and
// there it is the only thing to say — the React case just above still reports.

// --- the document's own documentation is not the document ----------------------
//
// SPECIFICATION.md and docs/design-guidelines.md travel inside the document, and
// they name the very things these checks look for: the guidelines list `#6366f1`
// as the palette to avoid and spell out the filler words not to write. Counting
// them reports every generation for the prose telling it not to do the thing.
//
// `withoutProse` stripped only `<script data-file="….md">` — the carrier React
// projects used before line fences — so on everything generated since it
// stripped nothing. Measured across 164 stored documents: `filler-copy` fell
// from 23 findings to 0, `default-palette` from 37 to 18, `emoji` from 46 to 27,
// and the 19 documents reported for a palette colour that appears in none of
// their source files fell to none.
const fenced = (p, body) => `@@@makeui:file ${p}\n${body}\n@@@makeui:endfile\n`;
const GUIDELINES =
  '# デザインガイドライン\n' +
  '- indigo / violet の既定パレット（#6366f1, #8b5cf6, #7c3aed）は使わないこと\n' +
  '- 「革新的」「シームレス」「次世代」のような空疎なコピーを書かないこと\n' +
  '- 絵文字をアイコン代わりに使わないこと 🚀 ✨\n';

const cleanProject = project(
  fenced('SPECIFICATION.md', GUIDELINES),
  fenced('docs/design-guidelines.md', GUIDELINES),
  fenced('src/main.tsx', "import App from './App'"),
  fenced('src/App.tsx', 'export default function App(){ return <main><h1>売上分析</h1></main> }'),
  fenced('src/styles/globals.css', ':root { --accent: #0017c1; }\n.app { display: grid; }')
);
check('a document is not judged by its own guidelines',
  auditAiTells(cleanProject, 'none', 'react').map((d) => d.id), []);

// And the checks still fire on the thing itself.
const offending = project(
  fenced('docs/design-guidelines.md', GUIDELINES),
  fenced('src/main.tsx', "import App from './App'"),
  fenced('src/App.tsx', 'export default function App(){ return <main><h1>次世代の体験 🚀</h1></main> }'),
  fenced('src/styles/globals.css', ':root { --accent: #6366f1; }')
);
const tellIds = auditAiTells(offending, 'none', 'react').map((d) => d.id);
check('a palette colour in the source is still reported', tellIds.includes('default-palette'), true);
check('filler copy in the UI is still reported', tellIds.includes('filler-copy'), true);
check('an emoji in the UI is still reported', tellIds.includes('emoji'), true);

// The legacy carrier keeps working — stored documents predate the fence.
const legacy =
  '<!DOCTYPE html><html><body><div id="root"></div>\n' +
  `<script type="text/markdown" data-file="docs/design-guidelines.md">${GUIDELINES}</script>\n` +
  '<script type="text/jsx" data-file="src/App.tsx">export default function App(){ return <main>売上</main> }</script>\n' +
  '</body></html>';
check('the old carrier is still stripped',
  auditAiTells(legacy, 'none', 'react').map((d) => d.id), []);

// The same project, carried either way, must audit the same.
//
// This is the invariant `withoutProse` broke: it stripped the `data-file`
// carrier and not the fence, so the identical project reported three findings
// under one transport and none under the other. The class — a path that reads
// source files without going through the transport — has appeared three times
// (this, `renameFile`, and `cssOverrideModify`), and each time it was silent.
//
// Asserted as an invariant rather than per-check, so a new check written the
// same way fails here instead of in a round.
const asFence = (files) =>
  '<!DOCTYPE html><html><body><div id="root"></div>\n' +
  files.map(([p, b]) => `@@@makeui:file ${p}\n${b}\n@@@makeui:endfile\n`).join('') +
  '</body></html>';
const asDataFile = (files) =>
  '<!DOCTYPE html><html><body><div id="root"></div>\n' +
  files
    .map(([p, b]) =>
      /\.(md|markdown|txt)$/i.test(p)
        ? `<script type="text/markdown" data-file="${p}">${b}</script>\n`
        : /\.css$/i.test(p)
          ? `<style data-file="${p}">${b}</style>\n`
          : `<script type="text/jsx" data-file="${p}">${b}</script>\n`
    )
    .join('') +
  '</body></html>';

const SAME_PROJECT = [
  ['docs/design-guidelines.md', GUIDELINES],
  ['src/main.tsx', "import App from './App'"],
  ['src/App.tsx', 'export default function App(){ return <main><h1>売上分析</h1></main> }'],
  ['src/styles/globals.css', ':root { --accent: #0017c1; }\n.app { display: grid; }'],
];
check('the tells do not depend on the transport',
  auditAiTells(asFence(SAME_PROJECT), 'none', 'react').map((d) => d.id).sort(),
  auditAiTells(asDataFile(SAME_PROJECT), 'none', 'react').map((d) => d.id).sort());

// And the same holds for a project that really does break the rules, so the
// invariant is not satisfied by both sides reporting nothing.
const SAME_BAD = [
  ['docs/design-guidelines.md', GUIDELINES],
  ['src/main.tsx', "import App from './App'"],
  ['src/App.tsx', 'export default function App(){ return <main><h1>次世代の体験 🚀</h1></main> }'],
  ['src/styles/globals.css', ':root { --accent: #6366f1; }'],
];
const bothWays = [
  auditAiTells(asFence(SAME_BAD), 'none', 'react').map((d) => d.id).sort(),
  auditAiTells(asDataFile(SAME_BAD), 'none', 'react').map((d) => d.id).sort(),
];
check('including when there is something to report', bothWays[0], bothWays[1]);
check('and there is something to report', bothWays[0].length > 0, true);

// --- utility-framework classes with no framework -------------------------------------
// Measured over 38 stored projects (2026-09-14): 9 wrote three or more undefined utility
// classes, one wrote 95, and the pages leaning on them rendered as unstyled stacks.
{
  const utilityScreen = `export default function S() { return <div className="grid grid-cols-4 gap-4"><p className="text-sm text-gray-600">x</p><section className="fixed inset-0 flex items-center">y</section></div>; }`;
  const doc = project(
    fence('src/styles/globals.css', RICH_CSS + '\n.card{padding:8px}'),
    fence('src/screens/AScreen.tsx', utilityScreen),
    fence('src/screens/BScreen.tsx', classedScreen(2)),
  );
  const d = auditStylingDiscipline(doc, 'react').find((x) => x.id === 'utility-classes');
  check('undefined utility classes are reported', Boolean(d), true);
  check('by name', ['grid-cols-4', 'gap-4', 'text-gray-600', 'inset-0'].every((c) => d?.instruction.includes(c)), true);
  check('against the files that use them', d?.paths, ['src/screens/AScreen.tsx']);
  const definedHere = project(
    fence('src/styles/globals.css', RICH_CSS + '\n.grid{display:grid}.flex{display:flex}.fixed{position:fixed}'),
    fence('src/screens/AScreen.tsx', 'export default function S() { return <div className="grid flex fixed">x</div>; }'),
  );
  check('a utility-looking name the project defines is not', sids(definedHere).includes('utility-classes'), false);
  const iconPair = project(
    fence('src/styles/globals.css', RICH_CSS),
    fence('src/screens/AScreen.tsx', 'export default function S() { return <svg className="w-6 h-6" viewBox="0 0 24 24" />; }'),
  );
  check('two on an icon are below the floor', sids(iconPair).includes('utility-classes'), false);
  const { UTILITY_CLASS } = await import(pathToFileURL(path.join(root, 'dist/at.test.mjs')).href);
  check('the project\'s own names are not utilities',
    ['my-reservations-screen', 'text-foreground', 'py-lg', 'deck-card__header', 'text-muted', 'border-subtle'].filter((c) => UTILITY_CLASS.test(c)), []);
  check('Tailwind\'s are', ['my-4', 'px-6', 'w-full', 'grid-cols-2', 'text-2xl', 'bg-gray-50', 'rounded-lg', 'sm:grid-cols-2', 'hover:bg-gray-50', 'z-50'].every((c) => UTILITY_CLASS.test(c)), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
