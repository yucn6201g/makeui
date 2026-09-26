// A catalogue whose records carry no picture, given one.
//
// Reported 2026-09-19: 「ReactとVueでECサイトのテンプレートを生成したときに、Vueに
// 比べてReactで生成したときに画像が出る枚数が少なく感じます」. Measured on the stored
// documents, the difference is not in the photograph pass — it is in what the
// build handed it:
//
//   vue    13 records, 13 image fields, 13 photographs
//   react  12 records, `image?: string` declared and set by ONE of them, and
//          the card drawing <div className="product-card__image"><ContentFrame /></div>
//
// `assignItemImages` replaces picture URLs and slots; with neither, it correctly
// does nothing. The type says the picture was intended and the records never got
// one, so this writes the slot the assembler was supposed to write, and the pass
// that resolves it reads each record's own name to decide what to photograph.
//
// Verified end to end on the user's own document: 1 photograph became 12, as
// tshirt / shirt / knitwear / jeans / dress / coat — matched to the garment.
//
//   node test/catalogue-photos.test.mjs      (from backend/)
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { fixupsEntry, readFixups } from './lib/fixups-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist/cp.test.mjs');
await esbuild.build({
  entryPoints: [path.join(root, fixupsEntry())],
  bundle: true, platform: 'node', format: 'esm', outfile: out,
  external: ['@aws-sdk/*', '@smithy/*'], logLevel: 'error',
});
const { fixCatalogueWithoutPhotos } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// The document's own shapes.
const TYPES = `export interface Product {
  id: string;
  name: string;
  price: number;
  sizes: string[];
  stock: Record<string, number>;
  image?: string;
}
`;
const record = (id, name) => `  {
    id: '${id}',
    name: '${name}',
    price: 3500,
    sizes: ['S', 'M'],
    stock: { S: 10, M: 8 },
  },`;
const DATA = `import type { Product } from '../store/types';

export const PRODUCTS: Product[] = [
${record('1', 'コットンTシャツ')}
${record('2', 'ニットセーター')}
${record('3', 'デニムパンツ')}
];
`;
const SCREEN = `export default function ProductsScreen(): JSX.Element {
  return (
    <div className="grid">
      {products.map((product) => (
        <div key={product.id} className="product-card">
          <div className="product-card__image">
            <ContentFrame />
          </div>
          <div className="product-card__name">{product.name}</div>
        </div>
      ))}
    </div>
  );
}`;

const project = (over = {}) => new Map(Object.entries({
  'src/store/types.ts': TYPES,
  'src/data/products.ts': DATA,
  'src/screens/ProductsScreen.tsx': SCREEN,
  ...over,
}));

/**
 * The same screen with nothing on it that names a picture.
 *
 * Used wherever a check has to isolate the FIELD-NAME rule from the frame rule:
 * with the card's own frame present the pass fires either way, because the frame
 * declares the picture the type left out.
 */
const NO_FRAME = SCREEN.replace(
  /<div className="product-card__image">[\s\S]*?<\/div>/,
  '<div className="product-card__body" />'
);

// --- the repair ------------------------------------------------------------------
{
  const r = fixCatalogueWithoutPhotos(project());
  const data = r.files.get('src/data/products.ts') ?? '';
  const screen = r.files.get('src/screens/ProductsScreen.tsx') ?? '';
  const types = r.files.get('src/store/types.ts') ?? '';
  check('every record gets a slot', (data.match(/__PHOTO__/g) ?? []).length, 3);
  // The pass that resolves the slot reads the record's own name, so the slot
  // has to sit inside the record rather than beside the array.
  check('and the slot is inside the record, next to its name',
    /\{\s*\n\s*image: '__PHOTO__',\n\s*id: '1',\n\s*name: 'コットンTシャツ'/.test(data), true);
  check('the frame draws it', /<img src=\{product\.image\} alt=\{product\.name\}/.test(screen), true);
  // Whatever the frame was drawing stays as the other branch, so a project
  // whose illustrations are rendered only here does not lose them.
  check('and keeps what it was drawing as the fallback',
    /\{product\.image \? <img[\s\S]*? : <ContentFrame \/>\}/.test(screen), true);
  /*
   * Left optional, `src={product.image}` is `string | undefined` and `tsc`
   * rejects the project this system exists to hand someone.
   */
  check('the declaration stops being optional', /\bimage: string;/.test(types), true);
  check('it says what it did', r.fixed.length, 1);
}

// --- what it must not touch --------------------------------------------------------
// A record that already has a picture keeps it; only the gaps are filled. ONE of
// the twelve garments had one, which an "all or nothing" rule excluded — and that
// document was the reason this exists.
{
  const withOne = DATA.replace("    name: 'ニットセーター',", "    name: 'ニットセーター',\n    image: 'https://example.com/a.jpg',");
  const r = fixCatalogueWithoutPhotos(project({ 'src/data/products.ts': withOne }));
  const data = r.files.get('src/data/products.ts') ?? '';
  check('a record that has one keeps it', /image: 'https:\/\/example\.com\/a\.jpg'/.test(data), true);
  check('and only the gaps are filled', (data.match(/__PHOTO__/g) ?? []).length, 2);
}
/*
 * A catalogue whose records ALREADY carry their pictures still gets the markup,
 * and that is the 2026-09-20 report: 「画像が一枚も挿入されていません」 on a document
 * holding ELEVEN real photographs in src/data/products.ts and not one <img>
 * anywhere — the card drew `<div className="cds-product-image"><ContentFrame />
 * </div>`. The data was complete, so the first version of this pass had nothing
 * to slot, and it gated the markup on having slotted something. The two halves
 * are independent: fill what is missing, and draw what is there.
 */
{
  const photographed = DATA.replace(/name: '([^']+)',/g, "name: '$1',\n    image: 'x.jpg',");
  const r = fixCatalogueWithoutPhotos(project({ 'src/data/products.ts': photographed }));
  const data = r.files.get('src/data/products.ts') ?? photographed;
  const screen = r.files.get('src/screens/ProductsScreen.tsx') ?? '';
  check('a photographed catalogue still gets its <img>', /<img src=\{product\.image\}/.test(screen), true);
  check('and its data is left exactly as it was', /__PHOTO__/.test(data), false);
  check('the report says which half ran', /描画されていなかった/.test(r.fixed[0] ?? ''), true);
}
// Nothing to do at all when the pictures are already drawn.
check('a catalogue that is photographed AND drawn is left alone',
  fixCatalogueWithoutPhotos(project({
    'src/data/products.ts': DATA.replace(/name: '([^']+)',/g, "name: '$1',\n    image: 'x.jpg',"),
    'src/screens/ProductsScreen.tsx': SCREEN.replace('<ContentFrame />', '<img src={product.image} alt={product.name} />'),
  })).fixed, []);
/*
 * The CARD can say the picture was intended, where the type did not (2026-09-20).
 *
 * This asserted the opposite — "adding a field nobody asked for is a claim
 * about the design, not a repair" — until a user's storefront argued with it.
 * `Product` declared id, name, price, category, colors, sizes, material and
 * dimensions and no picture, while the card drew
 *
 *     <div className="da-card-image" aria-label={`${product.name}の画像`}>
 *       <svg> … a gradient, a dot pattern, a circle and a rectangle
 *
 * The type never asked; the CARD asked, by its class and by the label it reads
 * out. Twelve garments shipped as invented gradients because the rule required
 * the type to be the one asking. Of 76 stored documents, 9 have a catalogue and
 * a picture frame at all, 5 of those have a frame with no picture in it, and 2
 * of the 5 are this shape.
 */
const NO_PICTURE = TYPES.replace('  image?: string;\n', '');
const asked = fixCatalogueWithoutPhotos(project({ 'src/store/types.ts': NO_PICTURE }));
check('a type with no picture field is given one when the card asks', asked.fixed.length > 0, true);
check('the field is declared on the interface',
  /\n  image: string;/.test(asked.files.get('src/store/types.ts') ?? ''), true);
check('beside the name it pictures',
  /name: string;\n  image: string;/.test(asked.files.get('src/store/types.ts') ?? ''), true);
check('every record gets a slot',
  ((asked.files.get('src/data/products.ts') ?? '').match(/__PHOTO__/g) ?? []).length, 3);
check('and the card draws it',
  /<img src=\{product\.image\}/.test(asked.files.get('src/screens/ProductsScreen.tsx') ?? ''), true);
check('and says the type had no picture',
  /型が写真を持っていませんでした/.test(asked.fixed.join('')), true);
// But nothing is claimed when no screen says a picture goes anywhere.
check('a type with no picture field and no frame is left alone',
  fixCatalogueWithoutPhotos(project({
    'src/store/types.ts': NO_PICTURE,
    'src/screens/ProductsScreen.tsx': NO_FRAME,
  })).fixed, []);
// Two records are a pair of examples; a catalogue is what this is for.
check('two records are not a catalogue',
  fixCatalogueWithoutPhotos(project({
    'src/data/products.ts': `import type { Product } from '../store/types';\n\nexport const PRODUCTS: Product[] = [\n${record('1', 'A')}\n${record('2', 'B')}\n];\n`,
  })).fixed, []);
// A slot nothing draws would ship as a broken src.
check('nothing is slotted when nothing would draw it',
  fixCatalogueWithoutPhotos(project({ 'src/screens/ProductsScreen.tsx': SCREEN.replace(/<div className="product-card__image">[\s\S]*?<\/div>/, '') })).fixed, []);
// ...unless the build already wrote the <img> somewhere else.
{
  const detail = 'export default () => <img src={product.image} alt={product.name} />;';
  const r = fixCatalogueWithoutPhotos(project({
    'src/screens/ProductsScreen.tsx': SCREEN.replace(/<div className="product-card__image">[\s\S]*?<\/div>/, ''),
    'src/screens/ProductScreen.tsx': detail,
  }));
  check('a picture drawn on another screen is enough', r.fixed.length, 1);
}
// A skeleton is a loading state, and a loading state has no picture yet.
{
  const withSkeleton = SCREEN.replace('<div className="product-card__image">\n            <ContentFrame />\n          </div>',
    '<div className="skeleton-card__image skeleton"></div>');
  check('a skeleton frame is not a missing picture',
    fixCatalogueWithoutPhotos(project({ 'src/screens/ProductsScreen.tsx': withSkeleton })).fixed, []);
}
/*
 * A frame already drawing a picture is not a frame with a missing one.
 * Widening the child pattern to any childless element let it match an `<img>`,
 * so the repair would have replaced a working picture with its own.
 */
{
  const full = SCREEN.replace('<ContentFrame />', '<img src={product.photo} alt="" />');
  check('a frame that already draws a picture is left alone',
    /<img src=\{product\.image\}/.test(
      fixCatalogueWithoutPhotos(project({ 'src/screens/ProductsScreen.tsx': full })).files.get('src/screens/ProductsScreen.tsx') ?? ''), false);
  check('and the picture it was drawing survives',
    /<img src=\{product\.photo\}/.test(
      fixCatalogueWithoutPhotos(project({ 'src/screens/ProductsScreen.tsx': full })).files.get('src/screens/ProductsScreen.tsx') ?? full), true);
}
// A detail screen holds one record in a local rather than a list binding, and
// was missed for exactly that reason on the reported document.
{
  const detail = `export default function ProductDetailScreen(): JSX.Element {
  const product = PRODUCTS.find((p) => p.id === id);
  return (
    <section>
      <div className="cds-detail-image">
        <div className="cds-image-placeholder" />
      </div>
      <h1>{product.name}</h1>
    </section>
  );
}`;
  const r = fixCatalogueWithoutPhotos(project({ 'src/screens/ProductDetailScreen.tsx': detail }));
  check('a detail screen gets its picture too',
    /<img src=\{product\.image\}/.test(r.files.get('src/screens/ProductDetailScreen.tsx') ?? ''), true);
}

// --- Vue writes the same thing in its own syntax -----------------------------------
{
  const vue = `<template>
  <div class="grid">
    <article v-for="product in products" :key="product.id" class="product-card">
      <div class="product-card__image">
        <ContentFrame />
      </div>
      <h2>{{ product.name }}</h2>
    </article>
  </div>
</template>`;
  const r = fixCatalogueWithoutPhotos(new Map([
    ['src/store/types.ts', TYPES],
    ['src/data/products.ts', DATA],
    ['src/screens/ProductsScreen.vue', vue],
  ]));
  const body = r.files.get('src/screens/ProductsScreen.vue') ?? '';
  check('a Vue template gets a bound src', /<img v-if="product\.image" :src="product\.image" :alt="product\.name"/.test(body), true);
  check('and the fallback is v-else', /<ContentFrame v-else \/>/.test(body), true);
}

// --- the stand-in may be drawn inline -------------------------------------------
/*
 * 「商品一覧画面では商品の画像が表示されていない」. The card drew sixty lines of
 * gradient, dot pattern, circle and rectangle inside `<div className="da-card-image">`
 * — an invented abstract composition, which the IMAGERY contract names as the
 * wrong answer for a catalogue in those words.
 *
 * The frames are read by MATCHING TAGS, not by a regular expression. Widening
 * the old pattern's child to `<X …>[\s\S]*?</X>` looked equivalent and is not:
 * the lazy middle backtracks across siblings, so a self-closing frame followed
 * by the product's info block matched as ONE frame whose child was the info,
 * and the replacement swallowed the name and the price into a ternary. It broke
 * two documents the narrow pattern had correctly left alone.
 */
{
  const inline = SCREEN.replace(
    '<ContentFrame />',
    '<svg viewBox="0 0 200 200">\n              <rect width="200" height="200" fill="url(#g)" />\n              <circle cx="100" cy="80" r="35" />\n            </svg>'
  );
  const r = fixCatalogueWithoutPhotos(project({ 'src/screens/ProductsScreen.tsx': inline }));
  const screen = r.files.get('src/screens/ProductsScreen.tsx') ?? '';
  check('an inline svg stand-in is replaced by the photograph',
    /<div className="product-card__image"><img src=\{product\.image\}/.test(screen), true);
  // No fallback branch for an inline drawing: the branch exists so a COMPONENT
  // drawing the stand-in is still rendered and does not become an unused file,
  // and drawn inline there is no file.
  check('and is not kept as a dead branch', /<circle/.test(screen), false);
  check('the name and the price are untouched',
    /<div className="product-card__name">\{product\.name\}<\/div>/.test(screen), true);
}
{
  // A self-closing frame followed by a sibling: the shape that broke doc21.
  const siblings = SCREEN.replace(
    /<div className="product-card__image">[\s\S]*?<\/div>/,
    '<div className="product-card__image" />'
  );
  const screen = fixCatalogueWithoutPhotos(project({ 'src/screens/ProductsScreen.tsx': siblings }))
    .files.get('src/screens/ProductsScreen.tsx') ?? '';
  check('a self-closing frame gets the picture', /<div className="product-card__image"><img /.test(screen), true);
  check('and its sibling is left where it was',
    /<div className="product-card__name">\{product\.name\}<\/div>/.test(screen), true);
}
{
  // Nested frames — a detail screen wraps a placeholder, both named for a
  // picture. Their edits used to overlap and splice into each other.
  const nested = SCREEN.replace(
    '<ContentFrame />',
    '<div className="cds-image-placeholder" />'
  ).replace('product-card__image', 'cds-detail-image');
  const screen = fixCatalogueWithoutPhotos(project({ 'src/screens/ProductsScreen.tsx': nested }))
    .files.get('src/screens/ProductsScreen.tsx') ?? '';
  check('only the outer of a nested pair is rewritten',
    (screen.match(/<img src=\{product\.image\}/g) ?? []).length, 1);
  check('and the inner one survives as the fallback',
    /<div className="cds-image-placeholder" \/>\}/.test(screen), true);
}

// --- what counts as a picture field ---------------------------------------------
/*
 * The list of exact names missed `thumbnailUrl: string` on an article feed of
 * 2026-09-11 — three photographs in the data and that word appearing nowhere
 * else in the project. A suffix is allowed, and only one that still means
 * "this IS the picture": `imageAlt` and `imageWidth` are about a picture
 * without being one.
 */
for (const [field, want] of [
  ['thumbnailUrl', true], ['imageSrc', true], ['coverImage', true], ['photoUrl', true], ['avatarUrl', true],
  ['imageAlt', false], ['imageWidth', false], ['avatarColor', false],
]) {
  /*
   * Read from WHICH path fired, not from whether anything did.
   *
   * The card's frame now declares a picture the type left out, so with this
   * project's screen the pass fires either way and a bare "did it fire" reads
   * every name as a picture. It cannot be isolated by taking the frame away
   * either: with nothing to draw the field, the pass correctly declines to slot
   * it at all. So the question is whether the type's own field was USED —
   * reported when it was not, in those words.
   */
  const types = TYPES.replace('  image?: string;', `  ${field}: string;`);
  const report = fixCatalogueWithoutPhotos(project({ 'src/store/types.ts': types })).fixed.join('');
  const readAsPicture = report.length > 0 && !/型が写真を持っていませんでした/.test(report);
  check(`${field} ${want ? 'is' : 'is not'} a picture`, readAsPicture, want);
  if (!want) check(`  and ${field} leaves the card to declare one`, /image を宣言/.test(report), true);
}

// --- the wiring ---------------------------------------------------------------------
import fs from 'node:fs';
const src = readFixups();
check('the project pass runs it', src.includes('apply(fixCatalogueWithoutPhotos(files))'), true);
// It has to run before the photograph pass, which is what turns a slot into a
// picture. `fixupProject` after the build; `assignItemImages` in finalising.
const graph = fs.readFileSync(path.join(root, 'src/orchestration/generate/graph.ts'), 'utf8');
check('and the photograph pass runs after the build fixups',
  graph.indexOf('const fixups = fixupProject(finalHtml, outputKind)') < graph.indexOf('await assignItemImages(finalHtml'), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
