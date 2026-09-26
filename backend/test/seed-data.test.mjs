// Whether the mock's data looks like data.
//
// Observed on a generation that scored well and worked: every shelf in a
// warehouse table held exactly eight items, and every order in the seed set had
// the same approver. Nothing in the pipeline could see it — the layout is right,
// the components work, the controls are live, and the numbers are the one thing
// no audit reads. It is also the first thing a person notices, and it is what
// makes a mock read as a template with values dropped into it.
//
//   node test/seed-data.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/orchestration/audit/seed-data-audit.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/sdt.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'inherit', cwd: root }
);
const { auditSeedData } = await import(pathToFileURL(path.join(root, 'dist/sdt.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const fence = (p, body) => `@@@makeui:file ${p}\n${body}\n@@@makeui:endfile\n`;
const project = (...blocks) => `<!DOCTYPE html><html><body>\n${blocks.join('')}</body></html>`;

const records = (rows) =>
  `export const ORDERS = [\n${rows.map((r) => `  {\n${Object.entries(r).map(([k, v]) => `    ${k}: ${v},`).join('\n')}\n  },`).join('\n')}\n];`;

const varied = records([
  { id: "'o1'", quantity: 12, approver: "'山田'" },
  { id: "'o2'", quantity: 40, approver: "'佐藤'" },
  { id: "'o3'", quantity: 7, approver: "'鈴木'" },
  { id: "'o4'", quantity: 25, approver: "'山田'" },
  { id: "'o5'", quantity: 3, approver: "'田中'" },
  { id: "'o6'", quantity: 18, approver: "'佐藤'" },
]);
// Transcribed from a real run: six orders, one approver.
const flatApprover = records([
  { id: "'o1'", quantity: 12, approver: "'u4'" },
  { id: "'o2'", quantity: 40, approver: "'u4'" },
  { id: "'o3'", quantity: 7, approver: "'u4'" },
  { id: "'o4'", quantity: 25, approver: "'u4'" },
  { id: "'o5'", quantity: 3, approver: "'u4'" },
  { id: "'o6'", quantity: 18, approver: "'u4'" },
]);

const ids = (doc) => auditSeedData(doc).map((d) => d.id);

check('a field identical across every record is reported',
  ids(project(fence('src/data/orders.ts', flatApprover))), ['seed-data-flat']);
check('and the finding names the field and the value',
  /approver（6件すべて 'u4'）/.test(auditSeedData(project(fence('src/data/orders.ts', flatApprover)))[0].instruction), true);
check('varied data is left alone',
  ids(project(fence('src/data/orders.ts', varied))), []);

// Four records repeating is a small fixture, not a tell. The threshold exists so
// a two-row example table is not rewritten for looking like a two-row example.
const short = records([
  { id: "'o1'", quantity: 5, approver: "'u4'" },
  { id: "'o2'", quantity: 5, approver: "'u4'" },
  { id: "'o3'", quantity: 5, approver: "'u4'" },
  { id: "'o4'", quantity: 5, approver: "'u4'" },
]);
check('too few records to judge is not judged',
  ids(project(fence('src/data/orders.ts', short))), []);

// A currency or a unit really is the same on every row of real data.
const sameCurrency = records([
  { id: "'o1'", amount: 1200, currency: "'JPY'" },
  { id: "'o2'", amount: 4400, currency: "'JPY'" },
  { id: "'o3'", amount: 780, currency: "'JPY'" },
  { id: "'o4'", amount: 2500, currency: "'JPY'" },
  { id: "'o5'", amount: 310, currency: "'JPY'" },
]);
check('a field whose repetition is normal is exempt',
  ids(project(fence('src/data/orders.ts', sameCurrency))), []);

// Only the data modules. A component with five identical props is a different
// question and not this one.
check('files outside the data directories are not scanned',
  ids(project(fence('src/components/ui/Table.tsx', flatApprover))), []);

check('a document that is not a project has no data to read',
  ids('<!DOCTYPE html><html><body><h1>hi</h1></body></html>'), []);

// --- an image source that can be empty --------------------------------------
//
// `<img src="">` is not "no picture", it is a request for the CURRENT PAGE: the
// browser resolves the empty URL against the document and fetches the document
// again as an image. Measured on a real Vue generation —
// `return getProduct(id)?.image || ''` with no image on any record — two
// console errors and an empty box, on a page where every file compiled, every
// screen rendered and every control worked.
check('a fallback to the empty string is reported',
  ids(project(
    fence('src/data/products.ts', varied),
    fence('src/screens/CartScreen.vue', `function getProductImage(id) {
  return getProduct(id)?.image || '';
}`),
  )).includes('empty-image-src'), true);

check('and a literal empty src is too',
  ids(project(
    fence('src/data/products.ts', varied),
    fence('src/screens/HomeScreen.tsx', `export default function S() { return <img src="" alt="x" />; }`),
  )).includes('empty-image-src'), true);

// A fallback to a real placeholder is the correct shape and must not be flagged.
check('a fallback to a real placeholder is left alone',
  ids(project(
    fence('src/data/products.ts', varied),
    fence('src/screens/HomeScreen.tsx', `export default function S() { return <img src={p.image || PLACEHOLDER} alt="x" />; }`),
  )).includes('empty-image-src'), false);

// The photo slot is supposed to be the same on every record.
//
// `__PHOTO__` is this pipeline's own marker — the image assignment replaces it
// with a real photograph per record at the end of the run, and `auditSeedData`
// itself tells the model to write it a hundred lines further down. Reporting it
// as flat data contradicts that instruction inside one audit, and the repair a
// model makes when told to "vary this field" is to invent image URLs, which
// removes the slot and ships broken images. Measured on the v199 Svelte run:
// `imageUrl（20件すべて '__PHOTO__'）`.
const photoRecords = records([
  { id: "'p1'", name: "'商品A'", price: 1200, imageUrl: "'__PHOTO__'" },
  { id: "'p2'", name: "'商品B'", price: 3400, imageUrl: "'__PHOTO__'" },
  { id: "'p3'", name: "'商品C'", price: 890, imageUrl: "'__PHOTO__'" },
  { id: "'p4'", name: "'商品D'", price: 5600, imageUrl: "'__PHOTO__'" },
  { id: "'p5'", name: "'商品E'", price: 2300, imageUrl: "'__PHOTO__'" },
  { id: "'p6'", name: "'商品F'", price: 780, imageUrl: "'__PHOTO__'" },
]);
check('the photo slot is not flat data',
  ids(project(fence('src/data/products.ts', photoRecords))), []);

// And a field that really is identical on every record still is, in the same
// file, so this is a narrower net rather than no net.
const photoAndFlat = records([
  { id: "'p1'", name: "'商品A'", status: "'在庫あり'", imageUrl: "'__PHOTO__'" },
  { id: "'p2'", name: "'商品B'", status: "'在庫あり'", imageUrl: "'__PHOTO__'" },
  { id: "'p3'", name: "'商品C'", status: "'在庫あり'", imageUrl: "'__PHOTO__'" },
  { id: "'p4'", name: "'商品D'", status: "'在庫あり'", imageUrl: "'__PHOTO__'" },
  { id: "'p5'", name: "'商品E'", status: "'在庫あり'", imageUrl: "'__PHOTO__'" },
  { id: "'p6'", name: "'商品F'", status: "'在庫あり'", imageUrl: "'__PHOTO__'" },
]);
const both = auditSeedData(project(fence('src/data/products.ts', photoAndFlat)));
check('a genuinely flat field beside it still is', both.map((d) => d.id), ['seed-data-flat']);
check('and only that field is named',
  /status/.test(both[0].instruction) && !/imageUrl/.test(both[0].instruction), true);

// A data: URI is a payload, not a reference.
//
// v199 Svelte carried `url（5件すべて 'data:text/csv;base64,'）` — the prefix of
// the CSV export link every row hands to the same download. That is the same
// string on purpose, and telling a model to vary it produces five
// differently-broken data URIs.
const exportRows = records([
  { id: "'r1'", label: "'1月'", url: "'data:text/csv;base64,AAA'" },
  { id: "'r2'", label: "'2月'", url: "'data:text/csv;base64,AAA'" },
  { id: "'r3'", label: "'3月'", url: "'data:text/csv;base64,AAA'" },
  { id: "'r4'", label: "'4月'", url: "'data:text/csv;base64,AAA'" },
  { id: "'r5'", label: "'5月'", url: "'data:text/csv;base64,AAA'" },
  { id: "'r6'", label: "'6月'", url: "'data:text/csv;base64,AAA'" },
]);
check('a data: payload is not flat data',
  ids(project(fence('src/data/exports.ts', exportRows))), []);

// Narrower than it looks: a real path repeated on every record still is, because
// a reference can point at different things and a payload cannot.
const sameFileRows = records([
  { id: "'r1'", label: "'1月'", url: "'/img/a.png'" },
  { id: "'r2'", label: "'2月'", url: "'/img/a.png'" },
  { id: "'r3'", label: "'3月'", url: "'/img/a.png'" },
  { id: "'r4'", label: "'4月'", url: "'/img/a.png'" },
  { id: "'r5'", label: "'5月'", url: "'/img/a.png'" },
  { id: "'r6'", label: "'6月'", url: "'/img/a.png'" },
]);
check('one real path on every record still is',
  ids(project(fence('src/data/exports.ts', sameFileRows))), ['seed-data-flat']);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
