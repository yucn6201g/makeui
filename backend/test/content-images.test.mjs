/**
 * Pictures the user supplies for the UI, and the one thing they must not do.
 *
 * The reference image (`image-input.ts`) is SEEN by the design phase and the
 * build, because "read the layout and palette off this" cannot be done from a
 * description. A content image is the opposite job: to place a product photo the
 * model needs to know what it is and where it goes, not what it looks like pixel
 * by pixel. So its bytes never enter a model call — captioned once, described as
 * text, substituted after the build.
 *
 * That is a cost argument with numbers behind it. An image costs about
 * `width * height / 750` tokens to look at. Five photos shown to five design
 * specialists and the build is ~39,000 tokens on a run whose measured median is
 * 154,000 — a quarter again, for information the caption already carries. One
 * captioning call is flat however long the pipeline gets.
 *
 * The property this file holds is that the bytes stay out: what reaches a prompt
 * is text, what reaches the document is a data URI, and nothing carries a
 * picture between them.
 *
 *   node test/content-images.test.mjs      (from backend/)
 */
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const out = path.join(root, 'dist/content-images.test.mjs');
fs.mkdirSync(path.dirname(out), { recursive: true });
const entry = path.join(root, 'dist/content-images-entry.ts');
fs.writeFileSync(entry, [
  "export * from '../src/utils/content-images.js'",
  "export { captionImages } from '../src/orchestration/image-captions.js'",
].join('\n'));
await esbuild.build({
  entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out,
  external: ['@aws-sdk/*', '@smithy/*', '@strands-agents/*'],
});
const {
  parseContentImages, contentImageDirective, embedContentImages,
  stripContentImageTokens, contentImageToken, MAX_CONTENT_IMAGES, captionImages, MAX_CAPTION_CHARS,
  splitByRole,
} = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const png = (n) => `data:image/png;base64,${'A'.repeat(n)}`;

// --- parsing and its two bounds -----------------------------------------------
const three = parseContentImages([png(40), png(40), png(40)]);
check('three images parse', three.images.length, 3);
check('and are numbered from one', three.images.map((i) => i.index), [1, 2, 3]);
check('with no caption until one is written', three.images.map((i) => i.caption), ['', '', '']);
// Content until the prompt says otherwise. The default is the safe one: a
// reference is the image every design stage LOOKS at, so guessing one wrong is
// both expensive and a product photo deciding the palette.
check('and content until the prompt says otherwise',
  three.images.map((i) => i.role), ['content', 'content', 'content']);
check('nothing dropped', three.dropped, []);

check('a non-list is nothing rather than an error', parseContentImages(undefined).images, []);
check('and so is an empty one', parseContentImages([]).images, []);

// Unusable entries are dropped individually, not fatally: one bad paste should
// not cost the user the other seven pictures.
const mixed = parseContentImages([png(40), '', png(40), null]);
check('an unusable entry is dropped, the rest survive', mixed.images.length, 2);
check('and the survivors are renumbered contiguously',
  mixed.images.map((i) => i.index), [1, 2]);
check('the drop says which and why', mixed.dropped, [
  { reason: 'unusable', at: 1 }, { reason: 'unusable', at: 3 },
]);

const many = parseContentImages(Array.from({ length: MAX_CONTENT_IMAGES + 2 }, () => png(40)));
check('the count bound holds', many.images.length, MAX_CONTENT_IMAGES);
check('and the excess is reported, not silently lost',
  many.dropped.map((d) => d.reason), ['count', 'count']);

/*
 * The size bound is a budget across ALL of them, not per image, because what it
 * protects is the finished document: every accepted picture is embedded into it
 * as a data URI, and the edit path carries that document in a 6MB request body.
 */
const fat = parseContentImages([png(1_500_000), png(1_500_000)]);
check('the second image does not fit the document budget', fat.images.length, 1);
check('and says so', fat.dropped, [{ reason: 'budget', at: 1 }]);

// --- what reaches a prompt is text --------------------------------------------
const withCaptions = parseContentImages([png(40), png(40)]).images;
withCaptions[0].caption = '白いマグカップ。商品カードのサムネイルに。';
withCaptions[1].caption = '店舗の外観。ヘッダーのヒーロー画像に。';
const directive = contentImageDirective(withCaptions);

check('the directive names both markers',
  [contentImageToken(1), contentImageToken(2)].filter((t) => !directive.includes(t)), []);
check('and carries the captions', directive.includes('白いマグカップ'), true);
/*
 * The assertion this file exists for. A base64 payload in the directive would
 * mean the bytes travel into every prompt that reads it — which is the cost the
 * whole design avoids, and it would not fail any other test here.
 */
check('and NO image data', /[A-Za-z0-9+/]{200,}={0,2}/.test(directive), false);
check('nor a data URI at all', directive.includes('base64'), false);
// The obligation, stated: an unused supplied image is the failure people notice.
check('it says every image must appear', directive.includes('EVERY image above must appear'), true);
check('no images means no directive at all', contentImageDirective([]), '');

// A caption that never arrived still gets alt text rather than an empty string.
const undescribed = parseContentImages([png(40)]).images;
check('an undescribed image is still described as something',
  contentImageDirective(undescribed).includes('写真'), true);

// --- what reaches the document is the picture ---------------------------------
const doc = `<img src="${contentImageToken(1)}" alt="a"><img src="${contentImageToken(2)}" alt="b">`;
const embedded = embedContentImages(doc, withCaptions);
check('both markers are replaced', embedded.placements, [1, 1]);
check('with real data URIs', embedded.html.startsWith('<img src="data:image/png;base64,AAA'), true);
check('and no marker survives', /\{\{USER_IMAGE_\d+\}\}/.test(embedded.html), false);

// Repeats are legitimate — the same photo in a card and in a detail header.
const twice = embedContentImages(`${contentImageToken(1)} ${contentImageToken(1)}`, [withCaptions[0]]);
check('a marker used twice is substituted twice', twice.placements, [2]);

/*
 * And the case worth logging: an image the model never placed. The document
 * builds, renders and scores fine, so this is invisible from anywhere else.
 */
const one = embedContentImages(`<img src="${contentImageToken(1)}">`, withCaptions);
check('an unplaced image is counted as zero', one.placements, [1, 0]);

// --- markers the model invented -----------------------------------------------
/*
 * `{{USER_IMAGE_9}}` from the pattern of the others, when three were supplied.
 * Shipping one is a visibly broken image.
 */
const invented = stripContentImageTokens(`<img src="${contentImageToken(9)}"> ok`);
check('an invented marker is stripped', invented.html, '<img src=""> ok');
check('and reported by number', invented.stripped, [9]);
check('a clean document is untouched', stripContentImageTokens('<p>ok</p>').stripped, []);

// --- captioning is best-effort, never a gate ----------------------------------
const forCaption = parseContentImages([png(40), png(40)]).images;
let sent = null;
await captionImages(forCaption, 'カフェの注文画面', async (_sys, content, _max) => {
  sent = content;
  return JSON.stringify({ captions: ['一枚目', '二枚目'] });
});
check('the captions land in order', forCaption.map((i) => i.caption), ['一枚目', '二枚目']);
// One call for all of them, and it is the only place the bytes go.
check('every image was sent in ONE call',
  sent.filter((c) => c.type === 'image').length, 2);
check('with the brief as the trailing text block', sent[sent.length - 1].type, 'text');

const thrown = parseContentImages([png(40)]).images;
await captionImages(thrown, 'x', async () => { throw new Error('boom'); });
check('a thrown captioner costs the user nothing', thrown[0].caption, '');
const unparsable = parseContentImages([png(40)]).images;
await captionImages(unparsable, 'x', async () => 'すみません');
check('nor does an unparsable reply', unparsable[0].caption, '');
/*
 * Short lists are assigned by position and the rest left blank. Pairing them any
 * other way would put a true description on the wrong picture, and that text
 * becomes the alt attribute — a false statement is worse than a missing one.
 */
const short = parseContentImages([png(40), png(40)]).images;
await captionImages(short, 'x', async () => JSON.stringify({ captions: ['最初だけ'] }));
check('a short reply describes only what it described', short.map((i) => i.caption), ['最初だけ', '']);
check('no images means no call',
  await captionImages([], 'x', async () => { throw new Error('should not be called'); }), undefined);

// --- the pipeline keeps the bytes out -----------------------------------------
/*
 * Stated against the source, because the property is about what the other stages
 * are handed. `contentImages` reaches the design phase as a string; if it ever
 * becomes the images themselves, the arithmetic at the top of this file applies
 * again and nothing else here would notice.
 */
const design = read('src/orchestration/strands-design.ts');
check('the design phase takes the description, not the pictures',
  /contentImages\?: string/.test(design), true);
const graph = read('src/orchestration/graph.ts');
// The definition and its calls — the build's and the plan's, since 2026-09-14 — every one of them captioning.
const visionCalls = [...graph.matchAll(/invokeVision\(([^\n]*)/g)].slice(1);
check('and only the captioner is given image content',
  visionCalls.length >= 1 && visionCalls.every((m) => m[1].includes("'images:caption'")), true);
check('under its own ledger stage', /'images:caption'/.test(graph), true);

// --- the user can describe their own pictures ---------------------------------
/*
 * They know what the picture is; a vision call can only guess, and guessing
 * costs tokens. So a described image never reaches the captioner — and when
 * every attachment carries a description there is no captioning call at all,
 * which is the cheapest this feature gets.
 */
const described = parseContentImages([png(40), png(40)], ['白いマグ', '店の外観']);
check('a supplied description is kept', described.images.map((i) => i.caption), ['白いマグ', '店の外観']);
check('and marked as coming from the user', described.images.map((i) => i.fromUser), [true, true]);

let called = false;
await captionImages(described.images, 'x', async () => { called = true; return '{}'; });
check('a fully described set makes no call', called, false);
check('and keeps what the user wrote', described.images[0].caption, '白いマグ');

const partly = parseContentImages([png(40), png(40)], ['白いマグ']);
check('one described, one not', partly.images.map((i) => i.fromUser), [true, false]);
let sentCount = 0;
await captionImages(partly.images, 'x', async (_s, content) => {
  sentCount = content.filter((c) => c.type === 'image').length;
  return JSON.stringify({ captions: ['モデルが書いた'], roles: ['content'] });
});
check('only the undescribed one is sent', sentCount, 1);
check('what the user wrote stands', partly.images[0].caption, '白いマグ');
check('and the model fills the other', partly.images[1].caption, 'モデルが書いた');

/*
 * Aligned by ORIGINAL index. The accepted list and the input diverge the moment
 * an image is dropped, and a caption that slid up a place would be a true
 * sentence about the wrong picture — which then becomes its alt text.
 */
const withGap = parseContentImages([png(40), '', png(40)], ['一枚目', '無効', '三枚目']);
check('a dropped image does not shift the descriptions',
  withGap.images.map((i) => i.caption), ['一枚目', '三枚目']);

// A description is bounded like any other: it becomes alt text and it is
// concatenated into every later prompt.
const longOne = parseContentImages([png(40)], ['あ'.repeat(500)]);
check('a long description is cut to the bound',
  longOne.images[0].caption.length, MAX_CAPTION_CHARS);

// --- the prompt decides which picture is a reference ---------------------------
/*
 * The question this answers: with several attached, can the user still say "copy
 * this one and show the rest"? Yes — the captioner already has the words and the
 * pictures, so a role per image costs a few output tokens and no extra input.
 *
 * The cap of one is a fact about the pipeline, not a preference. runDesignSwarm,
 * invokeModel and invokeModelStreaming each take a single ImageInput, so "shown
 * to the model" is one slot end to end; N references would mean every design
 * stage looks at all of them.
 */
const roled = parseContentImages([png(40), png(40), png(40)]).images;
await captionImages(roled, 'この写真の配色を参考に、残りは商品画像として', async () =>
  JSON.stringify({ captions: ['参考', '商品A', '商品B'], roles: ['reference', 'content', 'content'] }));
check('the prompt can mark one as a reference', roled.map((i) => i.role),
  ['reference', 'content', 'content']);
const s1 = splitByRole(roled);
check('the reference is separated out', s1.reference?.index, 1);
check('and the rest stay placeable', s1.content.map((i) => i.index), [2, 3]);
check('nothing demoted when only one was marked', s1.demoted, []);

// It need not be the first: the composer sends them in attachment order, and the
// user's words decide, not the order they happened to pick files in.
const later = parseContentImages([png(40), png(40)]).images;
await captionImages(later, 'x', async () =>
  JSON.stringify({ captions: ['a', 'b'], roles: ['content', 'reference'] }));
check('any of them can be the reference', splitByRole(later).reference?.index, 2);
check('and the other is still placed', splitByRole(later).content.map((i) => i.index), [1]);

// Several marked: the first is kept and the rest go back to being placed, which
// is the more useful of the two jobs to get right by default.
const two = parseContentImages([png(40), png(40), png(40)]).images;
await captionImages(two, 'x', async () =>
  JSON.stringify({ captions: ['a', 'b', 'c'], roles: ['reference', 'reference', 'content'] }));
const s2 = splitByRole(two);
check('only one reference survives', s2.reference?.index, 1);
check('the extra is demoted rather than dropped', s2.content.map((i) => i.index), [2, 3]);
check('and the demotion is reported', s2.demoted, [2]);
check('a demoted image is content again', s2.content.map((i) => i.role), ['content', 'content']);

// An unknown or missing role is content, not an error.
const junk = parseContentImages([png(40), png(40)]).images;
await captionImages(junk, 'x', async () =>
  JSON.stringify({ captions: ['a', 'b'], roles: ['hero', null] }));
check('an unrecognised role reads as content', junk.map((i) => i.role), ['content', 'content']);
const noroles = parseContentImages([png(40)]).images;
await captionImages(noroles, 'x', async () => JSON.stringify({ captions: ['a'] }));
check('and so does a reply with no roles at all', noroles[0].role, 'content');
check('none of these leaves a reference behind', splitByRole(noroles).reference, null);

// --- and the pipeline acts on the split ---------------------------------------
check('the run separates the reference before building the directive',
  /const split = splitByRole\(contentImages\)/.test(graph), true);
check('a promoted image leaves the placeable list',
  /placeableImages = split\.content/.test(graph), true);
// An explicit `image` on the request is the slot the caller deliberately filled.
check('an explicit reference on the request is not overwritten',
  /if \(split\.reference && !imageInput\)/.test(graph), true);
check('and the directive is rebuilt after the split, not before',
  graph.indexOf('const split = splitByRole(contentImages)')
    < graph.indexOf('contentContext = contentImageDirective(placeableImages)'), true);

console.log(`
${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
