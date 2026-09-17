/**
 * Naming a project that was never named.
 *
 * A project is created as 「Untitled」 because at that moment there is nothing to
 * call it. After a generation there is, and one account had thirteen projects
 * whose names were mostly Untitled — the list became unreadable not because
 * naming is hard but because it happened at the only moment there was nothing
 * to say.
 *
 * The properties that matter here are the refusals, not the successes. A name
 * read out of a scaffold — `<title>Document</title>`, which is what every editor
 * puts in an empty HTML file — renames Untitled to Document, which is worse for
 * being less honest about being a placeholder. And a name read out of a JSX
 * binding is the name of a variable.
 *
 *   node test/project-title.test.mjs      (from frontend/)
 */
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const out = path.join(root, 'dist-test/project-title.test.mjs');
fs.mkdirSync(path.dirname(out), { recursive: true });
await esbuild.build({
  entryPoints: [path.join(root, 'src/utils/projectTitle.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile: out,
});
const { titleFromResult, isUnnamed } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- which projects are up for naming -----------------------------------------
check('the name it is created with', isUnnamed('Untitled'), true);
check('whatever the case', isUnnamed('untitled'), true);
check('and an empty one', isUnnamed('   '), true);
check('a name the user chose is left alone', isUnnamed('在庫管理'), false);
// The point of the guard: a project already named must never be renamed by a
// later generation, and 「Untitled の続き」 is a name somebody typed.
check('and so is one that merely starts with it', isUnnamed('Untitled 2'), false);

// --- the document names itself -------------------------------------------------
check('the title tag is taken',
  titleFromResult('<html><head><title>在庫管理ダッシュボード</title></head></html>'),
  '在庫管理ダッシュボード');
check('with attributes on the tag',
  titleFromResult('<title data-x="1">ハコブネ</title>'), 'ハコブネ');
check('and its entities decoded',
  titleFromResult('<title>Design &amp; Build</title>'), 'Design & Build');
check('whitespace collapsed',
  titleFromResult('<title>\n   予約  システム \n</title>'), '予約 システム');

// --- the scaffold's own placeholders are refused --------------------------------
/*
 * `<title>Document</title>` is what an empty HTML file gets from every editor,
 * and `Vite + React` from the scaffold. Accepting either renames Untitled to
 * something equally empty and harder to recognise as empty.
 */
for (const junk of ['Document', 'React App', 'Vite + React + TS', 'App', 'Home', 'ホーム', '無題']) {
  check(`「${junk}」 is not a name`, titleFromResult(`<title>${junk}</title>`), null);
}
check('and neither is an empty tag', titleFromResult('<title>   </title>'), null);

// --- the page, not the site -----------------------------------------------------
/*
 * `商品一覧 | ハコブネ` is one page of a product, and the product is the project.
 * Written the other way round about as often, so the longer half wins rather
 * than a fixed side.
 */
check('the site half of a split title wins when it is the longer',
  titleFromResult('<title>一覧 | ハコブネ書店</title>'), 'ハコブネ書店');
check('and the other way round too',
  titleFromResult('<title>不動産検索サービス - 物件一覧</title>'), '不動産検索サービス');

// --- the specification names the product, and nothing else does -------------------
/*
 * Measured against the 148 documents in S3: a `<title>` is in 46% of them and
 * this heading in 61%, together 97%. The first `<h1>` is in 95% and is nearly
 * always a SCREEN heading — the sample holds 「予約日時を選択してください」,
 * 「新作アイテム」 and 「シーズンセール開催中」, an instruction and two banners.
 *
 * That is the whole reason this source exists and the h1 does not: naming a
 * dental clinic's booking system 「予約日時を選択してください」 is worse than leaving
 * it Untitled, because it looks deliberate.
 */
const spec = (name, rest = '') =>
  `<html><body>
@@@makeui:file SPECIFICATION.md
# ${name}

本文
@@@makeui:endfile
${rest}</body></html>`;
check('the specification heading is the name', titleFromResult(spec('渋谷デンタルクリニック予約システム')), '渋谷デンタルクリニック予約システム');
check('and it beats a title tag',
  titleFromResult(spec('社内備品管理システム', '<title>Vite + React</title>')), '社内備品管理システム');
/*
 * It is NOT split on a dash. `mainPart` separates a page from its site, and this
 * heading is already the whole name — keeping the longer half of
 * 「LOOM — レディースアパレルストア」 throws the brand away.
 */
check('a brand and a description stay together',
  titleFromResult(spec('LOOM — アパレルEC')), 'LOOM — アパレルEC');
// And a screen heading is never used, however prominent.
check('a screen heading is not a project name',
  titleFromResult('<h1>予約日時を選択してください</h1>'), null);
check('nor is a banner', titleFromResult('<h1 class="x">シーズンセール開催中</h1>'), null);
check('a title tag still works when there is no specification',
  titleFromResult('<title>社内経費精算システム</title><h1>申請一覧</h1>'), '社内経費精算システム');
/*
 * And the placeholders this corpus turned up, which guessing would not have.
 * 'StoreName' is the model's own filler left in the heading; 「ダッシュボード」
 * names a category rather than a product, the same failure as 'App' in a longer
 * word. Running the function over all 148 stored documents names 142 of them,
 * and every name is a product rather than a screen.
 */
for (const junk of ['StoreName', 'Dashboard', 'ダッシュボード']) {
  check(`「${junk}」 is filler, not a name`, titleFromResult(spec(junk)), null);
}

// --- and finally what was asked for ----------------------------------------------
/*
 * A brief's first line is its subject — every template opens with one — and
 * nothing else in the brief says it as briefly.
 */
check('the request names it when the document does not',
  titleFromResult('<title>Document</title>', 'レディースアパレルのオンラインストア。\n\n画面:\n- 商品一覧'),
  'レディースアパレルのオンラインストア');
check('a two-word request still names it', titleFromResult('', 'カフェの予約'), 'カフェの予約');
check('nothing anywhere means no rename', titleFromResult('<div />', ''), null);
check('and a placeholder request is refused too', titleFromResult('', 'アプリ'), null);

// --- long names are cut to what a tab can show -------------------------------------
const long = titleFromResult(`<title>${'在庫'.repeat(30)}</title>`);
check('a long title is cut', long.length, 32);
check('and is still the beginning of it', long.startsWith('在庫在庫'), true);

// --- the composer wires it -----------------------------------------------------
const app = read('src/App.tsx');
check('the name is set when a generation finishes', /titleFromResult\(result, genPromptRef\.current\)/.test(app), true);
/*
 * Both the stored name and the box in the header. The box is what the user is
 * looking at: renaming under a name they have typed but not yet blurred would
 * take it away as they were writing it.
 */
check('only for a project nobody has named',
  /isUnnamed\(project\.name\) && isUnnamed\(projectTitle\)/.test(app), true);
check('the header follows it', /setProjectTitle\(named\)/.test(app), true);
check('and it is stored', /onUpdateProject\(project\.projectId, \{ name: named \}\)/.test(app), true);
// The request is captured where the generation is started, not read back off the
// thread — after a rebuild the thread cannot say which message was the build.
check('the request is kept from the send', /genPromptRef\.current = rawText/.test(app), true);
// Renaming on an EDIT would rename a project from the wording of a tweak.
const modifyEffect = app.slice(app.indexOf('if (modifiedHtml && !isModifying)'));
check('an edit never renames the project', /titleFromResult/.test(modifyEffect), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
