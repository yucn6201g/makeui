// Two defects a user hit on one generated apparel storefront (2026-09-18,
// 仕上げ / Haiku / Spindle / React), neither of which any check could see:
//
//   1. every product card drew a grey box with the word 「商品画像」 in it, and the
//      page shipped with no photograph anywhere — the data carried
//      `image: 'women-clothes-1'`, a name nobody can resolve, and the card did
//      not render it at all;
//   2. tapping any product opened 「商品が見つかりません」 and nothing could be
//      added to the cart — the list dispatched the id into the store and
//      navigated without it, while the detail screen read it from the route.
//
// Both compile, render and pass every audit. The fixtures below are that
// document's own shapes.
//
//   node test/card-and-detail-fixups.test.mjs      (from backend/)
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { fixupsEntry } from './lib/fixups-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist/cdf.test.mjs');
await esbuild.build({
  entryPoints: [path.join(root, fixupsEntry())],
  bundle: true, platform: 'node', format: 'esm', outfile: out,
  external: ['@aws-sdk/*', '@smithy/*'], logLevel: 'error',
});
const { fixPlaceholderImageBoxes, fixDetailIdNotPassed } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const TYPES = `export interface Product {
  id: string;
  name: string;
  price: number;
  image: string;
  sizes: string[];
}
`;

const CARD = `import React from 'react';
import type { Product } from '../../store/types';

interface ProductCardProps {
  product: Product;
  onSelect: () => void;
}

export default function ProductCard({ product, onSelect }: ProductCardProps) {
  return (
    <button className="card" onClick={onSelect}>
      <div className="card-image" style={{ backgroundColor: 'var(--color-surface-secondary)' }}>
        <span style={{ fontSize: '14px' }}>商品画像</span>
      </div>
      <div className="card-content">
        <div className="card-title">{product.name}</div>
      </div>
    </button>
  );
}
`;

// --- the card draws the picture it was given -------------------------------
{
  const files = new Map([['src/store/types.ts', TYPES], ['src/components/ui/ProductCard.tsx', CARD]]);
  const r = fixPlaceholderImageBoxes(files);
  const card = r.files.get('src/components/ui/ProductCard.tsx');
  check('the placeholder word is gone', /商品画像/.test(card), false);
  check('an img is rendered from the item\'s own field',
    /<img src=\{product\.image\} alt=\{product\.name\}/.test(card), true);
  check('it fills the frame rather than deciding its own size',
    /objectFit: 'cover'/.test(card), true);
  check('the frame itself is kept', /className="card-image"/.test(card), true);
  check('and it says what it did', r.fixed.length, 1);
}

// A caption that happens to read 「画像」 is not a picture frame.
{
  const caption = `export default function Row({ product }: { product: Product }) {
  return (<figure><figcaption className="row-caption">画像</figcaption></figure>);
}`;
  const files = new Map([['src/store/types.ts', TYPES], ['src/Row.tsx', caption]]);
  check('a caption outside a picture frame is left alone', fixPlaceholderImageBoxes(files).fixed, []);
}

// Without a type that carries a picture there is nothing to render, and a made-up
// src is worse than the grey box.
{
  const files = new Map([['src/store/types.ts', 'export interface Product { id: string; name: string }'],
    ['src/components/ui/ProductCard.tsx', CARD]]);
  check('no image field means no rewrite', fixPlaceholderImageBoxes(files).fixed, []);
}

// --- the id reaches the detail screen ---------------------------------------
const NAV = `export function useNavigation() {
  const navigate = useCallback((next?: Route | ScreenId) => {
    const newRoute = typeof next === 'string' ? { screen: next } : next || DEFAULT_ROUTE;
    window.location.hash = toHash(newRoute);
  }, []);
  return { route, navigate, back, canGoBack };
}
`;
const SHELL = `export default function App() {
  const renderScreen = () => {
    switch (route.screen) {
      case 'products':
        return <ProductsScreen />;
      case 'product-detail':
        return <ProductDetailScreen productId={route.params?.id} />;
      case 'cart':
        return <CartScreen />;
    }
  };
}
`;
const LIST = `export default function ProductsScreen() {
  return (
    <div className="grid">
      {sorted.map(product => (
        <ProductCard
          key={product.id}
          product={product}
          onSelect={() => {
            dispatch({ type: 'SELECT_PRODUCT', payload: product.id });
            navigate('product-detail');
          }}
        />
      ))}
    </div>
  );
}
`;
{
  const files = new Map([
    ['src/hooks/useNavigation.ts', NAV], ['src/App.tsx', SHELL], ['src/screens/ProductsScreen.tsx', LIST],
  ]);
  const r = fixDetailIdNotPassed(files);
  const list = r.files.get('src/screens/ProductsScreen.tsx');
  check('the id the handler already knows is put on the route',
    /navigate\(\{ screen: 'product-detail', params: \{ id: String\(product\.id\) \} \}\)/.test(list), true);
  check('the dispatch beside it is untouched', /SELECT_PRODUCT', payload: product\.id/.test(list), true);
  check('and it says what it did', r.fixed.length, 1);
}

// A screen that is branched on but takes no id is not this defect.
{
  const files = new Map([['src/hooks/useNavigation.ts', NAV], ['src/App.tsx', SHELL],
    ['src/screens/X.tsx', `<button onClick={() => navigate('cart')}>カート</button>`]]);
  check('navigation to a screen that needs no id is left alone', fixDetailIdNotPassed(files).fixed, []);
}

// A call that already carries the id is already correct.
{
  const already = `onClick={() => navigate({ screen: 'product-detail', params: { id: product.id } })}`;
  const files = new Map([['src/hooks/useNavigation.ts', NAV], ['src/App.tsx', SHELL], ['src/screens/P.tsx', already]]);
  check('a call that already passes the id is not touched', fixDetailIdNotPassed(files).fixed, []);
}

// With nothing nearby that names the row, a wrong id would be worse than none.
{
  const blind = `<button onClick={() => navigate('product-detail')}>詳細</button>`;
  const files = new Map([['src/hooks/useNavigation.ts', NAV], ['src/App.tsx', SHELL], ['src/screens/P.tsx', blind]]);
  check('no id in reach means no guess', fixDetailIdNotPassed(files).fixed, []);
}

// A project whose navigate takes (screen, params) is repaired in its own shape.
{
  const twoArg = `export function useNavigation() {
  function navigate(screen: ScreenId, params?: Record<string, string>) { window.location.hash = toHash(screen, params); }
  return { route, navigate };
}`;
  const files = new Map([['src/hooks/useNavigation.ts', twoArg], ['src/App.tsx', SHELL], ['src/screens/ProductsScreen.tsx', LIST]]);
  const list = fixDetailIdNotPassed(files).files.get('src/screens/ProductsScreen.tsx');
  check('two-argument navigate gets two arguments',
    /navigate\('product-detail', \{ id: String\(product\.id\) \} \)|navigate\('product-detail', \{ id: String\(product\.id\) \}\)/.test(list), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
