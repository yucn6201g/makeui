// A magnifier standing on a photograph.
//
// Reported 2026-09-20 on a generated storefront: 「商品をクリックすると画像が
// 表示されるが、中心に検索マークが表示されている」. The detail screen drew the garment
// as a background image and centred `<SearchIcon />` on it, with no handler
// behind it.
//
// It is the `icons` incentive backfiring. The contract requires every glyph a
// project draws to be rendered somewhere, the audit reports a project that
// renders none, and a project holding one icon reaches for that icon wherever
// it wants a graphic. The same document put it in an empty cart too.
//
// One document of 76, so the rule is narrow rather than clever: the element
// carries the picture in its OWN style, the icon is its only child, and nothing
// is listening for a click.
//
//   node test/icon-on-photo.test.mjs      (from backend/)
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await esbuild.build({
  entryPoints: [path.join(root, 'src/tools/picture-frames.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile: path.join(root, 'dist/iop.test.mjs'),
  external: ['@aws-sdk/*', '@smithy/*'], logLevel: 'error',
});
const { iconsOnPhotographs } = await import(pathToFileURL(path.join(root, 'dist/iop.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};
const cut = (src) => {
  let out = src;
  for (const r of iconsOnPhotographs(src).reverse()) out = out.slice(0, r.at) + out.slice(r.end);
  return out;
};

// --- the reported shape ----------------------------------------------------
const REPORTED = `        <div
            style={{
              aspectRatio: '1 / 1.2',
              backgroundImage: 'url(https://example.test/coat.jpg)',
              backgroundSize: 'cover',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            <SearchIcon />
          </div>`;
check('a magnifier centred on a photograph is found', iconsOnPhotographs(REPORTED).length, 1);
const cleaned = cut(REPORTED);
check('and taken out', /<SearchIcon \/>/.test(cleaned), false);
check('the photograph stays', /backgroundImage: 'url\(https:\/\/example\.test\/coat\.jpg\)'/.test(cleaned), true);
check('and so does the element', /<div\b[\s\S]*<\/div>/.test(cleaned), true);
check('running it twice removes nothing more', iconsOnPhotographs(cleaned).length, 0);

// --- what must not be removed ----------------------------------------------
// A control is a control. A zoom button that works is not decoration.
check('an icon on a photograph that handles a click is left alone', iconsOnPhotographs(
  `<div style={{ backgroundImage: 'url(a.jpg)' }} onClick={zoom}><SearchIcon /></div>`).length, 0);
check('and one inside a button likewise', iconsOnPhotographs(
  `<button style={{ backgroundImage: 'url(a.jpg)' }}><SearchIcon /></button>`).length, 0);
check('and one inside a link', iconsOnPhotographs(
  `<a href="#/x" style={{ backgroundImage: 'url(a.jpg)' }}><SearchIcon /></a>`).length, 0);
check('a Vue click handler counts too', iconsOnPhotographs(
  `<div style="background-image: url(a.jpg)" @click="zoom"><SearchIcon /></div>`).length, 0);
// The element has to be the one carrying the picture.
check('an icon in an element with no picture is left alone', iconsOnPhotographs(
  `<div className="toolbar"><SearchIcon /></div>`).length, 0);
check('a background colour is not a picture', iconsOnPhotographs(
  `<div style={{ background: '#eee' }}><SearchIcon /></div>`).length, 0);
// And it has to be the only thing in there.
check('an icon beside a caption is not decoration on its own', iconsOnPhotographs(
  `<div style={{ backgroundImage: 'url(a.jpg)' }}><SearchIcon /><span>拡大</span></div>`).length, 0);
// Only an icon. A real picture inside a picture frame is somebody's decision.
check('an illustration is not an icon', iconsOnPhotographs(
  `<div style={{ backgroundImage: 'url(a.jpg)' }}><EmptyCartIllustration /></div>`).length, 0);
check('nor is a plain svg', iconsOnPhotographs(
  `<div style={{ backgroundImage: 'url(a.jpg)' }}><svg viewBox="0 0 24 24" /></div>`).length, 0);
check('but an svg named an icon is one', iconsOnPhotographs(
  `<div style={{ backgroundImage: 'url(a.jpg)' }}><svg className="cds-icon" viewBox="0 0 24 24" /></div>`).length, 1);
check('an element with no children at all', iconsOnPhotographs(
  `<div style={{ backgroundImage: 'url(a.jpg)' }} />`).length, 0);
check('and a file with no markup', iconsOnPhotographs('const a = 1 < 2;').length, 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
