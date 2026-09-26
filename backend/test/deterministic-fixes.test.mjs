// Defects whose answer is arithmetic, solved without a model call.
//
// The repair loop rewrites a whole file to fix whatever it is given — measured
// at 2,768 output tokens a call, and 43% of everything a run writes. For a
// defect whose answer is computable that is the wrong trade twice: it costs a
// file rewrite, and it asks a model to guess a number that was already known.
//
// `passingPair` has always returned the exact hex that clears the ratio; the
// instruction said 「文字色を #xxxxxx にすれば基準を満たします」 and then asked a
// model to apply it. And the form-control floor was already spelled out in full.
//
// What is asserted here is mostly restraint. A deterministic pass carries more
// authority than a model's guess — nothing downstream doubts it — so it must
// refuse every case it cannot actually settle rather than claim a defect closed.
//
//   node test/deterministic-fixes.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/orchestration/repair/deterministic-fixes.ts')}" --bundle --platform=node ` +
    `--format=esm --outfile="${path.join(root, 'dist/df.test.mjs')}" ` +
    `--external:@aws-sdk/* --external:@smithy/* --external:@strands-agents/*`,
  { stdio: 'pipe', cwd: root }
);
const { applyDeterministicFixes, revealHiddenScreens } = await import(pathToFileURL(path.join(root, 'dist/df.test.mjs')).href);
execSync(
  `npx esbuild "${path.join(root, 'src/tools/project/project-transport.ts')}" --bundle --platform=node ` +
    `--format=esm --outfile="${path.join(root, 'dist/pt2.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const { readProjectFiles, writeProjectDocument } = await import(
  pathToFileURL(path.join(root, 'dist/pt2.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const project = (css) => writeProjectDocument(new Map([
  ['src/main.tsx', "import App from './App';"],
  ['src/styles/globals.css', css],
  ['src/screens/List.tsx', 'export default function List() { return null }'],
]));

/** Facts with nothing wrong in them. */
const clean = { contrast: [], smallFields: [], screens: [], deadNav: [], deadActions: [] };
const fault = (fg, bg, ratio, required = 4.5, overImage = false) =>
  ({ text: 'ラベル', fg, bg, ratio, required, overImage });

// --- nothing to do -------------------------------------------------------------
{
  const doc = project(':root { --ink: #111111 }');
  const out = applyDeterministicFixes(doc, clean);
  check('a clean run changes nothing', out.html === doc, true);
  check('and claims nothing', out.fixed, []);
}

// --- contrast: the colour is computed, not chosen -------------------------------
{
  // #999999 on white is 2.85:1. The pass must move it far enough to clear 4.5.
  const doc = project(':root { --muted: #999999 }\n.label { color: var(--muted) }');
  const out = applyDeterministicFixes(doc, {
    ...clean,
    contrast: [fault('rgb(153, 153, 153)', 'rgb(255, 255, 255)', 2.85)],
  });
  check('the contrast defect is settled', out.fixed, ['contrast-low']);
  const css = readProjectFiles(out.html).get('src/styles/globals.css');
  check('the failing colour is gone', css.includes('#999999'), false);
  check('and the token still exists', /--muted:\s*#[0-9a-f]{6}/i.test(css), true);
  check('nothing else was touched',
    readProjectFiles(out.html).get('src/screens/List.tsx'),
    readProjectFiles(doc).get('src/screens/List.tsx'));

  // The claim of this whole pass is that a computed colour clears the bar where
  // a chosen one might. So the replacement is measured, not trusted.
  const hex = /--muted:\s*#([0-9a-f]{6})/i.exec(css)[1];
  const chan = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const lum = (h) => {
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
  };
  const ratio = (lum('ffffff') + 0.05) / (lum(hex) + 0.05);
  check(`the replacement actually clears 4.5:1 (measured ${ratio.toFixed(2)})`, ratio >= 4.5, true);
}

// --- contrast: the cases it must refuse -----------------------------------------
{
  // The v205 case: the colour is written into components and there is no token.
  // Creating one is a repair this pass cannot make, so it must not claim it.
  const doc = project(':root { --ink: #111111 }');
  const out = applyDeterministicFixes(doc, {
    ...clean,
    contrast: [fault('rgb(153, 153, 153)', 'rgb(255, 255, 255)', 2.85)],
  });
  check('a colour that is not in the stylesheet is left alone', out.fixed, []);
  check('and the document is unchanged', out.html === doc, true);
}
{
  // Text over a photograph: the measured ratio is against whatever opaque colour
  // the walk found, which is not what the reader sees.
  const doc = project(':root { --muted: #999999 }');
  const out = applyDeterministicFixes(doc, {
    ...clean,
    contrast: [fault('rgb(153, 153, 153)', 'rgb(255, 255, 255)', 2.85, 4.5, true)],
  });
  check('a fault over an image is not touched', out.fixed, []);
}
{
  // Two faults, one addressable. Claiming the defect closed would hand the
  // repair loop a shorter list than the document deserves.
  const doc = project(':root { --muted: #999999 }');
  const out = applyDeterministicFixes(doc, {
    ...clean,
    contrast: [
      fault('rgb(153, 153, 153)', 'rgb(255, 255, 255)', 2.85),
      fault('rgb(170, 170, 170)', 'rgb(255, 255, 255)', 2.32),
    ],
  });
  check('a partial fix does not close the defect', out.fixed.includes('contrast-low'), false);
}

// --- form controls ---------------------------------------------------------------
{
  const doc = project('.btn { color: red }');
  const out = applyDeterministicFixes(doc, {
    ...clean,
    smallFields: [{ screen: 'list', label: '検索', tag: 'input', height: 24, fontSize: 12 }],
  });
  check('small fields are settled', out.fixed, ['input-small']);
  const css = readProjectFiles(out.html).get('src/styles/globals.css');
  check('the rule sets the measured floor',
    [/min-height:\s*40px/.test(css), /font-size:\s*16px/.test(css)], [true, true]);
  check('and the existing rules survive', css.includes('.btn { color: red }'), true);

  // Applied twice — the second pass must not append it again.
  const again = applyDeterministicFixes(out.html, {
    ...clean,
    smallFields: [{ screen: 'list', label: '検索', tag: 'input', height: 24, fontSize: 12 }],
  });
  check('it is not appended twice', again.fixed, []);
}

// --- a document with no stylesheet -----------------------------------------------
check('a legacy page is left to the model',
  applyDeterministicFixes('<html><body>hi</body></html>', {
    ...clean, smallFields: [{ screen: 'a', label: 'b', tag: 'input', height: 24, fontSize: 12 }],
  }).fixed, []);

// --- icons with no size ------------------------------------------------------------------
{
  const doc = project('.card { padding: 8px }');
  const out = applyDeterministicFixes(doc, { ...clean, oversizedIcons: ['div.empty > svg 368x368px'] });
  const css = readProjectFiles(out.html).get('src/styles/globals.css');
  check('an oversized icon is settled without a model', out.fixed, ['icon-oversized']);
  check('by a zero-specificity default, so a class that sizes an icon still wins', /:where\(svg\[viewBox="0 0 16 16"\]:not\(\[width\]\):not\(\[height\]\)/.test(css) && /width: 1\.25em;/.test(css), true);
  check('only for the small grids icons are drawn on', css.includes('viewBox="0 0 400'), false);
  const again = applyDeterministicFixes(out.html, { ...clean, oversizedIcons: ['div.empty > svg 368x368px'] });
  check('added once', readProjectFiles(again.html).get('src/styles/globals.css').split('unsized icons').length - 1, 1);
  const both = applyDeterministicFixes(doc, { ...clean, oversizedIcons: ['x'], smallFields: [{ label: 'q', tag: 'input', height: 30, fontSize: 13 }] });
  check('and it does not stop the form-control rule from being added', both.fixed.sort(), ['icon-oversized', 'input-small']);
}

// --- screens hidden by a cause with one answer --------------------------------------------------
{
  const hiddenFacts = (pairs) => ({ ...clean, screens: pairs.map(([id, hiddenBy]) => ({ id, fill: 0, emptyBoxes: [], reachable: true, broken: [], hiddenBy })) });
  const projectOf = (files) => writeProjectDocument(new Map([['src/main.tsx', "import App from './App';"], ...Object.entries(files)]));

  // The carbon run of 2026-09-14: the toggle class the shared Screen component never set.
  const toggle = projectOf({
    'src/styles/globals.css': '.screen { display: none; }\n.screen.is-active { display: flex; }',
    'src/components/ui/Screen.tsx': 'export default function Screen({ className = "", children }) { return <div className={`screen ${className}`}>{children}</div> }',
    'src/screens/Products.tsx': 'export default function Products() { return <div className="screen is-active">x</div> }',
    'src/screens/Dashboard.tsx': "import Screen from '../components/ui/Screen'\nexport default function Dashboard() { return <Screen>y</Screen> }",
  });
  const t = revealHiddenScreens(toggle, hiddenFacts([['dashboard', 'div.screen { display: none }']]));
  check('a toggle class nothing sets is added where the class appears without it', readProjectFiles(t.html).get('src/components/ui/Screen.tsx').includes('`screen is-active ${className}`'), true);
  check('and the defect is settled', t.fixed, ['screen-hidden']);
  check('a literal that already has both is untouched', readProjectFiles(t.html).get('src/screens/Products.tsx').includes('"screen is-active"'), true);
  check('it runs as part of the deterministic fixes', applyDeterministicFixes(toggle, hiddenFacts([['dashboard', 'div.screen { display: none }']])).fixed.includes('screen-hidden'), true);

  const noEvidence = projectOf({
    'src/styles/globals.css': '.screen { display: none; }\n.screen.is-active { display: flex; }',
    'src/screens/Dashboard.tsx': 'export default function Dashboard({ on }) { return <div className="screen">y</div> }',
  });
  check('without the project writing the pair anywhere, nothing is guessed', revealHiddenScreens(noEvidence, hiddenFacts([['dashboard', 'div.screen { display: none }']])).fixed, []);
  const conditional = projectOf({
    'src/styles/globals.css': '.screen { display: none; }\n.screen.is-active { display: flex; }',
    'src/screens/A.tsx': 'export default function A() { return <div className="screen is-active">a</div> }',
    'src/screens/B.tsx': "export default function B({ on }) { return <div className={on ? 'screen is-active' : 'screen'}>b</div> }",
  });
  check('a conditional class expression is left to its condition',
    readProjectFiles(revealHiddenScreens(conditional, hiddenFacts([['b', 'div.screen { display: none }']])).html).get('src/screens/B.tsx').includes("on ? 'screen is-active' : 'screen'"), true);

  // The material3 run of the same day: a routed screen that is a closed <dialog>.
  const dialog = projectOf({
    'src/styles/globals.css': 'dialog { display: none; }\ndialog[open] { display: block; }',
    'src/screens/Form.tsx': 'export default function Form({ r }) { return <dialog ref={r} className="screen is-active">form</dialog> }',
  });
  const d = revealHiddenScreens(dialog, hiddenFacts([['form', 'dialog.screen.is-active { display: none }']]));
  const dcss = readProjectFiles(d.html).get('src/styles/globals.css');
  check('a closed dialog screen is shown in the page flow', /dialog\.screen\.is-active:not\(\[open\]\) \{\s*display: block;/.test(dcss), true);
  check('which outranks the stylesheet\'s own dialog rule', dcss.indexOf(':not([open])') > dcss.indexOf('dialog { display: none; }'), true);
  check('and settles the defect', d.fixed, ['screen-hidden']);
  check('a dialog with no class to aim at is not claimed', revealHiddenScreens(dialog, hiddenFacts([['form', 'dialog { display: none }']])).fixed, []);
  check('an empty content region is not a cause this fixes', revealHiddenScreens(dialog, hiddenFacts([['form', 'empty']])).html, dialog);
  check('partly addressed is not claimed',
    revealHiddenScreens(toggle, hiddenFacts([['dashboard', 'div.screen { display: none }'], ['x', 'section { visibility: hidden }']])).fixed, []);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
