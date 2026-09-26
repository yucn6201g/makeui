// The app shell's two faults from the 2026-09-23 storefronts (仕上げ・Haiku・
// デジタル庁, one React and one Vue): a menu listing screens that need something
// first, and a cart count drawn on top of the cart.
//
//   node test/shell-fixes.test.mjs      (from backend/)
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { readFixups } from './lib/fixups-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await esbuild.build({
  entryPoints: [path.join(root, 'src/tools/fixups/shell-fixes.ts')], bundle: true, platform: 'node', format: 'esm',
  outfile: path.join(root, 'dist/shell-fixes.test.mjs'), logLevel: 'error',
});
const { fixFlowScreensInNav, fixCountBadges, COUNT_BADGE_MARKER } = await import(pathToFileURL(path.join(root, 'dist/shell-fixes.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- the menu holds top-level screens --------------------------------------------
// The Vue storefront's routes.ts, verbatim.
const VUE_ROUTES = `export const NAV_ITEMS: NavItem[] = [
  { id: 'products', label: '商品一覧' },
  { id: 'product-detail', label: '商品詳細' },
  { id: 'cart', label: 'カート' },
  { id: 'checkout', label: 'チェックアウト' },
  { id: 'order-complete', label: '注文完了' }
];`;
{
  const files = new Map([
    ['src/routes.ts', VUE_ROUTES],
    ['src/screens/ProductsScreen.vue', `<button @click="navigate('product-detail', product.id)">詳細</button>`],
    ['src/screens/CartScreen.vue', `<button :disabled="!items.length" @click="navigate('checkout')">レジに進む</button>`],
    ['src/screens/CheckoutScreen.vue', `<script setup>function submit() { navigate({ screen: 'order-complete' }) }</script>`],
  ]);
  const r = fixFlowScreensInNav(files);
  const nav = r.files.get('src/routes.ts');
  check('detail, checkout and completion leave the menu',
    [...nav.matchAll(/id: '([^']+)'/g)].map((m) => m[1]), ['products', 'cart']);
  check('the list is still valid source', /NAV_ITEMS: NavItem\[\] = \[\n  \{ id: 'products'[^\]]*\];$/.test(nav), true);
  check('and it says which', r.fixed[0].includes('商品詳細・チェックアウト・注文完了'), true);
}
// The React storefront reached checkout with `location.hash = '#/checkout'`.
{
  const files = new Map([
    ['src/routes.ts', `export const NAV_ITEMS: NavItem[] = [\n  { id: 'products', label: '商品一覧' },\n  { id: 'cart', label: 'カート' },\n  { id: 'checkout', label: 'チェックアウト' },\n];`],
    ['src/screens/CartScreen.tsx', `onClick={() => { location.hash = '#/checkout'; }}`],
  ]);
  check('a hash assignment is a way there too',
    [...fixFlowScreensInNav(files).files.get('src/routes.ts').matchAll(/id: '([^']+)'/g)].map((m) => m[1]), ['products', 'cart']);
}
{
  // Nothing else leads to it: taking it off the menu would orphan it.
  const orphan = new Map([
    ['src/routes.ts', VUE_ROUTES],
    ['src/screens/ProductsScreen.vue', '<p>一覧</p>'],
  ]);
  check('a flow screen nothing else reaches stays', fixFlowScreensInNav(orphan).fixed, []);
  // By label as well as by id: 'step3' says nothing, 予約完了 says it all.
  const byLabel = new Map([
    ['src/routes.ts', `export const NAV_ITEMS = [\n  { id: 'home', label: 'ホーム' },\n  { id: 'step3', label: '予約完了' },\n  { id: 'rooms', label: '会議室' },\n]`],
    ['src/screens/FormScreen.tsx', `navigate('step3')`],
  ]);
  check('named by its label', [...fixFlowScreensInNav(byLabel).files.get('src/routes.ts').matchAll(/id: '([^']+)'/g)].map((m) => m[1]), ['home', 'rooms']);
  // The first entry is home whatever it is called; settings and lists are top-level.
  const top = new Map([
    ['src/routes.ts', `export const NAV_ITEMS = [\n  { id: 'order-history', label: '注文履歴' },\n  { id: 'settings', label: '設定' },\n  { id: 'new-post', label: '新規投稿' },\n]`],
    ['src/App.tsx', `navigate('order-history'); navigate('settings'); navigate('new-post')`],
  ]);
  check('top-level screens stay', fixFlowScreensInNav(top).fixed, []);
  // The five proposals that were wrong on the September documents, each kept.
  const kept = (routes, extra = []) =>
    fixFlowScreensInNav(new Map([['src/routes.ts', routes], ['src/App.tsx', extra.map((id) => `navigate('${id}')`).join(';')]])).fixed;
  check('未完了一覧 is a list, not a completion',
    kept(`export const NAV_ITEMS = [\n  { id: 'input', label: '点検を記録する' },\n  { id: 'incomplete-list', label: '未完了一覧' },\n]`, ['incomplete-list']), []);
  check('持ち出し票 is not a checkout without a cart',
    kept(`export const NAV_ITEMS = [\n  { id: 'inventory', label: '棚おろし' },\n  { id: 'checkout', label: '持ち出し票' },\n]`, ['checkout']), []);
  check('入荷登録 and 新規申請 make something new',
    kept(`export const NAV_ITEMS = [\n  { id: 'dashboard', label: 'ダッシュボード' },\n  { id: 'receipt', label: '入荷登録' },\n  { id: 'form-edit', label: '新規申請' },\n]`, ['receipt', 'form-edit']), []);
  check('予約確認・変更 is where a booking is looked up',
    kept(`export const NAV_ITEMS = [\n  { id: 'clinic-info', label: '診療案内' },\n  { id: 'booking-lookup', label: '予約確認・変更' },\n]`, ['booking-lookup']), []);
  // With a cart, the same id is the flow step it looks like — the cafe's ご注文.
  check('with a cart, checkout leaves the menu',
    kept(`export const NAV_ITEMS = [\n  { id: 'menu', label: 'メニュー' },\n  { id: 'cart', label: 'カート' },\n  { id: 'checkout', label: 'ご注文' },\n]`, ['checkout']).length, 1);
  check('no routes file, no change', fixFlowScreensInNav(new Map([['src/App.tsx', 'x']])).fixed, []);
}

// --- a count sits beside what it counts ---------------------------------------------
{
  const react = new Map([
    ['src/App.tsx', `<button onClick={() => navigate('cart')} aria-label="カート"><CartIcon size={24} />{cartCount > 0 && <span className="badge">{cartCount}</span>}</button>`],
    ['src/styles/globals.css', '.cart-badge { position: relative; }\n.badge { position: absolute; top: -8px; right: -12px; min-width: 24px; }\n'],
  ]);
  const r = fixCountBadges(react);
  const css = r.files.get('src/styles/globals.css');
  check('an absolutely placed count is put back in the flow', /\.badge\.badge\.badge \{\n  position: static;/.test(css), true);
  check('and its host lines the two up', css.includes(':is(button, a, [role="button"]):has(> .badge) {\n  display: inline-flex;\n  align-items: center;'), true);
  check('its own look is kept', css.includes('min-width: 24px'), true);
  check('once', fixCountBadges(r.files).fixed, []);
  check('marked', css.includes(COUNT_BADGE_MARKER), true);
}
{
  // The Vue storefront: a v-if whose value holds a '>'.
  const vue = new Map([
    ['src/App.vue', `<template><a href="#/cart" class="cart-link">カート\n  <span v-if="cartItemCount > 0" class="cart-badge">\n    {{ cartItemCount }}\n  </span>\n</a></template>\n<style scoped>\n.cart-badge { position: absolute; top: -8px; right: -12px; }\n</style>`],
    ['src/styles/globals.css', ':root { --a: 1px; }'],
  ]);
  check('a Vue count is found through its v-if', fixCountBadges(vue).fixed.length, 1);
  // A badge already in the flow is not the fault; a status label is not a count.
  const inline = new Map([
    ['src/App.tsx', `<button><CartIcon /><span className="badge">{cartCount}</span></button><span className="badge">{product.status}</span>`],
    ['src/styles/globals.css', '.badge { display: inline-block; }'],
  ]);
  check('an inline count is left alone', fixCountBadges(inline).fixed, []);
  const status = new Map([
    ['src/App.tsx', `<span className="badge">{product.category}</span>`],
    ['src/styles/globals.css', '.badge { position: absolute; top: 8px; left: 8px; }'],
  ]);
  check('an absolutely placed label that is not a count is left alone', fixCountBadges(status).fixed, []);
}

// --- an icon sits in the middle of its button --------------------------------------
{
  const { fixIconBaseline, ICON_BASELINE_MARKER } = await import(pathToFileURL(path.join(root, 'dist/shell-fixes.test.mjs')).href);
  const project = new Map([
    ['src/components/icons/CartIcon.tsx', 'export default function CartIcon() { return <svg viewBox="0 0 24 24" /> }'],
    ['src/styles/globals.css', ':root { --a: 1px; }'],
  ]);
  const r = fixIconBaseline(project);
  const css = r.files.get('src/styles/globals.css');
  check('an icon project gets the baseline rule', css.includes(':where(button, a, [role="button"]) > svg {\n  vertical-align: middle;\n}'), true);
  check('once', fixIconBaseline(r.files).fixed, []);
  check('marked', css.includes(ICON_BASELINE_MARKER), true);
  check('a project with no icons is left alone', fixIconBaseline(new Map([['src/styles/globals.css', 'a{}'], ['src/App.tsx', '<p/>']])).fixed, []);
}

// --- a checkout asks whether there is anything to check out -----------------------------
{
  const { unguardedCheckouts } = await import(pathToFileURL(path.join(root, 'dist/shell-fixes.test.mjs')).href);
  const store = ['src/store/index.ts', 'export const state = reactive({ cart: [] as CartItem[] })'];
  // The Vue verification's checkout: a form, and no mention of the cart at all.
  const vue = new Map([store, ['src/screens/CheckoutScreen.vue', '<template><form><input v-model="store.state.checkout.name" /></form></template>']]);
  check('a checkout that never asks about the cart is unguarded', unguardedCheckouts(vue), ['src/screens/CheckoutScreen.vue']);
  // Every form counts its errors; that is not a question about the cart.
  const errorsOnly = new Map([store, ['src/screens/CheckoutScreen.tsx', 'if (Object.keys(newErrors).length > 0) { return }\nreturn <form>{state.cart.map(i => <p>{i.name}</p>)}</form>']]);
  check('an error count is not a cart check', unguardedCheckouts(errorsOnly), ['src/screens/CheckoutScreen.tsx']);
  // The React verification's guard, and the other spellings of it.
  for (const guard of [
    'if (state.cart.length === 0) return <EmptyState />',
    'if (!state.cart.length) return null',
    '<section v-if="store.state.cart.length">',
    'const isCartEmpty = computed(() => cartItems.value.length < 1)',
    'if (cartCount === 0) navigate("cart")',
  ]) {
    check(`guarded: ${guard.slice(0, 40)}`, unguardedCheckouts(new Map([store, ['src/screens/CheckoutScreen.tsx', guard]])), []);
  }
  // A completion screen needs an order, not a cart; a shop without a cart has no such question.
  check('a completion screen is not asked about the cart',
    unguardedCheckouts(new Map([store, ['src/screens/PaymentCompleteScreen.tsx', '<p>ありがとうございました</p>']])), []);
  check('an app with no cart is not asked',
    unguardedCheckouts(new Map([['src/store/index.ts', 'export const state = { loans: [] }'], ['src/screens/CheckoutScreen.tsx', '<form />']])), []);
  const audit = fs.readFileSync(path.join(root, 'src/orchestration/audit/interaction-audit.ts'), 'utf8');
  check('the shell audit reports it, naming the files', /id: 'flow-unguarded'[\s\S]{0,700}paths: unguarded/.test(audit), true);
}

// --- wiring and the contract that used to say the opposite ---------------------------
const fx = readFixups();
check('all three run in fixupProject',
  [/apply\(fixFlowScreensInNav\(files\)\)/.test(fx), /apply\(fixCountBadges\(files\)\)/.test(fx), /apply\(fixIconBaseline\(files\)\)/.test(fx)], [true, true, true]);
const contracts = fs.readFileSync(path.join(root, 'src/orchestration/prompts/prompt-contracts.ts'), 'utf8');
check('the contract no longer asks for every screen in the menu',
  /and every screen is reachable from it\. /.test(contracts), false);
check('and names the screens that stay out of it', /A screen that needs something\s+first is NOT in it/.test(contracts), true);
const frameworks = fs.readFileSync(path.join(root, 'src/config/frameworks.ts'), 'utf8');
check('the edit guard no longer sends new screens to the menu', /ScreenId・NAV_ITEMS・App/.test(frameworks), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
