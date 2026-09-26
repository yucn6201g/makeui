// Tests for choosing photographs out of the curated library.
//
// The selection is deliberately conservative, and the tests are mostly about
// the restraint rather than the matching: a screen with a photograph in every
// panel is the clearest sign a design was generated, and the failure mode of a
// keyword matcher is to say yes to everything. The other half is the URL check,
// which exists because a model handed three real URLs will sometimes write a
// fourth — and a 404 is invisible to every other check in the pipeline.
//
//   node test/stock-images.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.CLOUDFRONT_DOMAIN = 'cdn.example.net';
execSync(
  `npx esbuild "${path.join(root, 'src/tools/images/stock-images.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/si.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'inherit', cwd: root }
);
const mod = await import(pathToFileURL(path.join(root, 'dist/si.test.mjs')).href);
const { pickStockImages, stockImageInstructions, stockImageBrief, repairStockUrls, loadStockIndex } = mod;

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/**
 * A stand-in library, served instead of S3.
 *
 * The module caches the index for the life of the process, so priming the cache
 * through one S3 read is enough — after that every call is pure.
 */
const one = (id, subject, category, title, tags, query) => ({
  id, subject, category, key: `stock/${subject}/${id}.jpg`,
  width: 1600, height: 1000, aspect: 1.6, title, tags, query,
  license: 'cc0', licenseUrl: '', creator: 'a', source: 'flickr', sourceUrl: '', attribution: 'x',
});
const IMAGES = [
  one('o1', 'office', 'scene', 'Office Desk', ['office', 'desk', 'workplace'], 'office desk'),
  one('o3', 'office', 'scene', 'Coworking', ['office'], 'coworking'),
  one('m1', 'meeting', 'scene', 'Meeting Room', ['office', 'meeting'], 'meeting room'),
  one('p1', 'team', 'people', 'Team', ['team', 'people'], 'team'),
  one('w1', 'warehouse', 'scene', 'Warehouse Shelves', ['warehouse', 'shelves'], 'warehouse'),
  one('n1', 'forest', 'place', 'Forest', ['forest'], 'forest path'),
  // Transcribed from the real index, markup and all.
  one('b1', 'butter', 'food', "<div class='fn'> Butter dish</div>", ['butter'], 'butter dish'),

  /*
   * The four ways a correctly matched picture is still the wrong picture. All
   * four are transcribed from the real index, because all four shipped.
   */
  // Artwork, not a photograph. Beside four photographs on a product grid it
  // reads as a broken image that happened to load.
  one('c1', 'milk', 'food', 'Milk carton clipart, dairy illustration', ['clipart', 'milk', 'illustration'], 'milk carton'),
  // A real photograph of the right subject, in the wrong century.
  one('v1', 'warehouse', 'scene', 'C & P Tel. Co', ['boxes', 'shelves', 'vintage', 'warehouse'], 'warehouse shelves'),
  // Keyword spam: it matches the subject in title AND tags, is large, is
  // landscape, and is a picture of nothing. It won on every signal.
  one('k1', 'warehouse', 'scene', 'Pentagon wireframe, dodecahedron storage, literal, subject, data warehouse, product management, private cloud, monitoring',
    ['blockstorage', 'data', 'datawarehouse', 'compute'], 'warehouse storage'),
  // Same picture, different file. Two of these in one offer is the repeated
  // thumbnail that reads as a rendering bug.
  one('d1', 'tshirt', 'apparel', 'Stack of folded t-shirts', ['tshirt', 'clothing', 'stack'], 'folded t-shirts'),
  one('d2', 'tshirt', 'apparel', 'Stack of folded t-shirts', ['tshirt', 'clothing', 'stack'], 'folded t-shirts'),
  // A clean one of the same subject, so there is something better to prefer.
  one('t1', 'tshirt', 'apparel', 'Plain white t-shirt on hanger', ['tshirt', 'clothing', 'white'], 'plain t-shirt'),
  // Its own title names something other than the subject, while the tags are
  // on-subject: a photograph of a person who happened to be in a warehouse.
  one('j1', 'warehouse', 'scene', 'Joseph McReynolds, Nat. Pub. Co', ['industrial', 'interior', 'shelves', 'warehouse'], 'warehouse shelves'),
  one('g1', 'warehouse', 'scene', 'Warehouse shelves stacked', ['warehouse', 'shelves', 'logistics'], 'warehouse shelves'),
];

// Prime the module's cache without touching S3.
const { S3Client } = await import('@aws-sdk/client-s3');
S3Client.prototype.send = async () => ({
  Body: { transformToString: async () => JSON.stringify({ count: IMAGES.length, images: IMAGES }) },
});
check('the library loads', (await loadStockIndex()).length, IMAGES.length);
// Titles come from the photographers and some carry markup — measured in the
// real index, a butter photograph is titled `<div class='fn'> Butter dish</div>`.
// It reaches a model as the description of the picture, and the obvious thing
// to do with a description is copy it into an alt attribute.
check('markup in a title is stripped at the boundary',
  (await loadStockIndex()).find((i) => i.id === 'b1')?.title, 'Butter dish');

const urls = (picked) => picked.map((p) => p.url);

// --- when photographs are offered at all ---------------------------------
let picked = await pickStockImages('社内の備品貸出を管理するツール。倉庫の在庫と申請フロー。');
check('a warehouse brief gets photographs', picked.length > 0, true);
// The whole change: the brief names a subject, and the subject is what it gets.
// Under the previous taxonomy 「倉庫」 mapped to the category "workspace", which
// also contained laptops and coffee cups — and 「商品」 mapped to "product",
// which meant any photograph at all.
check('and they are of that subject', urls(picked).some((u) => u.includes('/warehouse/')), true);

// The important negative. Most business screens want charts and illustrations,
// and a matcher that always says yes is how every panel ends up with a stock photo.
check('a brief with no visual domain gets none',
  (await pickStockImages('経費精算の申請と承認のワークフロー。金額の集計と月次レポート。')).length, 0);
check('an empty brief gets none', (await pickStockImages('')).length, 0);

// --- restraint ------------------------------------------------------------
picked = await pickStockImages('オフィスの会議室予約システム。社員のプロフィールと打ち合わせ。', 5);
check('at most two of one subject',
  urls(picked).filter((u) => u.includes('/office/')).length <= 2, true);
check('the limit is honoured', (await pickStockImages('オフィス 社員 倉庫 店舗 商品 背景', 3)).length <= 3, true);

// --- an explicit request for a photograph ---------------------------------
// The domain hints are a bridge from Japanese briefs to English tags, and they
// carry no word for "photograph" — so the one instruction that unambiguously
// asks for one matched nothing, and an edit answered it by inventing a URL.
check('a bare request for a photo matches no domain',
  (await pickStockImages('写真を追加してください')).length, 0);
check('and is answered when the caller says it was asked for',
  (await pickStockImages('写真を追加してください', 4, { anyCategory: true })).length > 0, true);
// The escape hatch must not become the default: restraint is the feature.
check('a domain-less brief still gets none by default',
  (await pickStockImages('経費精算の申請と承認のワークフロー。')).length, 0);
// A brief that does name a domain is unaffected by the flag — it must not
// suddenly return unrelated categories.
check('a matching brief is unchanged by the flag',
  urls(await pickStockImages('倉庫の在庫', 3, { anyCategory: true })),
  urls(await pickStockImages('倉庫の在庫', 3)));
check('the per-category cap still holds',
  (await pickStockImages('写真', 6, { anyCategory: true })).filter((p) => p.url.includes('/office/')).length <= 2, true);

// --- the design-phase block -----------------------------------------------
// Sent before anything is designed, so screens are composed around the picture
// rather than having one fitted into a finished layout.
check('no design block when there is nothing to offer', stockImageBrief([]), '');
const brief = stockImageBrief(await pickStockImages('倉庫の在庫と備品'));
check('the design block describes the pictures', /Warehouse Shelves/.test(brief), true);
// A specification is not the place for a URL: a designer that quotes one invites
// the assembler to copy it out of prose instead of from the verbatim list.
check('the design block carries no URLs', /https?:\/\//.test(brief), false);
check('it asks for placement to be decided', /配置場所/.test(brief), true);
check('and keeps the restraint', /置かないでください/.test(brief), true);

// --- the prompt block -----------------------------------------------------
check('no block when there is nothing to offer', stockImageInstructions([]), '');
const block = stockImageInstructions(picked);
check('the block lists the real URLs', picked.every((p) => block.includes(p.url)), true);
// Without this half the model uses every image it is given, everywhere.
check('it says where not to use them', /使ってはいけない場所/.test(block), true);
check('it forbids inventing URLs', /一覧にないURL/.test(block), true);

// --- invented URLs --------------------------------------------------------
const real = `https://cdn.example.net/stock/office/o1.jpg`;
const fake = `https://cdn.example.net/stock/office/does-not-exist.jpg`;

let r = await repairStockUrls(`<img src="${real}" alt="x">`);
check('a real URL is left alone', r.fixed, 0);
check('and the document is untouched', r.html.includes(real), true);

// With nothing offered for this run, an invented URL becomes the neutral "no
// image" block — not a photograph plucked out of the library by index, which is
// what this used to do. That substitute resolved, so every check downstream was
// happy, and the picture had no relationship to the page it landed on. A hero
// band has no item label, so `assignItemImages` could not rescue it either:
// exactly the largest images on the screen kept the arbitrary photograph.
r = await repairStockUrls(`<img src="${fake}" alt="x">`);
check('an invented URL is replaced', r.fixed, 1);
check('the invented URL is gone', r.html.includes(fake), false);
check('and nothing untrue is put in its place', /data:image\/svg\+xml/.test(r.html), true);

// When this run did choose photographs, they are what an invented URL becomes:
// those were matched against this brief, so the substitute is at least about
// the right thing.
const offered = await pickStockImages('倉庫の棚の在庫管理', 3);
if (offered.length > 0) {
  const withOffer = await repairStockUrls(`<img src="${fake}" alt="x">`, offered);
  check('an invented URL falls back to a photograph chosen for this brief',
    withOffer.html.includes(offered[0].url), true);
}

r = await repairStockUrls(`<img src="${fake}"><img src="${real}"><img src="${fake}">`);
check('several invented URLs are all replaced', r.fixed, 2);
check('the real one among them survives', r.html.includes(real), true);

// A document that mentions no stock URLs must not be walked at all.
r = await repairStockUrls('<html><body><h1>hi</h1></body></html>');
check('an unrelated document is a no-op', r.fixed, 0);
// Other hosts are none of our business.
r = await repairStockUrls('<img src="https://example.com/stock/office/x.jpg">');
check('another host is not rewritten', r.fixed, 0);

// --- a matched subject is not the same thing as a usable picture -----------
//
// Every case below was a correct subject match. The library simply had no order
// inside a subject: the tags are English and every brief is Japanese, so the
// brief-overlap score was zero for almost everything and the winner was
// whichever image happened to be collected first. That is how a project
// management tool got a fashion portrait and a dental clinic got a photograph
// from a refugee medical centre.
const shelves = await pickStockImages('倉庫の棚の在庫管理', 5);
check('artwork is never offered as a photograph',
  (await pickStockImages('牛乳の販売サイト', 5)).some((p) => /c1\.jpg/.test(p.url)), false);
check('a vintage photograph loses to a current one',
  shelves.findIndex((p) => /g1\.jpg/.test(p.url)) < shelves.findIndex((p) => /v1\.jpg/.test(p.url)) ||
    !shelves.some((p) => /v1\.jpg/.test(p.url)), true);
check('keyword spam is not offered', shelves.some((p) => /k1\.jpg/.test(p.url)), false);
check('a title naming something else loses to one naming the subject',
  shelves[0] && /g1\.jpg/.test(shelves[0].url), true);

const shirts = await pickStockImages('Tシャツの通販サイト', 5);
check('the same picture is not offered twice',
  new Set(shirts.map((p) => p.description)).size, shirts.length);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
