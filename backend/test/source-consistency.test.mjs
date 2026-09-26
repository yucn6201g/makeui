// Three generated defects that compile and render and are wrong — reported
// 2026-09-24 on three templates, and found again across the stored outputs:
//
//   予約システム  the empty-state drawing on 予約確認・変更 was 1152px across
//   在庫管理 + ログイン  the login dispatched AUTH_LOGIN_SUCCESS, the reducer
//                 handled LOGIN_SUCCESS: signing in did nothing
//   ECサイト  every product card showed the same photograph
//
// Each fixture below is the shape the reported document had, cut down.
//
//   node test/source-consistency.test.mjs      (from backend/)
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { fixupsEntry, readFixups } from './lib/fixups-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = async (entry, out) => {
  await esbuild.build({
    entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'esm',
    outfile: path.join(root, out), external: ['@aws-sdk/*', '@smithy/*'], logLevel: 'error',
  });
  return import(pathToFileURL(path.join(root, out)).href);
};
const sc = await bundle('src/tools/fixups/source-consistency.ts', 'dist/source-consistency.test.mjs');
const audit = await bundle('src/orchestration/audit/interaction-audit.ts', 'dist/source-consistency.audit.test.mjs');
const fixups = await bundle(fixupsEntry(), 'dist/source-consistency.fixups.test.mjs');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};
const one = (fn, files) => fn(new Map(Object.entries(files)));
const doc = (files) => Object.entries(files).map(([p, b]) => `@@@makeui:file ${p}\n${b}@@@makeui:endfile`).join('\n');

// --- 1. a drawing with no size --------------------------------------------------------
{
  const art = `export const EmptyState = ({ className = '' }) => (\n  <svg viewBox="0 0 160 160" className={className} aria-hidden="true"><circle cx="80" cy="80" r="70" /></svg>\n);\n`;
  const r = one(sc.fixUnsizedSvg, { 'src/components/illustrations/EmptyState.tsx': art });
  const out = r.files.get('src/components/illustrations/EmptyState.tsx') ?? '';
  check('the empty-state drawing gets the width its viewBox states', /<svg width="160" viewBox="0 0 160 160"/.test(out), true);
  check('and only the width: its proportions give the height', /height=/.test(out), false);

  const icon = `export default function Close() { return <svg viewBox="0 0 24 24" className=""><path d="M18 6L6 18" /></svg>; }\n`;
  check('an icon is sized to the text around it',
    /<svg width="1em" viewBox/.test(one(sc.fixUnsizedSvg, { 'src/components/icons/Close.tsx': icon }).files.get('src/components/icons/Close.tsx') ?? ''), true);

  const sized = `<svg viewBox="0 0 24 24" width="16" height="16" />`;
  const styled = `<svg viewBox="0 0 24 24" style={{ width: 20 }} />`;
  const hero = `<svg viewBox="0 0 1200 400" className="hero-art" />`;
  const vueSized = `<template><svg viewBox="0 0 24 24" :width="size" /></template>`;
  const untouched = one(sc.fixUnsizedSvg, {
    'src/a.tsx': sized, 'src/b.tsx': styled, 'src/c.tsx': hero, 'src/d.vue': vueSized,
  });
  check('a drawing that states its size, is styled, or is a banner is left alone', untouched.files.size, 0);
  check('Vue templates too', /<svg width="120"/.test(one(sc.fixUnsizedSvg, { 'src/E.vue': '<template><svg viewBox="0 0 120 80" /></template>' }).files.get('src/E.vue') ?? ''), true);
}

// --- 2. one literal photograph for every product --------------------------------------
{
  const data = `export const PRODUCTS = [\n  {\n    id: '1',\n    name: 'コットンTシャツ',\n    sizes: { S: 1, M: 1 },\n    image: 'https://cdn.example/stock/tshirt/a.webp',\n  },\n  {\n    id: '2',\n    name: 'リネンシャツ',\n    sizes: { S: 1 },\n    image: 'https://cdn.example/stock/shirt/b.webp',\n  },\n];\n`;
  const list = `export default function ProductsScreen() {\n  return PRODUCTS.map((product) => (\n    <div key={product.id}>\n      <img\n        src="https://cdn.example/stock/tshirt/a.webp"\n        alt={product.name}\n        className="card__image"\n      />\n    </div>\n  ));\n}\n`;
  const banner = `<img src="https://cdn.example/hero.jpg" alt={category.title} />`;
  const r = one(sc.fixLiteralRecordImages, { 'src/data/products.ts': data, 'src/screens/ProductsScreen.tsx': list, 'src/screens/Home.tsx': banner });
  check('the card shows its own product\'s photograph', /src=\{product\.image\}/.test(r.files.get('src/screens/ProductsScreen.tsx') ?? ''), true);
  check('found under a record that nests another object beside its image', r.fixed.length, 1);
  check('a banner captioned with a field products do not have is left alone', r.files.has('src/screens/Home.tsx'), false);
  const vue = `<template><img src="https://cdn.example/x.webp" :alt="item.name" /></template>`;
  check('Vue binds it with :src', /:src="item\.image"/.test(one(sc.fixLiteralRecordImages, { 'src/data/products.ts': data, 'src/screens/List.vue': vue }).files.get('src/screens/List.vue') ?? ''), true);
}

// --- 3. an action no reducer handles ---------------------------------------------------------
{
  const reducer = `function reducer(state, action) {\n  switch (action.type) {\n    case 'SET_AUTH_LOADING':\n      return { ...state, auth: { ...state.auth, isLoading: action.payload } };\n    case 'SET_AUTH_ERROR':\n      return { ...state, auth: { ...state.auth, error: action.payload } };\n    case 'LOGIN_SUCCESS':\n      return {\n        ...state,\n        auth: { ...state.auth, isAuthenticated: true, user: action.payload, error: null },\n      };\n    case 'LOGOUT':\n      return { ...state, auth: { isAuthenticated: false, user: null } };\n    default:\n      return state;\n  }\n}\n`;
  const login = `function submit() {\n  dispatch({ type: 'AUTH_SET_LOADING', payload: true });\n  dispatch({\n    type: 'AUTH_LOGIN_SUCCESS',\n    payload: {\n      user: { name: user.name, email: user.email },\n      email: localEmail,\n      password: localPassword\n    }\n  });\n  dispatch({ type: 'AUTH_LOGIN_FAILED', payload: 'x' });\n  dispatch({ type: 'CLEAR_AUTH_ERROR' });\n}\n`;
  const home = `const out = () => dispatch({ type: 'AUTH_LOGOUT' });\n`;
  const files = { 'src/store/AppProvider.tsx': reducer, 'src/screens/LoginScreen.tsx': login, 'src/screens/HomeScreen.tsx': home };

  check('the reported mismatches are found',
    sc.unhandledDispatches(new Map(Object.entries(files))).unhandled,
    ['AUTH_LOGIN_FAILED', 'AUTH_LOGIN_SUCCESS', 'AUTH_LOGOUT', 'AUTH_SET_LOADING', 'CLEAR_AUTH_ERROR']);

  check('same words in another order', sc.intendedCase('AUTH_SET_LOADING', ['SET_AUTH_LOADING', 'LOGIN_SUCCESS']), 'SET_AUTH_LOADING');
  check('one name inside the other', sc.intendedCase('AUTH_LOGIN_SUCCESS', ['SET_AUTH_LOADING', 'LOGIN_SUCCESS']), 'LOGIN_SUCCESS');
  check('never across verbs: CLEAR is not SET', sc.intendedCase('CLEAR_AUTH_ERROR', ['SET_AUTH_ERROR']), null);
  check('nor when two cases could be meant', sc.intendedCase('ADD_ITEM', ['ADD_ITEM_TO_CART', 'ADD_ITEM_TO_WISHLIST']), null);

  const r = one(sc.fixUnhandledDispatch, files);
  const out = r.files.get('src/screens/LoginScreen.tsx') ?? '';
  check('signing in reaches the case that signs in', /type: 'LOGIN_SUCCESS'/.test(out), true);
  check('with the user the case stores, not the whole form',
    /type: 'LOGIN_SUCCESS',\s*payload: \{ name: user\.name, email: user\.email \}/.test(out), true);
  check('loading and logout too', [/type: 'SET_AUTH_LOADING'/.test(out), /type: 'LOGOUT'/.test(r.files.get('src/screens/HomeScreen.tsx') ?? '')], [true, true]);
  check('what cannot be decided is left alone', [/AUTH_LOGIN_FAILED/.test(out), /CLEAR_AUTH_ERROR/.test(out)], [true, true]);

  // ...and named for the repair pass, with the cases there are.
  const after = new Map(Object.entries(files)); for (const [p, b] of r.files) after.set(p, b);
  const defects = audit.auditShellContract(doc(Object.fromEntries(after)), 'react');
  const d = defects.find((x) => x.id === 'dispatch-unhandled');
  check('the rest is reported to the repair pass', Boolean(d) && /AUTH_LOGIN_FAILED/.test(d.instruction) && /SET_AUTH_ERROR/.test(d.instruction), true);
  check('against the files that send them', d?.paths, ['src/screens/LoginScreen.tsx']);
}

// --- 4. the hash reader's own list of screens ------------------------------------------------------
{
  // The second half of 「ログインできない」: #/home parsed to the default screen, the login form.
  const routes = `export type ScreenId = 'login' | 'login-loading' | 'home' | 'items' | 'item-detail';\n`;
  const nav = `function parseHash(hash: string) {\n  const screen = hash.slice(2).split('/')[0];\n  const validScreens: ScreenId[] = ['items', 'item-detail'];\n  if (!validScreens.includes(screen as ScreenId)) return DEFAULT_ROUTE;\n  return { screen };\n}\nexport const read = () => parseHash(location.hash);\n`;
  const menu = `const NAV_SCREENS = ['home', 'items'];\nconst isNav = (s) => NAV_SCREENS.includes(s);\nconst h = location.hash;\n`;
  const r = one(sc.fixHashScreenList, { 'src/routes.ts': routes, 'src/hooks/useNavigation.ts': nav, 'src/App.tsx': menu });
  check('the screens an edit added are ones the URL can open',
    /\['items', 'item-detail', 'login', 'login-loading', 'home'\]/.test(r.files.get('src/hooks/useNavigation.ts') ?? ''), true);
  check('a menu\'s list, which leaves screens out on purpose, is not touched', r.files.has('src/App.tsx'), false);
}

// --- 5. a new screen that opens where the last one was scrolled to ---------------------------------
{
  // Reported 2026-09-25: a slot chosen far down the calendar opened the form
  // 807px down, its first field above the top of the screen.
  const main = `import { createRoot } from 'react-dom/client';\nimport App from './App';\ncreateRoot(document.getElementById('root')!).render(<App />);\n`;
  const nav = `window.addEventListener('hashchange', onChange);\n`;
  const r = one(sc.fixScrollOnNavigate, { 'src/main.tsx': main, 'src/hooks/useNavigation.ts': nav });
  const out = r.files.get('src/main.tsx') ?? '';
  check('the entry resets the scroll on a screen change', out.includes(sc.SCROLL_MARK) && /addEventListener\('hashchange'/.test(out), true);
  check('forward starts at the top, back returns to where it was',
    [/window\.scrollTo\(0, 0\)/.test(out), /const back = stack\.length > 0 && stack\[stack\.length - 1\]\.hash === current/.test(out)], [true, true]);
  check('an inner scroller is reset too, not only the window', /querySelectorAll\('\*'\)[\s\S]*scrollTop > 0/.test(out), true);
  check('added once', one(sc.fixScrollOnNavigate, { 'src/main.tsx': out, 'src/hooks/useNavigation.ts': nav }).files.size, 0);
  check('Vue\'s entry too', one(sc.fixScrollOnNavigate, { 'src/main.ts': `createApp(App).mount('#app')\n`, 'src/router.ts': nav }).files.has('src/main.ts'), true);
  check('and nothing where nothing routes on the hash', one(sc.fixScrollOnNavigate, { 'src/main.tsx': main }).files.size, 0);
  // The snippet has to compile wherever it lands.
  const bundled = await import('esbuild').then((e) => e.transform(out, { loader: 'tsx' })).then(() => true, () => false);
  check('and it compiles as TSX', bundled, true);
}

// --- all run with every build, edit and repair ------------------------------------------------------
{
  const src = readFixups();
  check('registered in fixupProject', /apply\(fixSourceConsistency\(files\)\)/.test(src), true);
  const chained = fs.readFileSync(path.join(root, 'src/tools/fixups/source-consistency.ts'), 'utf8');
  check('and all of them run, in order', /\[fixUnsizedSvg, fixLiteralRecordImages, fixUnhandledDispatch, fixHashScreenList, fixScrollOnNavigate\]/.test(chained), true);
  check('fixupProject is exported for the edit path too', typeof fixups.fixupProject, 'function');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
