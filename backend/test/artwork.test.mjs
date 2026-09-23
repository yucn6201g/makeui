// The drawing an empty screen was supposed to have, and the tokens that made it
// invisible when it had one.
//
// `imagery-missing` is the largest source-visible finding: 14 of the 34 stored
// project documents (41%) reach the user with it open, it is fixed 41% of the
// time and survives half the runs it appears in. Measured 2026-09-20; all of the
// numbers below are from that pass, and the fixups took it to 0 of 34 with all
// 34 still compiling.
//
// Three faults were found on the way, and each has its own checks here:
//
//   ALIASED IMPORTS read as unused. `import { EmptyState as EmptyStateIllustration }`
//   followed by `<EmptyStateIllustration />` is a drawing on screen, and
//   `renderedFrom` reported the document for not drawing it. One of the 15.
//
//   A DEAD COMPONENT is not a host. The first version preferred a file named
//   for an empty state; doc25 has `ui/EmptyState.tsx` that nothing imports and
//   four screens that write their own markup. The drawing went into the dead
//   file, the finding closed, and the screen stayed bare — the paper version of
//   the fix, which is the exact thing the audit exists to stop.
//
//   BEM CHILDREN are not containers. `[\w-]*empty[\w-]*` also matches
//   `empty-state__title`, so a 160px drawing went inside the <h2> and again
//   inside the <p>.
//
//   node test/artwork.test.mjs      (from backend/)
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = async (entry, out) => {
  await esbuild.build({
    entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'esm',
    outfile: path.join(root, out), external: ['@aws-sdk/*', '@smithy/*'], logLevel: 'error',
  });
  return import(pathToFileURL(path.join(root, out)).href);
};
const art = await build('src/tools/artwork.ts', 'dist/aw.test.mjs');
const fx = await build('src/tools/framework-fixups.ts', 'dist/awf.test.mjs');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};
const files = (o) => new Map(Object.entries(o));

// --- renderedFrom: an alias is a use -----------------------------------------
const ALIASED = files({
  'src/components/illustrations/EmptyState.tsx': 'export const EmptyState = () => <svg/>;',
  'src/components/ui/EmptyState.tsx':
    "import { EmptyState as EmptyStateIllustration } from '../illustrations/EmptyState';\n" +
    'export default function EmptyState() { return <div className="empty-state"><EmptyStateIllustration /></div>; }',
});
check('a drawing rendered under an alias is rendered',
  art.renderedFrom(ALIASED, 'src/components/illustrations/', '.tsx').used.length, 1);
check('a default import counts too', art.renderedFrom(files({
  'src/components/illustrations/Art.tsx': 'export default () => <svg/>;',
  'src/screens/A.tsx': "import Picture from '../components/illustrations/Art';\nexport default () => <Picture />;",
}), 'src/components/illustrations/', '.tsx').used.length, 1);
// But another export of the same module is not this component's use.
check('a different name from the same module is not this one being drawn',
  art.renderedFrom(files({
    'src/components/illustrations/Art.tsx': 'export const Art = () => <svg/>;\nexport const Other = () => <svg/>;',
    'src/screens/A.tsx': "import { Other } from '../components/illustrations/Art';\nexport default () => <Other />;",
  }), 'src/components/illustrations/', '.tsx').used.length, 0);
check('an import and nothing else is not a use', art.renderedFrom(files({
  'src/components/illustrations/Art.tsx': 'export const Art = () => <svg/>;',
  'src/screens/A.tsx': "import { Art } from '../components/illustrations/Art';\nexport default () => <div/>;",
}), 'src/components/illustrations/', '.tsx').used.length, 0);
// The lookahead that stops `CartIcon` matching inside `CartIconButton`.
check('a longer name is not this one', art.renderedFrom(files({
  'src/components/icons/Cart.tsx': 'export const Cart = () => <svg/>;',
  'src/screens/A.tsx': 'export default () => <CartButton />;',
}), 'src/components/icons/', '.tsx').used.length, 0);

// --- where the drawing goes ---------------------------------------------------
const SCREEN_EMPTY = '<div className="empty-state"><h2 className="empty-state__title">なし</h2></div>';
const PROJECT = files({
  'src/components/ui/EmptyState.tsx': `export const EmptyState = () => (${SCREEN_EMPTY});`,
  'src/screens/ListScreen.tsx': `export default function ListScreen() { return (${SCREEN_EMPTY}); }`,
});
// The ui component is imported by nothing, so it is not a host however well named.
check('a component nothing renders is not a host',
  art.findArtHosts(PROJECT, 'react').map((h) => h.path), ['src/screens/ListScreen.tsx']);
check('and a component something renders is', art.findArtHosts(files({
  'src/components/ui/EmptyBox.tsx': `export const EmptyBox = () => (${SCREEN_EMPTY});`,
  'src/screens/ListScreen.tsx': "import { EmptyBox } from '../components/ui/EmptyBox';\nexport default () => <EmptyBox />;",
}), 'react').map((h) => h.path), ['src/components/ui/EmptyBox.tsx']);
// One container, not its title and its message.
check('a BEM child is not a container', art.findArtHosts(files({
  'src/screens/A.tsx': '<div className="empty-state"><h2 className="empty-state__title">x</h2><p className="empty-state__message">y</p></div>',
}), 'react').length, 1);
check('nor is a class naming a part of one', art.findArtHosts(files({
  'src/screens/A.tsx': '<div className="empty-wrap"><p className="empty-text">x</p><div className="empty-actions" /></div>',
}), 'react').map((h) => h.indent.length), [0]);
/*
 * Except the one BEM child that IS the place a drawing goes. 12 of the 75
 * stored documents cut a slot for artwork and left it empty; the `__` rule
 * above threw it out with the titles and the messages, and one document of 41
 * kept the finding because of it.
 */
check('an art slot is the host, not the container around it', art.findArtHosts(files({
  'src/screens/A.tsx': '<div className="empty-state"><div className="empty-state__art"></div><h2 className="empty-state__title">x</h2></div>',
}), 'react').length, 1);
check('and it is the slot that gets the drawing', /empty-state__art">\s*\n\s*<EmptyStateArt \/>/.test(
  fx.fixArtworkNotDrawn(files({
    'src/styles/globals.css': ':root { --color-border: #ddd; }',
    'src/screens/A.tsx': '<div className="empty-state">\n  <div className="empty-state__art"></div>\n  <p className="empty-state__message">x</p>\n</div>',
  }), 'react').files.get('src/screens/A.tsx')), true);
// An occupied slot is left alone: cf5b4848 holds <CalendarXIcon /> there, which
// is an icon rather than an illustration, so the audit still reports the
// document — and a second graphic on top of the first is worse than the finding.
check('an art slot that already holds a graphic is not a host', art.findArtHosts(files({
  'src/screens/A.tsx': '<div className="empty-state__art" style={{ margin: 0 }}>\n  <CalendarXIcon />\n</div>',
}), 'react').length, 0);
check('an inline svg counts as occupied too', art.findArtHosts(files({
  'src/screens/A.tsx': '<div className="empty-state__art"><svg viewBox="0 0 24 24" /></div>',
}), 'react').length, 0);
// But a CONTAINER whose action button carries an icon three elements down has
// nothing drawn where the illustration goes. Reading ahead from a container took
// imagery-missing from 0 back to 2 of 34, so the guard is the slot's alone.
check('a container is not skipped for an icon deeper inside it', art.findArtHosts(files({
  'src/screens/A.tsx': '<div className="empty-state"><h2>x</h2><p>y</p><button><PlusIcon />追加</button></div>',
}), 'react').length, 1);

// --- what is already standing in the empty state --------------------------
/*
 * 「カートが空のときのカード画面の妙な位置に検索マークが表示されている」 —
 * `<EmptyStateArt />` inserted above the `<SearchIcon />` the build had already
 * put there, so the screen drew two graphics. Measured over the 28 documents
 * this pass edits: 8 of them already had one, and every one of the 8 was an
 * ICON doing an illustration's job. The contract's own words are 「アイコンを
 * 拡大したものにしない」, so the icon is what goes.
 */
const CART = {
  'src/styles/globals.css': ':root { --color-border: #ddd; }',
  'src/components/icons/SearchIcon.tsx': 'export const SearchIcon = () => <svg/>;',
  'src/screens/CartScreen.tsx':
    '<div className="da-empty">\n  <SearchIcon />\n  <h3>カートに商品がありません</h3>\n</div>',
  // Still used where it means something, so removing it orphans nothing.
  'src/screens/ProductListScreen.tsx': 'export default () => (<div><SearchIcon />絞り込み</div>);',
};
const emptyCart = fx.fixArtworkNotDrawn(files(CART), 'react').files.get('src/screens/CartScreen.tsx');
check('an icon standing in for the drawing is replaced', /<SearchIcon \/>/.test(emptyCart), false);
check('and the drawing takes its place', /<EmptyStateArt \/>\n\s*<h3>/.test(emptyCart), true);
check('nothing is stacked', (emptyCart.match(/<(?:EmptyStateArt|SearchIcon)/g) || []).length, 1);
/*
 * But not its last use. `icons` reports a project that renders none of its
 * glyphs, and taking the only one out took that finding from 12 to 13 of 34 and
 * 10 to 11 of 41 — trading one finding for another is not a repair.
 */
const ONLY = { ...CART };
delete ONLY['src/screens/ProductListScreen.tsx'];
check('an icon used nowhere else is left alone', fx.fixArtworkNotDrawn(files(ONLY), 'react').fixed, []);
// And a real drawing already there means the place is taken.
check('an illustration already there is not replaced', art.findArtHosts(files({
  'src/screens/A.tsx': '<div className="empty-state"><EmptyCartIllustration /><h3>x</h3></div>',
}), 'react').length, 0);
check('nor is a plain svg', art.findArtHosts(files({
  'src/screens/A.tsx': '<div className="empty-state"><svg viewBox="0 0 160 160" /><h3>x</h3></div>',
}), 'react').length, 0);
// An svg named an icon is an icon, however it is drawn.
check('an svg classed as an icon counts as one', art.findArtHosts(files({
  'src/screens/A.tsx': '<div className="empty-state"><svg className="cds-empty-state-icon" /><h3>x</h3></div>',
}), 'react').map((h) => Boolean(h.replaces)), [true]);

// Every empty state, not the first: four bare screens is four bare screens.
check('every empty state in a screen is a host', art.findArtHosts(files({
  'src/screens/A.tsx': `${SCREEN_EMPTY}\n${SCREEN_EMPTY}\n${SCREEN_EMPTY}`,
}), 'react').length, 3);
// Failing all of them, the shell — and only for a wordmark.
check('a header is the fallback when there is no empty state',
  art.findArtHosts(files({ 'src/App.tsx': '<header className="app-header"><h1>店</h1></header>' }), 'react')
    .map((h) => h.place), ['header']);
check('and an empty state wins over a header',
  art.findArtHosts(files({ 'src/App.tsx': `<header className="h">${SCREEN_EMPTY}</header>` }), 'react')
    .map((h) => h.place), ['empty']);

// --- which drawing --------------------------------------------------------------
const THREE = [
  'src/components/illustrations/EmptyCartIllustration.tsx',
  'src/components/illustrations/EmptySearchIllustration.tsx',
  'src/components/illustrations/Wordmark.tsx',
];
check('the cart screen gets the cart drawing',
  art.pickArtwork(THREE, 'empty', 'src/screens/CartScreen.tsx'), THREE[0]);
check('the search screen gets the search one',
  art.pickArtwork(THREE, 'empty', 'src/screens/SearchScreen.tsx'), THREE[1]);
// "Empty" is in every one of their names, so it must not be what decides.
check('a screen matching nothing gets an empty-state drawing, not the wordmark',
  art.pickArtwork(THREE, 'empty', 'src/screens/RoomsScreen.tsx'), THREE[0]);
check('a header only ever gets the wordmark', art.pickArtwork(THREE, 'header', 'src/App.tsx'), THREE[2]);
check('and nothing when there is no wordmark',
  art.pickArtwork(THREE.slice(0, 2), 'header', 'src/App.tsx'), undefined);

// --- the fixup end to end ---------------------------------------------------------
const UNUSED = files({
  'src/styles/globals.css': ':root { --color-border-subtle: #ddd; --color-text-secondary: #888; }',
  'src/components/illustrations/EmptyCartIllustration.tsx':
    'export const EmptyCartIllustration = () => <svg><path stroke="var(--border)" /></svg>;',
  'src/screens/CartScreen.tsx': `export default function CartScreen() { return (${SCREEN_EMPTY}); }`,
});
const wired = fx.fixArtworkNotDrawn(UNUSED, 'react');
const cart = wired.files.get('src/screens/CartScreen.tsx');
check('the drawing the project already made is imported',
  /import \{ EmptyCartIllustration \} from '\.\.\/components\/illustrations\/EmptyCartIllustration'/.test(cart), true);
check('and rendered inside the empty state',
  /<div className="empty-state">\s*\n\s*<EmptyCartIllustration \/>/.test(cart), true);
check('no new file is created when the project has one',
  wired.files.has('src/components/illustrations/EmptyStateArt.tsx'), false);
check('the finding is closed',
  fx.fixArtworkNotDrawn(wired.files, 'react').fixed.length, 0);

// A name the host already declares is imported under another one: an import
// binding beside a function declaration of the same name is a redeclaration.
const COLLIDE = files({
  'src/components/illustrations/EmptyState.tsx': 'export const EmptyState = () => <svg/>;',
  'src/screens/A.tsx': `export default function EmptyState() { return (${SCREEN_EMPTY}); }`,
});
const aliased = fx.fixArtworkNotDrawn(COLLIDE, 'react').files.get('src/screens/A.tsx');
check('a colliding name is imported under an alias',
  /import \{ EmptyState as EmptyStateIllustration \}/.test(aliased), true);
check('and rendered under it', /<EmptyStateIllustration \/>/.test(aliased), true);

// Nothing to draw: one file is made, and it is drawn.
const ABSENT = files({
  'src/styles/globals.css': ':root { --color-border: #ddd; }',
  'src/screens/A.tsx': `export default function A() { return (${SCREEN_EMPTY}); }`,
});
const made = fx.fixArtworkNotDrawn(ABSENT, 'react');
check('one drawing is created', made.files.has('src/components/illustrations/EmptyStateArt.tsx'), true);
check('stroke only, in the tokens the contract names',
  /stroke="var\(--(?:border|text-muted)\)"/.test(made.files.get('src/components/illustrations/EmptyStateArt.tsx')), true);
check('with no fill', /fill="[^n]/.test(made.files.get('src/components/illustrations/EmptyStateArt.tsx')), false);
check('and it is rendered', /<EmptyStateArt \/>/.test(made.files.get('src/screens/A.tsx')), true);
// A header is not given an invented tray.
check('nothing is invented for a header', fx.fixArtworkNotDrawn(files({
  'src/App.tsx': '<header className="app-header"><h1>店</h1></header>',
}), 'react').fixed.length, 0);
check('a project already drawing something is left alone', fx.fixArtworkNotDrawn(files({
  'src/components/illustrations/Art.tsx': 'export const Art = () => <svg/>;',
  'src/screens/A.tsx': `import { Art } from '../components/illustrations/Art';\nexport default () => (<div className="empty-state"><Art /></div>);`,
}), 'react').fixed.length, 0);

// --- the tokens the drawings read ---------------------------------------------
// doc25's empty cart drew at 160x160, in the DOM, invisible: every stroke was
// `var(--border)` and nothing defined `--border`. 22 of 34 documents (65%).
const HOLES = files({
  'src/styles/globals.css': ':root { --color-border-subtle: #D9D9D9; --color-text-secondary: #8A8A8A; --color-neutral-9: #111; }',
  'src/components/illustrations/Art.tsx':
    '<svg><path stroke="var(--border)" /><path stroke="var(--text-muted)" /></svg>',
});
const defined = fx.fixUndefinedTokens(HOLES).files.get('src/styles/globals.css');
check('the border a drawing reads is bound to the project\'s own',
  /--border: var\(--color-border-subtle\);/.test(defined), true);
check('and the muted ink likewise',
  /--text-muted: var\(--color-text-secondary\);/.test(defined), true);
// An alias, never a colour: palette-size and preset-drift count values, and a
// literal here would manufacture findings for a repair to spend a call on.
check('nothing but aliases is written', /#[0-9a-f]{3,6}/i.test(
  defined.slice(defined.indexOf('/* makeui:token-aliases */'))), false);
// A name whose role cannot be read from it is left undefined rather than guessed.
check('a name with no readable role is left alone', fx.fixUndefinedTokens(files({
  'src/styles/globals.css': ':root { --color-primary: #06c; }',
  'src/components/illustrations/Art.tsx': '<svg><path fill="var(--color-neutral-9)" /></svg>',
})).fixed.length, 0);
check('a var with a fallback already renders and is not touched', fx.fixUndefinedTokens(files({
  'src/styles/globals.css': ':root { --color-border-subtle: #ddd; }',
  'src/components/illustrations/Art.tsx': '<svg><path stroke="var(--border, #ccc)" /></svg>',
})).fixed.length, 0);
check('a project that defines what it reads is left alone', fx.fixUndefinedTokens(files({
  'src/styles/globals.css': ':root { --border: #ddd; }',
  'src/components/illustrations/Art.tsx': '<svg><path stroke="var(--border)" /></svg>',
})).fixed.length, 0);
check('running it twice writes one block', (() => {
  const once = fx.fixUndefinedTokens(HOLES).files;
  const twice = fx.fixUndefinedTokens(once).files.get('src/styles/globals.css');
  return (twice.match(/makeui:token-aliases/g) || []).length;
})(), 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
