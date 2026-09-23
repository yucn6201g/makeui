// Plan mode asked the user four questions it could have answered itself.
//
// 2026-09-23: 「画像が出てないんだけどどうすべき？」 in plan mode on a storefront
// returned, in full, 「以下をお教えください：1. 影響範囲 2. 画像の種類 3. 現在の
// 問題 4. 目指す状態」 — and no plan. The edit that followed was declined by its
// file planner as 「a question, not a change」, named no files, and fell back to
// rewriting the whole document.
//
// Neither could have answered. The change designer was handed the screen NAMES
// and the instruction — not one line of the project. Every one of its questions
// was answerable from the source, and diagnoseForChange answers them in 1,330
// characters on that very storefront:
//
//   - Product declares NO picture field, so none of its 12 records can carry a photograph.
//   - <img> elements: 0, of which bound to a record field: 0.
//   - ProductCard.tsx: .da-card-image holds an invented <svg> drawing
//   - ProductDetailScreen.tsx: a background photograph hard-coded as … (the same for every record)
//
//   node test/change-diagnosis.test.mjs      (from backend/)
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await esbuild.build({
  entryPoints: [path.join(root, 'src/orchestration/change-diagnosis.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile: path.join(root, 'dist/cd.test.mjs'),
  external: ['@aws-sdk/*', '@smithy/*', '@strands-agents/*'], loader: { '.txt': 'text' }, logLevel: 'error',
});
const { diagnoseForChange, PROBLEM_REPORT, ABOUT_IMAGES } = await import(pathToFileURL(path.join(root, 'dist/cd.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};
const doc = (files) =>
  `<!DOCTYPE html><html><body>\n${Object.entries(files).map(([p, b]) => `@@@makeui:file ${p}\n${b}\n@@@makeui:endfile`).join('\n')}\n</body></html>`;

// --- the storefront the user asked about, in miniature ---------------------------
const STORE = doc({
  'src/routes.ts': "export type ScreenId = 'products' | 'product';\nexport const NAV_ITEMS = [{ id: 'products', label: '商品一覧' }];",
  'src/store/types.ts': 'export interface Product {\n  id: number;\n  name: string;\n  price: number;\n  category: string;\n}',
  'src/data/products.ts': "import type { Product } from '../store/types';\nexport const PRODUCTS: Product[] = [\n  { id: 1, name: 'シャツ', price: 1, category: 'a' },\n  { id: 2, name: 'パンツ', price: 1, category: 'a' },\n  { id: 3, name: 'コート', price: 1, category: 'a' },\n];",
  'src/components/ui/ProductCard.tsx': 'export default function ProductCard({ product }) {\n  return (<div className="card">\n    <div className="da-card-image">\n      <svg viewBox="0 0 200 200"><rect width="200" height="200" /></svg>\n    </div>\n    <h3>{product.name}</h3>\n  </div>);\n}',
  'src/screens/ProductListScreen.tsx': "import ProductCard from '../components/ui/ProductCard';\nexport default function ProductListScreen() { return <div>{PRODUCTS.map((product) => <ProductCard product={product} />)}</div>; }",
  'src/screens/ProductDetailScreen.tsx': "export default function ProductDetailScreen() {\n  return <div style={{ backgroundImage: 'url(https://example.test/stock/coat/1.jpg)' }} />;\n}",
});
{
  const d = diagnoseForChange(STORE, '画像が出てないんだけどどうすべき？');
  check('a question reads as a problem to fix', d.problemReport, true);
  check('and as a request about images', d.aboutImages, true);
  // The four questions plan mode asked back, answered.
  check('which screens: they are named', /Screens: products, product/.test(d.text), true);
  check('what data: the records and their fields', /holds 3 Product records \{ id, name, price, category \}/.test(d.text), true);
  check('why no photographs: the type has no field for one', /Product declares NO picture field, so none of its 3 records can carry a photograph/.test(d.text), true);
  check('is the tag there: no <img> at all', /<img> elements: 0, of which bound to a record field: 0/.test(d.text), true);
  check('what is drawn instead: the card\'s invented svg', /ProductCard\.tsx: \.da-card-image holds an invented <svg> drawing/.test(d.text), true);
  check('and the detail screen\'s constant photograph', /ProductDetailScreen\.tsx: a background photograph hard-coded as .* \(the same for every record\)/.test(d.text), true);
  check('it says photographs can be supplied', /stock-photo library is available/.test(d.text), true);
  // The instruction that replaces the questions.
  check('it tells the designer not to ask', /Do not reply with questions for the user/.test(d.text), true);
  check('and to state an assumption instead', /state it as an assumption/.test(d.text), true);
  // A page of facts, not the codebase it stands in for.
  check('it stays small', d.text.length < 2500, true);
}

// A catalogue that declares a picture and fills some of it.
{
  const half = doc({
    'src/store/types.ts': 'export interface Item {\n  id: string;\n  name: string;\n  imageUrl?: string;\n}',
    'src/data/items.ts': "export const ITEMS: Item[] = [\n  { id: 'a', name: 'A', imageUrl: 'x.jpg' },\n  { id: 'b', name: 'B', imageUrl: '__PHOTO__' },\n  { id: 'c', name: 'C' },\n];",
    'src/screens/List.tsx': 'export default () => <div>{ITEMS.map((item) => <img src={item.imageUrl} />)}</div>;',
  });
  const d = diagnoseForChange(half, '商品の写真を表示して');
  check('a declared picture field is named', /Item declares `imageUrl`; 2 of 3 records set it \(1 are the unresolved slot __PHOTO__\)/.test(d.text), true);
  check('and a bound <img> is counted', /<img> elements: 1, of which bound to a record field: 1/.test(d.text), true);
  check('a plain request is not a problem report', d.problemReport, false);
}

// --- an element the user picked on screen ------------------------------------------
/*
 * Two of the six edits in thirty days that fell back to rewriting the whole
 * document were 「Target element: header. header の ヘッダー を再生成して」: the
 * planner, shown file PATHS, could not tell which of them writes a header.
 */
{
  const shell = doc({
    'src/App.tsx': 'export default function App() { return (<div><header className="app-header"><h1>店</h1></header><main /></div>); }',
    'src/screens/A.tsx': 'export default () => <section className="card"><h3>x</h3></section>;',
    'src/screens/B.tsx': 'export default () => <div><h3>y</h3></div>;',
  });
  const d = diagnoseForChange(shell, 'Target element: header. header の ヘッダー を再生成して');
  check('a picked element is recognised', d.targeted, true);
  check('and the file that writes it is named', /picked on screen \(header\) is written in: src\/App\.tsx/.test(d.text), true);
  // A class is the evidence, not the tag every screen has.
  const byClass = diagnoseForChange(shell, 'Target element: section.card > h3. 見出しを大きく');
  check('a class finds the one file, not every h3', /is written in: src\/screens\/A\.tsx$/m.test(byClass.text), true);
  // The picker's prefix is not the user's words.
  check('the prefix does not make it a problem report', d.problemReport, false);
  check('an unlocatable selector says where to look instead',
    /could not be located by its selector/.test(diagnoseForChange(shell, 'Target element: nav.side. 消して').text), true);
}
{
  const meta = fs.readFileSync(path.join(root, 'src/orchestration/meta-orchestrator.ts'), 'utf8');
  check('the modify path hands the facts to a targeted edit too',
    /diagnosis\.problemReport \|\| diagnosis\.aboutImages \|\| diagnosis\.targeted \? diagnosis\.text : ''/.test(meta), true);
}

// --- what it does not do ------------------------------------------------------------
{
  const d = diagnoseForChange(STORE, 'ボタンの色を青に');
  check('a request about something else gets no image section', /IMAGES —/.test(d.text), false);
  check('and is not a problem report', d.problemReport, false);
}
check('a document that is not a project yields nothing', diagnoseForChange('<html><body>hi</body></html>', '画像が出ない？').text, '');

// --- the two patterns, read by example ------------------------------------------------
for (const [text, want] of [
  ['画像が出てないんだけどどうすべき？', true], ['ボタンが動かない', true], ['なぜ表示されないの', true],
  ['エラーが出る', true], ['色が反映されない', true], ['検索ボックスを追加して', false], ['ヘッダーを青に', false],
]) check(`「${text}」 ${want ? 'is' : 'is not'} a problem report`, PROBLEM_REPORT.test(text), want);
for (const [text, want] of [
  ['画像が出ない', true], ['写真を入れて', true], ['サムネイルを大きく', true], ['product image', true],
  ['ボタンを青に', false], ['imagine a login', false],
]) check(`「${text}」 ${want ? 'is' : 'is not'} about images`, ABOUT_IMAGES.test(text), want);

// --- the three places it is used ------------------------------------------------------
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const design = read('src/orchestration/strands-design.ts');
check('the change designer takes the facts', /Edit request: "\$\{instruction\}"\$\{dataContext \?\? ''\}\$\{facts \?\? ''\}/.test(design), true);
check('and is told not to answer with questions', /Never answer with questions for the user/.test(design), true);
const planner = read('src/orchestration/edit-files.ts');
check('the file planner treats a problem report as a change',
  /A question or a problem report about this UI[\s\S]*IS a change request/.test(planner), true);
check('and no longer declines a question outright',
  /it asks a\s*\n\s*question, or asks for something the project has no place for — return an\s*\n\s*empty list/.test(planner), false);
const meta = read('src/orchestration/meta-orchestrator.ts');
check('the modify path diagnoses', /const diagnosis = diagnoseForChange\(html, instruction\)/.test(meta), true);
check('only for the requests that need it',
  /const facts = diagnosis\.problemReport \|\| diagnosis\.aboutImages \|\| diagnosis\.targeted \? diagnosis\.text : ''/.test(meta), true);
// Facts in dataContext would take every edit off the stylesheet-only path.
check('and keeps the facts out of dataContext', /const dataContext = `[^`]*facts/.test(meta), false);
check('the facts go ahead of the spec the planner reads', /const specWithFacts = `\$\{facts\}/.test(meta), true);
const graph = read('src/orchestration/graph.ts');
check('plan mode diagnoses a change before specifying it',
  /const diagnosis = diagnoseForChange\(html, prompt\)[\s\S]{0,600}facts: diagnosis\.text/.test(graph), true);
check('and writes it with the change writer', /invokeModel\(modelId, PLAN_CHANGE_WRITER_SYSTEM/.test(graph), true);
check('the change writer states the cause', /## 現状[\s\S]*原因/.test(graph), true);
check('neither writer ends in questions',
  (graph.match(/利用者に質問を返さない/g) || []).length, 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
