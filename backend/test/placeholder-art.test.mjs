// The panel drawn where no photograph fits.
//
// Half of every photograph slot in production ended as the neutral 「画像なし」
// block — 42 of 84 over three weeks — and a listing of grey boxes is what that
// looks like. The panel replaces it. What matters about it is here: it is stable
// (the same name always draws the same thing), it differs from its neighbours,
// it is safe to paste into an attribute, and it never claims to be a photograph
// of anything.
//
//   node test/placeholder-art.test.mjs      (from backend/)
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist/art.test.mjs');
await esbuild.build({
  entryPoints: [path.join(root, 'src/tools/images/placeholder-art.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error',
});
const { artworkFor, monogram, dominantHue } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};
const svgOf = (uri) => decodeURIComponent(uri.replace('data:image/svg+xml;utf8,', ''));

// --- it is an image an <img src> can hold ------------------------------------
const one = artworkFor('カプチーノ');
check('it is a data URI', one.startsWith('data:image/svg+xml;utf8,'), true);
check('nothing in it can close an HTML attribute', /["'<>]/.test(one), false);
const svg = svgOf(one);
check('it declares its size, so a card that reads the file gets the 4:3 box',
  /width="400" height="300" viewBox="0 0 400 300"/.test(svg), true);
check('it names itself for a screen reader', svg.includes('aria-label="カプチーノ"'), true);
check('it says nothing about being missing', /画像なし/.test(svg), false);

// --- stable, and different from its neighbours -------------------------------
check('the same name always draws the same panel', artworkFor('カプチーノ'), artworkFor('カプチーノ'));
const names = ['カプチーノ', 'アメリカーノ', '騎士団長殺し', '1Q84', 'USB-C ハブ', '木製チェス盤セット',
  'AI企業の時価総額が過去最高を更新', 'GitHub ActionsでCI/CDを構築する', 'ワイヤレスマイク', 'キッシュ'];
check('ten names draw ten different panels', new Set(names.map((n) => artworkFor(n))).size, 10);

// --- the first character, which in Japanese is already a word's worth --------
check('a Japanese name shows its first character', monogram('騎士団長殺し'), '騎');
check('a katakana name too', monogram('カプチーノ'), 'カ');
check('a Latin name shows two letters', monogram('github actions'), 'GI');
check('a digit counts as Latin', monogram('1Q84'), '1Q');
check('an emoji is not cut in half', monogram('🍰ケーキ'), '🍰');
check('an empty name has no monogram', monogram('   '), '');
check('and then nothing is drawn as text', /<text/.test(svgOf(artworkFor(''))), false);

// --- a name is data, not markup ---------------------------------------------
const nasty = artworkFor('<script>alert("x")</script> & "co"');
// The label is inert text: the angle brackets are entities, so nothing in it can
// open an element. The words themselves surviving as characters is correct.
check('markup in a name cannot open an element', /<script/i.test(svgOf(nasty)), false);
check('its angle brackets are entities', svgOf(nasty).includes('&lt;script&gt;'), true);
check('and its ampersand is escaped', svgOf(nasty).includes('&amp;'), true);

// --- it sits beside the design rather than across it -------------------------
const blue = artworkFor('商品A', { hue: 210 });
check('a given hue is the one used', svgOf(blue).includes('hsl(210'), true);
check('a hue makes a different panel from the name-derived one', blue === artworkFor('商品A'), false);
// 400 is 40, and each panel sits a few degrees off the page's hue so a row of
// them is not twelve identical grounds.
const wrapped = Number(svgOf(artworkFor('x', { hue: 400 })).match(/hsl\((\d+)/)[1]);
check('hues wrap rather than break', wrapped >= 31 && wrapped <= 49, true);
const row = ['a', 'b', 'c', 'd', 'e'].map((n) => Number(svgOf(artworkFor(n, { hue: 210 })).match(/hsl\((\d+)/)[1]));
check('a page hue keeps every panel within nine degrees of it',
  row.every((h) => Math.abs(h - 210) <= 9), true);

// The document's own accent, read off the source: the colour actually on screen.
check('the most used colour wins',
  dominantHue('.a{color:#1f6feb}.b{border:1px solid #216fe0}.c{background:#c0392b}'), 210);
check('greys and near-whites are not a hue',
  dominantHue('.a{color:#333}.b{background:#fff}.c{border-color:#e5e7eb}'), undefined);
check('a document with no colour at all has none', dominantHue('<div>hello</div>'), undefined);
check('three-digit hex counts', dominantHue('.a{color:#0a0}'), 120);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
