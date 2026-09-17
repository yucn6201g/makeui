/**
 * The missing modules written without a model call.
 *
 * Measured from 30 days of runtime logs: 344 unresolved import specs, of which
 * 307 are relative (a file the project should have contained) and 177 of those
 * name a leaf graphic — `EmptyStateIllustration` 55 times, `EmptyCartIcon` 16,
 * then chevrons, checks, carts and placeholders. Against that, 339 file repairs
 * were reverted for a dangling import and only 100 modules were written. So the
 * ask goes out, and two times in three the answer does not come back usable.
 *
 * Every name in the fixture below is a real one from that log. The point of the
 * test is not that a stub exists — it is that the stub is the RIGHT one: a back
 * arrow that renders a grey square is a screen the user cannot leave, and the
 * check that a file was written would call that a success.
 *
 *   node test/leaf-modules.test.mjs      (from backend/)
 */
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist/leaf-modules.test.mjs');
fs.mkdirSync(path.dirname(out), { recursive: true });
/*
 * `parses` comes along, because it is the gate the drawn file has to pass.
 *
 * `writeMissing` skips anything that does not parse — so a stub the real
 * compiler rejects is not a broken drawing, it is silently no drawing at all,
 * and every other assertion in this file would still be green.
 */
const entry = path.join(root, 'dist/leaf-modules.test-entry.ts');
fs.writeFileSync(entry, [
  "export { leafModule, importShape } from '../src/orchestration/leaf-modules.js'",
  "export { parses } from '../src/orchestration/repair-files.js'",
].join('\n'));
await esbuild.build({
  entryPoints: [entry],
  bundle: true, platform: 'node', format: 'esm', outfile: out,
  external: ['@aws-sdk/*', '@smithy/*', '@strands-agents/*'],
});
const { leafModule, importShape, parses } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const importer = (spec, clause = 'Thing') => `import ${clause} from '${spec}';\n\nexport default function Screen() { return null; }\n`;
const react = (p, spec = './x', clause = 'Thing') => leafModule(p, 'react', importer(spec, clause), spec);

// --- what is a leaf, and what is not -------------------------------------
check('an icon is written here', typeof react('src/components/icons/BackIcon.tsx'), 'string');
check('so is an illustration', typeof react('src/components/illustrations/EmptyStateIllustration.tsx'), 'string');
check('and a placeholder', typeof react('src/components/ProductImagePlaceholder.tsx'), 'string');
check('and a wordmark', typeof react('src/components/ProductWordmark.tsx'), 'string');

// The important half. A stub for one of these renders a screen that does
// nothing, and nothing downstream calls that a failure.
check('a store is not', react('src/store/cart.ts'), null);
check('a hook is not', react('src/hooks/useNavigate.ts'), null);
check('a screen is not', react('src/screens/ContactScreen.tsx'), null);
check('a modal is not', react('src/components/ConfirmModal.tsx'), null);
check('a button is not', react('src/components/ui/SecondaryButton.tsx'), null);
// `imageUrl.ts` ends in a leaf word but is not a component, and the extension
// is how the project says so.
check('a .ts module is not, whatever it is called', react('src/utils/productImage.ts'), null);

// --- the glyph is the one the name asked for -----------------------------
// A chevron pointing the wrong way is a defect the file-was-written check
// cannot see, so each direction is pinned.
const d = (p) => (react(p).match(/d="([^"]*)"/) ?? [])[1];
check('a left chevron points left', d('src/components/icons/ChevronLeftIcon.tsx'), 'M15 6l-6 6 6 6');
check('a right chevron points right', d('src/components/icons/ChevronRightIcon.tsx'), 'M9 6l6 6-6 6');
check('a down chevron points down', d('src/components/icons/ChevronDownIcon.tsx'), 'M6 9l6 6 6-6');
// `back` and a bare `chevron` both fall to the left arm, which is what every
// corpus use of them means.
check('BackIcon is an arrow, not a square', d('src/components/icons/BackIcon.tsx'), 'M15 6l-6 6 6 6');
check('and so is a bare ChevronIcon', d('src/components/icons/ChevronIcon.tsx'), 'M15 6l-6 6 6 6');
// Order in the table, not luck: CheckCircle must not be read as a check, and
// `download` must not be read as `arrow-down`.
check('CheckCircleIcon is the circled one',
  d('src/components/icons/CheckCircleIcon.tsx').startsWith('M4 12a8 8 0 1 0 16 0'), true);
check('CheckIcon is the plain one', d('src/components/icons/CheckIcon.tsx'), 'M4 12l5 5L20 6');
check('DownloadIcon is not an arrow-down', d('src/components/icons/DownloadIcon.tsx'), 'M12 4v10M8 11l4 4 4-4M5 20h14');
check('SuccessIcon is a check', d('src/components/icons/SuccessIcon.tsx').includes('M8 12l3 3 5-6'), true);
check('XIcon is a cross', d('src/components/icons/XIcon.tsx'), 'M6 6l12 12M18 6L6 18');
check('a name nothing matches gets a neutral mark', d('src/components/icons/BudgetIcon.tsx') !== 'M5 5h14v14H5z', true);
check('and one that really matches nothing gets the square',
  d('src/components/icons/ZorblattIcon.tsx'), 'M5 5h14v14H5z');

// --- scenes are drawn at scene size --------------------------------------
const icon = react('src/components/icons/CartIcon.tsx');
const scene = react('src/components/illustrations/EmptyCartIllustration.tsx');
check('an icon is 24 square', icon.includes('viewBox="0 0 24 24"'), true);
check('an illustration is not', scene.includes('viewBox="0 0 160 120"'), true);
check('an icon defaults to 24', icon.includes('size = 24'), true);
check('an illustration defaults to 160', scene.includes('size = 160'), true);
// A caller that sets only `size` must not get a squashed drawing.
check('and keeps its proportions', scene.includes('size * 0.75'), true);
check('an empty cart is drawn as a cart', scene.includes('M46 44h68'), true);
check('an empty state with no subject gets the neutral scene',
  react('src/components/illustrations/EmptyStateIllustration.tsx').includes('M32 30h96v64H32z'), true);

// --- the export shape the importer asked for -----------------------------
check('a default import gets a default export',
  react('src/components/icons/CartIcon.tsx', '../icons/CartIcon', 'CartIcon').includes('export default CartIcon;'), true);
const named = react('src/components/icons/CartIcon.tsx', '../icons/CartIcon', '{ CartIcon }');
check('a named import gets the named export', named.includes('export function CartIcon('), true);
// A module imported only by name does not need a default, but one is harmless
// and its absence is another revert — so it is written either way.
check('and one for the file name too', named.includes('export default CartIcon;'), true);
const two = react('src/components/icons/CartIcon.tsx', '../icons/CartIcon', '{ CartIcon, EmptyBagIcon }');
check('a second name asked for is aliased to the same drawing',
  two.includes('export const EmptyBagIcon = CartIcon;'), true);
check('and the drawing itself is written once', (two.match(/export function/g) ?? []).length, 1);
// The importer is what says which shape; an unreadable one must still produce
// a file rather than nothing.
check('an unparseable importer still gets a default export',
  react('src/components/icons/CartIcon.tsx', '../icons/CartIcon', '').includes('export default CartIcon;'), true);

check('importShape reads a default', importShape("import Cart from './a';", './a'), { def: 'Cart', named: [] });
check('and a named list', importShape("import { A, B } from './a';", './a'), { def: null, named: ['A', 'B'] });
check('and both', importShape("import C, { A } from './a';", './a'), { def: 'C', named: ['A'] });
check('and an alias by its source name', importShape("import { A as B } from './a';", './a'), { def: null, named: ['A'] });
// The spec goes into a RegExp; a relative one is full of characters that mean
// something there.
check('a relative spec is not read as a pattern',
  importShape("import X from '../icons/BackIcon';", '../icons/BackIcon'), { def: 'X', named: [] });
check('a spec the importer does not have', importShape("import X from './b';", './a'), null);

// --- the other two frameworks --------------------------------------------
const vue = leafModule('src/components/icons/BackIcon.vue', 'vue', importer('../icons/BackIcon'), '../icons/BackIcon');
check('Vue gets a single-file component', vue.startsWith('<script setup lang="ts">'), true);
check('with a template, not JSX', vue.includes('<template>') && !vue.includes('return ('), true);
check('and props declared the way the project declares them', vue.includes('defineProps<'), true);
check('a .tsx path is not written on a Vue project',
  leafModule('src/components/icons/BackIcon.tsx', 'vue', importer('./x'), './x'), null);

const sv = leafModule('src/components/icons/BackIcon.svelte', 'svelte', importer('../icons/BackIcon'), '../icons/BackIcon');
check('Svelte gets a component', sv.includes('<svg'), true);
// `export let` in a file the compiler reads as runes is a compile error, and
// the project is Svelte 5 throughout.
check('with runes, not export let', sv.includes('$props()') && !sv.includes('export let'), true);
check('and stroke-width, not strokeWidth', sv.includes('stroke-width=') && !sv.includes('strokeWidth'), true);
check('React uses strokeWidth', icon.includes('strokeWidth='), true);

// --- every one of them parses --------------------------------------------
// The whole point is that these never come back broken. Run the real corpus
// names through the real parser rather than trusting the three sampled above.
const CORPUS = [
  'EmptyStateIllustration', 'EmptyCartIcon', 'EmptyCartIllustration', 'EmptyStateIcon',
  'ProductWordmark', 'ChevronLeftIcon', 'CheckIcon', 'ChevronIcon', 'BackIcon', 'HomeIcon',
  'ContentFrameIllustration', 'CalendarIcon', 'SuccessIcon', 'ProductImagePlaceholder',
  'CartIcon', 'ChevronRightIcon', 'SearchIcon', 'CheckmarkIcon', 'PatternIllustration',
  'EmptySearchIllustration', 'WordmarkIllustration', 'EmptyBagIcon', 'UserIcon', 'TrashIcon',
  'CheckCircleIcon', 'PlusIcon', 'InventoryIcon', 'ClipboardLineIcon', 'AlertIcon', 'EmptyIcon',
  'HeroBannerIllustration', 'BlankSlateIcon', 'EmptyIllustration', 'ProductWordmarkIcon',
  'EmptyRackIcon', 'PendingIcon', 'EmptyListIcon', 'ProductPlaceholder', 'ContractIllustration',
  'ChartIllustration', 'EmptyDocumentIllustration', 'RequiredIcon', 'XIcon', 'ContentFrameIcon',
  'ChartLineIllustration', 'EmptyLineIcon', 'ImagePlaceholderIcon', 'ProductImageIllustration',
  'EmptyFavoritesIllustration', 'FileIcon', 'EmptyCalendarIllustration', 'DownloadIcon',
  'ChevronDownIcon', 'ErrorIllustration', 'BudgetIcon', 'ImageIcon', 'CalendarIllustration',
  'PackageIcon', 'HomeEmptyIcon', 'EmptyStateIcon',
];
const EXT = { react: '.tsx', vue: '.vue', svelte: '.svelte' };
const unwritten = [];
const broken = [];
const rejected = [];
for (const kind of ['react', 'vue', 'svelte']) {
  for (const name of CORPUS) {
    const p = `src/components/illustrations/${name}${EXT[kind]}`;
    const spec = `../components/illustrations/${name}`;
    const body = leafModule(p, kind, importer(spec, name), spec);
    if (!body) { unwritten.push(`${kind} ${name}`); continue; }
    // Balanced markup and a path that is actually drawn — the two ways a
    // generated <svg> comes back looking fine and rendering nothing.
    const opens = (body.match(/<svg\b/g) ?? []).length;
    const closes = (body.match(/<\/svg>/g) ?? []).length;
    const drawn = /d="M[^"]{6,}"/.test(body);
    if (opens !== 1 || closes !== 1 || !drawn) broken.push(`${kind} ${name}`);
    const err = parses(p, body);
    if (err) rejected.push(`${kind} ${name}: ${err.slice(0, 90)}`);
  }
}
check('every name in the corpus is written, on every framework', unwritten, []);
check('and every one of them draws something inside one svg', broken, []);
// The gate `writeMissing` actually applies. A stub the compiler rejects is not
// a bad drawing — it is no drawing, silently, and the revert comes back.
check('and the compiler accepts every one', rejected, []);

// --- the repair calls it, and only for what it covers ---------------------
const repair = fs.readFileSync(path.join(root, 'src/orchestration/repair-files.ts'), 'utf8');
check('writeMissing tries this before the model', /const body = leafModule\(/.test(repair), true);
// A drawing that does not parse must go to the model like anything else, not
// be spliced in because it came from here.
check('and still checks that what it wrote parses', /if \(parses\(path, body\)\) continue/.test(repair), true);
check('what was drawn is spliced with what was written',
  /\[\.\.\.drawn, \.\.\.\(made/.test(repair), true);
// The batch is capped at six a round; a drawing must not take one of the slots.
check('and is removed from what the model is asked for', /wanted\.delete\(path\)/.test(repair), true);
check('no model call is made when everything was drawn',
  /wanted\.size === 0 \? \[\] : await Promise\.all/.test(repair), true);
// `../icons/CartIcon` has no `components/` segment; without this it was written
// as a .ts file, which cannot hold the markup.
check('a capitalised leaf gets the component extension wherever it sits',
  /icons\|illustrations/.test(repair) && /\[A-Z\]\[A-Za-z0-9\]\*\$/.test(repair), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
