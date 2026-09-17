// Tests for the two faults that shipped a blank 「ビルドエラー」 to a user.
//
// Both were found in one stored project (d6449fcf), and neither was visible
// from the error the user saw. The message named src/store/AppProvider.tsx and a
// line that is perfectly correct; the project actually had two broken files, and
// only one of them was the model's fault.
//
//   1. An unterminated string literal — `case 'UPDATE_CART_QTY:`. Decidable, so
//      it is repaired here with no model call, and only when the repair compiles.
//   2. reactFiles closed a <script> block at the first </style> inside it. A
//      screen rendering <style>{`…`}</style> in its JSX was read as half a file,
//      so it did not parse — and the whole pipeline was auditing a document that
//      does not exist. The browser preview reads the same bytes with the DOM's
//      own parser and saw the file whole, so the two disagreed.
//
//   node test/syntax-repair.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = (src, out) => {
  execSync(
    `npx esbuild "${path.join(root, src)}" --bundle --platform=node --format=esm ` +
      `--outfile="${path.join(root, out)}" --external:@aws-sdk/* --external:@smithy/*`,
    { stdio: 'pipe', cwd: root }
  );
  return import(pathToFileURL(path.join(root, out)).href);
};

const { repairFileSyntax, repairSyntax, syntaxDefects, unterminatedStrings } =
  await build('src/orchestration/syntax-repair.ts', 'dist/synrep.test.mjs');
const { reactFiles } = await build('src/orchestration/interaction-audit.ts', 'dist/ia2.test.mjs');
const { writeFile } = await build('src/orchestration/repair-files.ts', 'dist/rf2.test.mjs');
const { toRunnableDocument } = await build('src/tools/react-bundle.ts', 'dist/rb3.test.mjs');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- the exact regression --------------------------------------------------
// Reduced from the shipped file. The parser reports the failure at the *next*
// quote, eleven lines below the fault, which is why the position in the error
// message is not something anything upstream could act on.
const REDUCED = `import React from 'react';

export function reducer(state, action) {
  switch (action.type) {
    case 'ADD':
      return { ...state, n: state.n + 1 };
    case 'RESET:
      return { ...state, n: 0 };
    case 'SET_LABEL':
      return { ...state, label: action.payload };
    default:
      return state;
  }
}
`;
const fixed = repairFileSyntax('src/store/AppProvider.tsx', REDUCED);
check('the missing quote is found', fixed !== null, true);
check('and closed before the colon, not after it', fixed?.repairs, [
  { path: 'src/store/AppProvider.tsx', line: 7, before: "case 'RESET:", after: "case 'RESET':" },
]);
// The whole point: the repaired file is one the parser accepts. Nothing is
// applied on a guess — a candidate that does not compile is not returned.
check('the repaired file compiles', repairFileSyntax('src/store/AppProvider.tsx', fixed.body), null);

// A quote missing at the very end of a line closes there.
const TAIL = `const greeting = 'hello;\nexport default greeting;\n`;
check('a quote missing at end of line', repairFileSyntax('src/lib/x.ts', TAIL)?.repairs[0].after, "const greeting = 'hello;'");

// --- what it must not touch ------------------------------------------------
check('a file that parses is left alone', repairFileSyntax('src/lib/ok.ts', 'export const a = 1;\n'), null);

// A fault of another kind is not guessed at. Returning null here is what keeps
// the repair honest: it declines rather than inventing a quote somewhere.
check('an unbalanced brace is not "repaired"', repairFileSyntax('src/lib/bad.ts', 'export function f() {\n  return 1;\n'), null);

// Apostrophes in JSX text look exactly like an opening quote to a scanner. The
// file parses, so the repair never runs — but the scanner must not go on to
// mis-read the rest of the file as string contents either.
const JSX_APOSTROPHE = `export default function P() {\n  return <p>It's fine</p>;\n}\n`;
check('JSX text with an apostrophe still parses', repairFileSyntax('src/screens/P.tsx', JSX_APOSTROPHE), null);

// A stray apostrophe in text plus a genuine fault further down: the scanner
// resumes at the next line rather than treating everything after as a string,
// so the real fault is still reachable.
const BOTH = `export default function P() {\n  // don't panic\n  const label = 'ok;\n  return null;\n}\n`;
check('a comment apostrophe does not hide a later fault', repairFileSyntax('src/screens/P.tsx', BOTH)?.repairs[0].line, 3);

// Template literals legitimately span lines and must not be reported.
const TEMPLATE = 'export const css = `\n  .a { color: red; }\n`;\n';
check('a multi-line template is not a suspect', unterminatedStrings(TEMPLATE), []);
check('and is not "repaired"', repairFileSyntax('src/lib/css.ts', TEMPLATE), null);

// --- the transport reader --------------------------------------------------
// A screen that renders a <style> element in its JSX. Valid React, and the tag
// it closes is the one it opened — not the transport's.
const SCREEN = `export default function S() {
  return (
    <div>
      <style>{\`@media (min-width: 1024px) { .g { display: grid; } }\`}</style>
      <p>after the style block</p>
    </div>
  );
}`;
const DOC = `<!DOCTYPE html><html><body>
<script type="text/jsx" data-file="src/screens/S.tsx">
${SCREEN}
</script>
<style data-file="src/styles/globals.css">
:root { --c: #000; }
</style>
</body></html>`;

const read = reactFiles(DOC);
check('both blocks are found', [...read.keys()], ['src/screens/S.tsx', 'src/styles/globals.css']);
check('the script block is not cut at its inner </style>', read.get('src/screens/S.tsx').includes('after the style block'), true);
check('and is read whole', read.get('src/screens/S.tsx').trim(), SCREEN);
check('the css block is read too', read.get('src/styles/globals.css').trim(), ':root { --c: #000; }');

// The reader and the writer have to agree, or a file survives being read and is
// then refused on the way back in.
const rewritten = writeFile(DOC, 'src/screens/S.tsx', SCREEN);
check('a body holding </style> can be written to a script block', rewritten !== null, true);
check('and survives the round trip', reactFiles(rewritten).get('src/screens/S.tsx').trim(), SCREEN);

// What still cannot be carried: a body that closes its own transport.
check('a script body holding </script> is refused', writeFile(DOC, 'src/screens/S.tsx', 'const s = "</script>";'), null);
check('a css body holding </style> is refused', writeFile(DOC, 'src/styles/globals.css', 'a { } </style>'), null);

// --- end to end ------------------------------------------------------------
// A whole document with the real fault in it: it must not compile before, and
// must compile after, with no model involved.
const BROKEN_DOC = `<!DOCTYPE html><html><body>
<script type="text/jsx" data-file="src/main.tsx">
import { createRoot } from 'react-dom/client';
import App from './App';
createRoot(document.getElementById('root')).render(<App />);
</script>
<script type="text/jsx" data-file="src/App.tsx">
import React from 'react';
export default function App() {
  const mode = 'dark;
  return <div>{mode}</div>;
}
</script>
</body></html>`;

check('the broken document does not compile', toRunnableDocument(BROKEN_DOC).error !== null, true);
check('and says so per file', syntaxDefects(BROKEN_DOC).map((d) => d.id), ['syntax-error']);
const repaired = repairSyntax(BROKEN_DOC);
check('one repair is made', repaired.repairs.length, 1);
check('the document now compiles', toRunnableDocument(repaired.html).error, null);
check('and nothing is left to report', syntaxDefects(repaired.html), []);

// A defect names the file, so the repair planner has something to route.
const defect = syntaxDefects(BROKEN_DOC)[0];
check('the defect names the file', defect.instruction.startsWith('src/App.tsx'), true);
check('and warns that the position is not the fault', defect.instruction.includes('エラー位置は原因の行とは限りません'), true);

const fence = (p, body) => `@@@makeui:file ${p}
${body}
@@@makeui:endfile
`;

// --- every framework, not only React -----------------------------------------
// This module reads its file list through `sourceFiles`, which takes the kind
// from the paths, and checks each file with `parses`, which sends a .vue to the
// Vue compiler and a .svelte to Svelte's. It has always been able to do all
// three.
//
// graph.ts called it inside `if (outputKind === 'react')` at both sites, so the
// two frameworks that have needed the most help shipping a page that renders
// were the two it never ran for. It matters most on `economy` and `fast`, which
// buy no repair passes at all — there a missing quote had no second chance and
// went straight out as a blank pane.
const fenceDoc = (kind, path, body) => {
  // A real entry as well as a component: without one the bundler stops at
  // 「エントリーポイントが見つかりません」, which is a true failure but not the one under
  // test, and it would hide the repair by failing before and after alike.
  const parts =
    kind === 'vue'
      ? [fence('src/main.ts', "import { createApp } from 'vue'\nimport App from './App.vue'\ncreateApp(App).mount('#app')"),
         fence('src/App.vue', '<template><div /></template>')]
      : kind === 'svelte'
      ? [fence('src/main.ts', "import { mount } from 'svelte'\nimport App from './App.svelte'\nmount(App, { target: document.body })"),
         fence('src/App.svelte', '<div></div>')]
      : [fence('src/main.tsx', "import { createRoot } from 'react-dom/client'\nimport App from './App'\ncreateRoot(document.getElementById('root')).render(<App />)"),
         fence('src/App.tsx', 'export default function A() { return <div /> }')];
  return `<!DOCTYPE html><html><body>\n<div id="root"></div><div id="app"></div>\n${parts.join('')}${fence(path, body)}</body></html>`;
};

// The same fault in each framework's own store module: a string literal that
// opens and never closes. A literal cannot contain a raw newline, so this is
// decidable — there is no valid program in which it is intended.
const BROKEN = [
  ['vue', 'src/store/index.ts',
    "import { reactive } from 'vue'\nexport const s = reactive({ mode: 'list })\nexport const other = 1\n"],
  ['svelte', 'src/lib/store.svelte.ts',
    "export const s = $state({ mode: 'list })\nexport const other = 1\n"],
  ['react', 'src/store/types.ts',
    "export type A = { k: 'UPDATE_CART_QTY }\nexport const x = 1\n"],
];

for (const [kind, filePath, body] of BROKEN) {
  const doc = fenceDoc(kind, filePath, body);
  check(`${kind}: the document does not compile to begin with`,
    Boolean(toRunnableDocument(doc, kind).error), true);

  const fixed = repairSyntax(doc);
  check(`${kind}: the unterminated literal is repaired`, fixed.repairs.length, 1);
  check(`${kind}: in the file that actually held it`, fixed.repairs[0].path, filePath);
  check(`${kind}: and the project compiles`, toRunnableDocument(fixed.html, kind).error, null);
  // A repair that cannot be verified is not applied, so the other files must
  // come through untouched rather than merely surviving.
  check(`${kind}: the rest of the project is unchanged`,
    (fixed.html.match(/@@@makeui:file /g) || []).length, 3);
}

// A project that already parses is returned as it came in — this runs on every
// generation now, so doing nothing has to be genuinely nothing.
for (const kind of ['react', 'vue', 'svelte']) {
  const good = fenceDoc(kind, 'src/lib/format.ts', "export const yen = (v: number) => `¥${v}`\n");
  const out = repairSyntax(good);
  check(`${kind}: a sound project is not touched`, out.repairs, []);
  check(`${kind}: and comes back byte for byte`, out.html === good, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
