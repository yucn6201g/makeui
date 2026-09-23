// What an edit broke on a working storefront, 2026-09-18.
//
// The user asked 「商品をクリックしても何も起きません」. The model, asked for
// SEARCH/REPLACE blocks, chose to return the whole screen instead — which the
// rules allow for a change that rewrites most of a file — and in rewriting it
// replaced `<ProductCard :product="product" />` with markup of its own. Two
// defects came with the new markup, and neither the compiler nor any audit on
// the edit path could see either:
//
//   <img :src="product.imageUrl" />        Product declares `image`. The binding
//                                          is undefined, so every picture is
//                                          blank — reported as 「画像が表示され
//                                          なくなりました」.
//
//   navigate(`product/${productId}`)       `navigate`'s string branch is
//                                          `updateRoute({ screen: next })`, so
//                                          the screen becomes 「product/p1」,
//                                          nothing matches it, and the detail
//                                          screen reads `route.params.id` off a
//                                          route with no params — reported as
//                                          「実行時エラーが出る」.
//
// Both compile. A template expression is never type-checked, and `ScreenId` is
// a union of strings, which a template literal satisfies.
//
//   node test/edit-damage-fixups.test.mjs      (from backend/)
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist/edf.test.mjs');
await esbuild.build({
  entryPoints: [path.join(root, 'src/tools/framework-fixups.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile: out,
  external: ['@aws-sdk/*', '@smithy/*'], logLevel: 'error',
});
const { fixImageFieldMisspelt, fixPathAsScreenId } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// The project's own shapes, from the document that shipped.
const DATA = `export interface Product {
  id: string
  name: string
  price: number
  category: 'tops' | 'bottoms'
  sizes: Array<{ size: string; inStock: boolean }>
  image: string
}

export const PRODUCTS: Product[] = []`;

const ROUTES = `export type ScreenId = 'products' | 'product' | 'cart'

export interface Route {
  screen: ScreenId
  params?: Record<string, string>
}`;

const SCREEN = `<template>
  <article
    v-for="product in filteredProducts"
    :key="product.id"
    :data-goto="\`product/\${product.id}\`"
    @click="handleProductClick(product.id)"
  >
    <img
      :src="product.imageUrl"
      :alt="product.name"
      class="product-card__image"
    />
    <h2>{{ product.name }}</h2>
  </article>
</template>

<script setup lang="ts">
import { useNavigation } from '../composables/useNavigation'
const { navigate } = useNavigation()

function handleProductClick(productId: string): void {
  navigate(\`product/\${productId}\`)
}
</script>`;

const project = (screen = SCREEN, routes = ROUTES) =>
  new Map([
    ['src/data/products.ts', DATA],
    ['src/routes.ts', routes],
    ['src/screens/ProductsScreen.vue', screen],
  ]);

// --- the picture ---------------------------------------------------------------
{
  const r = fixImageFieldMisspelt(project());
  const body = r.files.get('src/screens/ProductsScreen.vue') ?? '';
  check('a src reading a field the data has not got is corrected', /:src="product\.image"/.test(body), true);
  check('and the wrong name is gone', /imageUrl/.test(body), false);
  check('the alt beside it is untouched', /:alt="product\.name"/.test(body), true);
  check('it says what it did', r.fixed.length, 1);
}

// The name has to be declared nowhere and have exactly one candidate.
check('a field the data does declare is left alone',
  fixImageFieldMisspelt(project(SCREEN.replace('product.imageUrl', 'product.image'))).fixed, []);
check('a name with no near match is left alone',
  fixImageFieldMisspelt(project(SCREEN.replace('product.imageUrl', 'product.photograph'))).fixed, []);
// A short field name is not evidence: three letters match too much to act on.
{
  const shortField = DATA.replace('  image: string', '  img: string');
  const files = project(SCREEN.replace('product.imageUrl', 'product.imgSource'));
  files.set('src/data/products.ts', shortField);
  check('a three-letter field is too short to match on', fixImageFieldMisspelt(files).fixed, []);
}
// Only pictures: the same rule over expressions generally would rewrite a
// legitimate computed whose name happens to start with a field — `cartTotal`
// to `cart`. So a bad field anywhere else is left exactly as it is.
{
  const fine = SCREEN.replace('product.imageUrl', 'product.image').replace('{{ product.name }}', '{{ product.nameLabel }}');
  const r = fixImageFieldMisspelt(project(fine));
  check('an expression that is not a picture source is left alone', r.fixed, []);
}
check('JSX is read too', fixImageFieldMisspelt(new Map([
  ['src/data/products.ts', DATA],
  ['src/screens/List.tsx', 'export default () => <img src={product.imageUrl} />;'],
])).fixed.length, 1);

// --- the route ------------------------------------------------------------------
{
  const r = fixPathAsScreenId(project());
  const body = r.files.get('src/screens/ProductsScreen.vue') ?? '';
  check('a path passed as a screen id becomes a screen and an id',
    /navigate\(\{ screen: 'product', params: \{ id: String\(productId\) \} \}\)/.test(body), true);
  check('the data-goto attribute, which is a path by design, is untouched',
    /:data-goto="`product\/\$\{product\.id\}`"/.test(body), true);
  check('it says what it did', r.fixed.length, 1);
}
check('the concatenated spelling is caught too',
  /navigate\(\{ screen: 'product', params: \{ id: String\(id\) \} \}\)/.test(
    fixPathAsScreenId(project(SCREEN.replace('navigate(`product/${productId}`)', "navigate('product/' + id)")))
      .files.get('src/screens/ProductsScreen.vue') ?? ''), true);
check('a plain screen name is not a path', fixPathAsScreenId(
  project(SCREEN.replace('navigate(`product/${productId}`)', "navigate('cart')"))).fixed, []);
// Without params in the router this is not the shape being asked for.
check('a router with no params is left alone',
  fixPathAsScreenId(project(SCREEN, ROUTES.replace('  params?: Record<string, string>\n', ''))).fixed, []);
check('a router that spells params as an object is read too',
  fixPathAsScreenId(project(SCREEN, ROUTES.replace('params?: Record<string, string>', 'params?: { id: string }'))).fixed.length, 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
