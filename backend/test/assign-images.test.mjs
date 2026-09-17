// Tests for giving every picture on the page a reason to be that picture.
//
// The defect being fixed, transcribed from a real generated storefront:
//
//   name: 'オーガニックコットンTシャツ'  image: .../stock/office/35f3fd7a….jpg
//   name: 'ウールニットセーター'        image: .../stock/workspace/c327….webp
//   name: 'デニムジーンズ'              image: .../stock/office/4a2a….jpg
//
// Three garments, two photographs of an office desk. Every URL resolved, the
// markup was correct and the audits were clean — the page was simply wrong in
// the one way only a person looking at it could detect. So the assertions here
// are about meaning, not about validity: butter must get butter.
//
//   node test/assign-images.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.CLOUDFRONT_DOMAIN = 'cdn.example.net';
execSync(
  `npx esbuild "${path.join(root, 'src/tools/assign-images.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/ai.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'inherit', cwd: root }
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/** A stand-in library, served instead of S3. Two photographs of most subjects. */
const img = (subject, category, n) => ({
  id: `${subject}${n}`, subject, category,
  key: `stock/${subject}/${subject}${n}.jpg`,
  width: 1600, height: 1000, aspect: 1.6,
  title: `${subject} ${n}`, tags: [subject], query: subject,
  license: 'cc0', licenseUrl: '', creator: '', source: '', sourceUrl: '', attribution: '',
});
const IMAGES = [
  img('butter', 'food', 1), img('butter', 'food', 2),
  img('cheese', 'food', 1),
  img('bread', 'food', 1),
  img('tshirt', 'apparel', 1), img('tshirt', 'apparel', 2),
  img('jeans', 'apparel', 1),
  img('knitwear', 'apparel', 1),
  img('office', 'scene', 1),
  img('warehouse', 'scene', 1),
];

const { S3Client } = await import('@aws-sdk/client-s3');
S3Client.prototype.send = async () => ({
  Body: { transformToString: async () => JSON.stringify({ count: IMAGES.length, images: IMAGES }) },
});

const { assignItemImages, slotForeignImages } = await import(pathToFileURL(path.join(root, 'dist/ai.test.mjs')).href);

const U = (s, n) => `https://cdn.example.net/stock/${s}/${s}${n}.jpg`;
/** Whatever the model happened to write. Every assertion is about what replaces it. */
const WRONG = U('office', 1);
const subjectOf = (url) => (url.match(/\/stock\/([a-z]+)\//) ?? [])[1] ?? null;

// --- the case this exists for ---------------------------------------------
const CATALOGUE = `<html><body>
<script type="text/jsx" data-file="src/data/products.ts">
export const PRODUCTS = [
  { id: '1', name: 'カルピスバター 有塩 450g', price: 1580, image: '${WRONG}', category: '乳製品' },
  { id: '2', name: 'オーガニックコットンTシャツ', price: 2980, image: '${WRONG}', category: '衣料' },
  { id: '3', name: 'デニムジーンズ', price: 6980, image: '${WRONG}', category: '衣料' },
  { id: '4', name: '食パン 6枚切り', price: 280, image: '${WRONG}', category: 'パン' },
];
</script>
</body></html>`;

let r = await assignItemImages(CATALOGUE);
const got = [...r.html.matchAll(/image: '([^']+)'/g)].map((m) => subjectOf(m[1]));
check('butter gets butter', got[0], 'butter');
check('a T-shirt gets a T-shirt', got[1], 'tshirt');
check('jeans get jeans', got[2], 'jeans');
check('bread gets bread', got[3], 'bread');
check('and nothing kept the office desk', r.html.includes(WRONG), false);
check('all four counted as matched', r.matched, 4);
check('none were cleared', r.cleared, 0);

// --- the second most recognisable tell -------------------------------------
// Six products of one subject must not all show the same photograph. An
// identical thumbnail repeated down a catalogue reads as a rendering bug.
const SAME = `<html><body>
<script type="text/jsx" data-file="src/data/products.ts">
export const PRODUCTS = [
  { id: '1', name: '無地Tシャツ 白', image: '${WRONG}' },
  { id: '2', name: '無地Tシャツ 黒', image: '${WRONG}' },
];
</script>
</body></html>`;
r = await assignItemImages(SAME);
let urls = [...r.html.matchAll(/image: '([^']+)'/g)].map((m) => m[1]);
check('two shirts get two different photographs', urls[0] !== urls[1], true);
check('but both are of shirts', urls.map(subjectOf), ['tshirt', 'tshirt']);

// --- when the library has nothing about it --------------------------------
// The whole point. A photograph of a desk on a car part is worse than no
// photograph, so the slot gets a neutral block instead of the nearest thing.
const UNKNOWN = `<html><body>
<script type="text/jsx" data-file="src/data/products.ts">
export const PRODUCTS = [
  { id: '1', name: 'ブレーキパッド R33 前輪用', image: '${WRONG}' },
];
</script>
</body></html>`;
r = await assignItemImages(UNKNOWN);
check('an unmatched item gets no photograph', r.html.includes(WRONG), false);
check('it gets a placeholder instead', /image: 'data:image\/svg\+xml/.test(r.html), true);
check('and is counted as cleared', [r.matched, r.cleared], [0, 1]);

// The category tier: butter with no butter in the library is still food, and a
// photograph of cheese is a picture of the right kind of thing.
const NO_BUTTER = IMAGES.filter((i) => i.subject !== 'butter');
S3Client.prototype.send = async () => ({
  Body: { transformToString: async () => JSON.stringify({ count: NO_BUTTER.length, images: NO_BUTTER }) },
});
// The module caches the index for the life of the process, so this run still
// sees the full library — asserted rather than assumed, so the test does not
// quietly claim to have exercised a path it did not.
r = await assignItemImages(`<html><body><script type="text/jsx" data-file="src/data/p.ts">
export const P = [{ name: 'バター 200g', image: '${WRONG}' }];
</script></body></html>`);
check('the library is cached, so this is still the full one', subjectOf(r.html.match(/image: '([^']+)'/)[1]), 'butter');

// --- what must not be touched ---------------------------------------------
r = await assignItemImages(`<html><body><img src="https://example.com/photo.jpg" alt="バター"></body></html>`);
check('another host is left alone', r.html.includes('https://example.com/photo.jpg'), true);
check('and produces no assignment', r.assignments.length, 0);

r = await assignItemImages('<html><body><h1>ただのページ</h1></body></html>');
check('a document with no photographs is a no-op', r.assignments.length, 0);

// A hero band has no item name and never had one. Blanking it would remove a
// picture that was fine — "no label" is not the same as "label matched nothing".
r = await assignItemImages(`<html><body>
<script type="text/jsx" data-file="src/screens/Home.tsx">
const HERO = '${WRONG}';
export default function Home(){ return <div style={{backgroundImage:'url('+HERO+')'}} />; }
</script></body></html>`);
check('an unlabelled background is kept', r.html.includes(WRONG), true);
check('and reported as kept, not matched', [r.matched, r.cleared], [0, 0]);

// --- <img> tags, where the label is the alt text --------------------------
r = await assignItemImages(`<html><body>
<div class="card"><img src="${WRONG}" alt="カルピスバター 有塩"><h3>バター</h3></div>
</body></html>`);
check('an img is matched on its alt text', subjectOf(r.html.match(/src="([^"]+)"/)[1]), 'butter');

// Falling back to the heading above it, for an img with no useful alt.
r = await assignItemImages(`<html><body>
<article><h3>ウールニットセーター</h3><img src="${WRONG}" alt=""></article>
</body></html>`);
check('an img with no alt uses the heading above it',
  subjectOf(r.html.match(/src="([^"]+)"/)[1]), 'knitwear');

// --- the boundary between one item and the next ---------------------------
// A field must never read the name of the product before it. This is the whole
// reason the search walks to the enclosing brace rather than scanning backwards
// for the nearest `name:`.
const ADJACENT = `<html><body><script type="text/jsx" data-file="src/data/p.ts">
export const P = [
  { id: '1', name: 'バター' },
  { id: '2', name: 'デニムジーンズ', image: '${WRONG}' },
];
</script></body></html>`;
r = await assignItemImages(ADJACENT);
check('a field reads its own object, not the previous one',
  subjectOf(r.html.match(/image: '([^']+)'/)[1]), 'jeans');

// --- the slot the assembler leaves ----------------------------------------
// Measured on a real dairy shop: handed five URLs including two of butter, the
// assembler wrote a complete eight-product catalogue — names, prices, specs,
// options — and gave not one of them an image. It had been told to use
// photographs sparingly, which is right for a dashboard and wrong for a shop,
// and it cannot tell which of the five URLs is the butter one anyway. So it is
// asked for the one thing it can do reliably: leave a slot and name the item.
const SLOTS = `<html><body>
<script type="text/jsx" data-file="src/data/products.ts">
export const PRODUCTS = [
  { id: '1', name: '北海道産 無塩バター 200g', price: 1280, image: '__PHOTO__' },
  { id: '2', name: 'チェダーチーズ 300g', price: 1680, image: '__PHOTO__' },
  { id: '3', name: 'ブレーキパッド R33', price: 8800, image: '__PHOTO__' },
];
</script>
</body></html>`;
r = await assignItemImages(SLOTS);
urls = [...r.html.matchAll(/image: '([^']+)'/g)].map((m) => m[1]);
check('a slot on butter becomes butter', subjectOf(urls[0]), 'butter');
check('a slot on cheese becomes cheese', subjectOf(urls[1]), 'cheese');
check('a slot with no match becomes a placeholder', urls[2].startsWith('data:image/svg+xml'), true);
check('and no token survives', r.html.includes('__PHOTO__'), false);
check('counted as two matched, one cleared', [r.matched, r.cleared], [2, 1]);

// An <img> slot resolves on its alt text, the same way a URL does.
r = await assignItemImages(`<html><body><img src="__PHOTO__" alt="グラスフェッド バター 250g"></body></html>`);
check('an img slot resolves on its alt', subjectOf(r.html.match(/src="([^"]+)"/)[1]), 'butter');

// The token is an instruction to this pass, not a picture. Shipping it is a
// broken image on every product card, so it must never survive — not when the
// label is missing, and not when the library could not be loaded at all.
r = await assignItemImages(`<html><body><div style="background-image:url(__PHOTO__)"></div></body></html>`);
check('a slot nothing could label is still blanked', r.html.includes('__PHOTO__'), false);
check('and is reported as cleared', r.cleared, 1);

const savedSend = S3Client.prototype.send;
S3Client.prototype.send = async () => { throw new Error('no library'); };
// The module caches, so this run still sees the primed library — the empty-library
// path is exercised by the placeholder probe rather than here. Asserted so the
// test does not claim a path it did not take.
r = await assignItemImages(SLOTS);
check('the cache means the library is still there', r.matched, 2);
S3Client.prototype.send = savedSend;

// --- the two halves of the taxonomy must agree ----------------------------
// The subjects are collected by scripts/subjects.mjs and recognised by
// src/tools/subject-terms.ts, and they are deliberately separate files: the
// pictures change when someone re-curates, the words change constantly. The
// cost of that separation is that they can drift apart silently — a term for a
// subject nobody collects matches nothing, and a collected subject with no
// terms is six photographs that can never be chosen.
execSync(
  `npx esbuild "${path.join(root, 'src/tools/subject-terms.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/st.test.mjs')}"`,
  { stdio: 'inherit', cwd: root }
);
const { SUBJECT_TERMS, SUBJECT_CATEGORY, matchSubject } = await import(pathToFileURL(path.join(root, 'dist/st.test.mjs')).href);
const { SUBJECTS } = await import(pathToFileURL(path.join(root, 'scripts/subjects.mjs')).href);

check('every recognised subject is collected',
  Object.keys(SUBJECT_TERMS).filter((s) => !SUBJECTS[s]), []);
check('every collected subject is recognised',
  Object.keys(SUBJECTS).filter((s) => !SUBJECT_TERMS[s]), []);
// The category table decides the fallback tier, and it is needed exactly when
// the library has no image of the subject to read the category from — so it
// cannot be derived, and can therefore drift.
check('every subject has a category',
  Object.keys(SUBJECTS).filter((s) => !SUBJECT_CATEGORY[s]), []);
check('and it is the one it was collected under',
  Object.entries(SUBJECTS)
    .filter(([s, { category }]) => SUBJECT_CATEGORY[s] !== category)
    .map(([s]) => s), []);

// Specificity: a longer term must win, or 「ランニングシューズ」 becomes shoes and
// 「コーヒーカップ」 becomes tableware.
check('the more specific term wins', matchSubject('ランニングシューズ 26cm'), 'sneakers');
check('and again', matchSubject('コーヒーカップ 2客セット'), 'coffee');
// The negative that matters most: a matcher that always says yes is the defect.
check('an unknown item matches nothing', matchSubject('ブレーキパッド R33 前輪用'), null);

// A word can name a thing on a product and mean something else in a brief.
// Measured on a real run: a clothing shop was offered photographs of dining
// tables and rice, because its design plan discussed data tables.
const { matchSubjects } = await import(pathToFileURL(path.join(root, 'dist/st.test.mjs')).href);
check('a data table in a brief is not furniture',
  matchSubjects('商品一覧はテーブルで表示し、背景は白。ライトモードのみ対応。'), []);
check('but a table on a product still is',
  matchSubject('オーク無垢材 ダイニングテーブル 180cm'), 'table');
check('a brief about furniture still matches on the specific word',
  matchSubjects('ソファとダイニングチェアを売る家具のショップ').includes('sofa'), true);
check('and 本日 is not a book', matchSubjects('本日の出荷予定を一覧で表示する'), []);
check('nor is 日本 in an item name', matchSubject('日本製 ステンレス'), null);
// 「日本茶」 held both 「本」 and 「茶」, one character each, so the winner depended
// on where two equal-length terms landed after sorting. A coin flip is not a rule.
check('日本茶 is tea', matchSubject('宇治 日本茶 ティーバッグ'), 'tea');
check('while a book product still matches', matchSubject('絵本 はらぺこあおむし'), 'book');

// Katakana loanwords collide constantly. 「リング」 was a jewellery term and is a
// substring of リファクタリング, フィルタリング, モニタリング and エンジニアリング.
check('リファクタリング is not jewellery', matchSubject('技術書 リファクタリング 第2版'), null);
check('フィルタリング is not jewellery either', matchSubject('フィルタリング設定'), null);
// And the terms it was removed in favour of still work.
check('a real ring still matches', matchSubject('シルバー 指輪 15号'), 'jewellery');
check('so does a necklace', matchSubject('パール ネックレス 40cm'), 'jewellery');
// The other collision from the same run: 「ダイニング」 is longer than 「テーブル」,
// so a dining table resolved to `restaurant` until the compound was spelled out.
check('a dining table is furniture, not a restaurant',
  matchSubject('オーク無垢材 ダイニングテーブル 180cm'), 'table');
// 北海道 appears in more Japanese product names than roads do.
check('北海道 is not a road', matchSubject('北海道フェア 詰め合わせ'), null);
check('but butter in it still wins', matchSubject('北海道産 無塩バター 200g'), 'butter');

// Japanese compounds put the head noun last, and the matcher prefers the longest
// term — so a bread roll made with butter went to `butter`. Measured on a real
// dairy shop, where three of twelve products were bread illustrated as dairy.
check('バターロール is bread', matchSubject('バターロール 6個入'), 'bread');
check('チーズパン is bread', matchSubject('チーズパン 5個入'), 'bread');
check('ミルクパン is bread', matchSubject('ミルクパン 8個入'), 'bread');
// And the ingredients on their own are still themselves.
check('plain butter is still butter', matchSubject('発酵バター 150g'), 'butter');
check('plain cheese is still cheese', matchSubject('ゴーダチーズ 200g'), 'cheese');
check('an empty label matches nothing', matchSubject(''), null);
check('a bare id matches nothing', matchSubject('SKU-00417'), null);

// --- invented external image URLs ------------------------------------------
//
// Measured across five real generations: 12 to 18 URLs each, every one made up
// — images.unsplash.com with a photo id that does not exist, via.placeholder,
// picsum. This is why the __PHOTO__ slot count was zero on every run while the
// pages were full of image sources: the model reliably writes something
// image-shaped, it just writes a URL instead of the slot.
//
// The licence half is the serious one. Unsplash forbids redistribution, and
// redistribution is exactly what this product does — the image is embedded in a
// generated page, published on a URL, and handed over inside a downloadable
// project. The curated library is CC0 for precisely that reason.
const withForeign = `<img src="https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=500&h=500&fit=crop" alt="x">
<img src="https://via.placeholder.com/400x300" alt="y">
<img src="https://picsum.photos/400/300" alt="z">`;
check('invented external image URLs become slots', slotForeignImages(withForeign).replaced, 3);
check('and none of them survives',
  /unsplash|placeholder\.com|picsum/.test(slotForeignImages(withForeign).html), false);

// Our own CDN is not foreign, and neither is a data URI the pipeline drew.
const ours = `<img src="https://cdn.example.net/stock/tshirt/a.jpg"><img src="data:image/svg+xml;utf8,%3Csvg%3E">`;
check('our own library is left alone', slotForeignImages(ours).replaced, 0);
// A relative asset path is the project's own file, not a hotlink.
check('a relative path is left alone',
  slotForeignImages(`<img src="../assets/logo.png">`).replaced, 0);
// A social link is a link, not an image source.
check('an ordinary external link is left alone',
  slotForeignImages(`<a href="https://instagram.com/shop">Instagram</a>`).replaced, 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
