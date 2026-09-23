// What arrives from the model is one paragraph. Measured on stored threads: five
// or six sentences of Japanese in a single run, no line breaks, set at 13px in a
// 420px column —
//
//   BtoB SaaS向けの社内分析ダッシュボードです。デジタル庁デザインシステムに準拠
//   し、フラットで権威あるUIを構築します。グラフはすべてインラインSVGで描画し、
//   外部ライブラリは一切使いません。…
//
// Every sentence is worth reading and none of them is findable, because there is
// nothing for the eye to return to.
//
//   node test/format-reply.test.mjs      (from frontend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/utils/formatReply.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist-test/fr.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const { formatReply, splitSentences, inlineSpans } = await import(pathToFileURL(path.join(root, 'dist-test/fr.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- sentences ----------------------------------------------------------------
check('a paragraph becomes one line per sentence',
  splitSentences('ダッシュボードです。SVGで描画します。外部ライブラリは使いません。'),
  ['ダッシュボードです。', 'SVGで描画します。', '外部ライブラリは使いません。']);
// 。 closes a sentence and stays on the line it ends: this rearranges the text,
// it does not edit it.
check('the full stop is kept', splitSentences('作ります。').join(''), '作ります。');
// A trailing run with no 。 is a line of its own — a heading, or a stream that
// stopped mid-thought.
check('an unterminated tail is still a line',
  splitSentences('まず設計します。次に'), ['まず設計します。', '次に']);
// A line holding 「はい。」 reads as a heading for what follows it.
check('a fragment joins the sentence after it',
  splitSentences('はい。ダッシュボードを作ります。'), ['はい。ダッシュボードを作ります。']);
check('and several fragments join once',
  splitSentences('はい。了解。ダッシュボードを作ります。'), ['はい。了解。ダッシュボードを作ります。']);

// --- blocks -------------------------------------------------------------------
const wall =
  'BtoB SaaS向けの社内分析ダッシュボードです。デジタル庁デザインシステムに準拠し、フラットで権威あるUIを構築します。' +
  'グラフはすべてインラインSVGで描画し、外部ライブラリは一切使いません。';
check('the measured reply breaks into three lines',
  formatReply(wall), [{ kind: 'para', lines: [
    'BtoB SaaS向けの社内分析ダッシュボードです。',
    'デジタル庁デザインシステムに準拠し、フラットで権威あるUIを構築します。',
    'グラフはすべてインラインSVGで描画し、外部ライブラリは一切使いません。',
  ] }]);

// An edit reply is one 「編集 <path> — <理由>」 line per file. Already readable,
// and flowing it into sentences would run the paths together.
check('edit records stay as a list',
  formatReply('編集 src/styles/globals.css — ロゴのスタイルを変更\n編集 src/App.tsx — ヘッダーを差し替え'),
  [{ kind: 'list', items: [
    '編集 src/styles/globals.css — ロゴのスタイルを変更',
    '編集 src/App.tsx — ヘッダーを差し替え',
  ] }]);
check('bullets are a list with the marker taken off',
  formatReply('- 一覧画面\n- 詳細画面'),
  [{ kind: 'list', items: ['一覧画面', '詳細画面'] }]);
check('and so are numbers',
  formatReply('1. 一覧画面\n2. 詳細画面'),
  [{ kind: 'list', items: ['一覧画面', '詳細画面'] }]);

// Lines the model already broke are left where it put them.
check('an existing break is not re-broken',
  formatReply('見出し\n本文です。続きです。'),
  [{ kind: 'para', lines: ['見出し', '本文です。続きです。'] }]);
check('a blank line separates blocks',
  formatReply('概要です。\n\n- 一覧\n- 詳細'),
  [{ kind: 'para', lines: ['概要です。'] }, { kind: 'list', items: ['一覧', '詳細'] }]);

check('empty content produces nothing', formatReply(''), []);
check('and so does whitespace', formatReply('\n  \n'), []);

// --- inline markdown, which was arriving as punctuation ---------------------------
//
// Measured on the newest stored reply (2026-09-04, 637 characters): eighteen
// `**` and ten backticks, every one of them shown on screen as an asterisk or a
// backtick. 「**Domain**: カフェの店内モバイルオーダー」 was read with the
// asterisks in it.
check('bold becomes a span',
  inlineSpans('**Domain**: カフェ'),
  [{ kind: 'bold', text: 'Domain' }, { kind: 'text', text: ': カフェ' }]);
check('and so does a code value',
  inlineSpans('アクセントは `#8B6F47` です'),
  [{ kind: 'text', text: 'アクセントは ' }, { kind: 'code', text: '#8B6F47' }, { kind: 'text', text: ' です' }]);

/*
 * Code first, then bold — markdown.ts's ordering and its reason. A `**` inside a
 * code span is part of what was quoted, and rendering it as bold makes the span
 * stop saying what it was quoted to say.
 */
check('markers inside a code span stay literal',
  inlineSpans('`**bold**` は太字にしない'),
  [{ kind: 'code', text: '**bold**' }, { kind: 'text', text: ' は太字にしない' }]);

// An unclosed marker is prose with asterisks in it. Swallowing it would delete
// something the model wrote.
check('an unmatched marker is left alone',
  inlineSpans('閉じない ** はそのまま'), [{ kind: 'text', text: '閉じない ** はそのまま' }]);
check('a plain line is one span',
  inlineSpans('普通の文です。'), [{ kind: 'text', text: '普通の文です。' }]);
check('and an empty line does not vanish',
  inlineSpans(''), [{ kind: 'text', text: '' }]);

// --- the findings fold away ---------------------------------------------------------
/*
 * After a first generation the reply ends with what the run could not fix — on the
 * verification run, eight bullets — and the description the person asked for sat
 * above a wall of review notes. They render collapsed under their count now.
 *
 * The block comes out of the text rather than out of structure, because the text
 * is what the thread persists. So the heading is the contract, and it is read
 * from the backend below rather than copied into this file.
 */
const OUTCOME = [
  '5画面すべてに到達しました。コンソールエラーはありません。',
  '31ファイル（画面5・コンポーネント15）を生成しました。',
  '未解決の指摘が3件あります。',
  '・画面内の次のボタンは、実際にクリックしても何も起きません: 提出。',
  '・コントラスト比が WCAG AA を下回るテキストがあります。',
  '・アイコンがどの画面からも描画されていません。',
].join('\n');

const reply = formatReply(`予約システムを作りました。\n\n${OUTCOME}`);
const found = reply.find((b) => b.kind === 'findings');
check('the findings become their own block', Boolean(found), true);
check('carrying the count from the heading', found?.count, 3);
check('and every item, markers stripped', found?.items, [
  '画面内の次のボタンは、実際にクリックしても何も起きません: 提出。',
  'コントラスト比が WCAG AA を下回るテキストがあります。',
  'アイコンがどの画面からも描画されていません。',
]);
// What came before them in the same chunk is still prose, and still first.
check('the reach and file lines stay prose, above the fold',
  reply.filter((b) => b.kind === 'para').flatMap((b) => b.lines).some((l) => l.includes('31ファイル')), true);
check('and the fold comes after them',
  reply.findIndex((b) => b.kind === 'findings') > reply.findIndex((b) => b.kind === 'para' && b.lines.some((l) => l.includes('31ファイル'))), true);
// The heading itself is not repeated as a line of prose — it is the summary.
check('the heading is not left behind as prose',
  reply.some((b) => b.kind === 'para' && b.lines.some((l) => l.startsWith('未解決の指摘が'))), false);

/*
 * Stored threads from before every finding was listed end the heading with
 * 「主なもの:」 and carry 「・ほか N件」 as their last bullet. They still fold, and
 * still show what they have — the data for the rest was never in them.
 */
const OLD = formatReply('未解決の指摘が8件あります。主なもの:\n・一つ目\n・二つ目\n・三つ目\n・ほか5件');
check('an old thread still folds', OLD[0]?.kind, 'findings');
check('with the count it stated', OLD[0]?.count, 8);
check('and the items it had', OLD[0]?.items.length, 4);

// A reply with no findings is untouched.
check('a clean run has no fold',
  formatReply('作りました。\n\n5画面すべてに到達しました。').some((b) => b.kind === 'findings'), false);
// And the phrase appearing mid-sentence is not a heading.
check('the phrase inside a sentence is not a heading',
  formatReply('前回は未解決の指摘が3件ありましたが、すべて直しました。').some((b) => b.kind === 'findings'), false);

// --- the two sides agree on the heading ------------------------------------------------
/*
 * The backend writes the line and this recognises it. Read off the backend source,
 * so a change to the wording fails here instead of the findings silently
 * unfolding back into the reply.
 */
const backend = fs.readFileSync(path.join(root, '../backend/src/orchestration/reply-text.ts'), 'utf8');
check('the backend writes the heading this recognises',
  backend.includes('lines.push(`未解決の指摘が${open.length}件あります。`);'), true);
check('and lists every finding rather than counting the rest', /ほか\$\{rest\}件/.test(backend), false);
check('the chat renders the fold', /block\.kind === 'findings'/.test(fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8')), true);
check('as a disclosure, closed by default',
  /<details className="app__findings"/.test(fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8')), true);

// --- the critic's opinions, apart from the findings ------------------------------
/*
 * Five kinds of design critique are measured as ones no repair moves, or that
 * the critic itself does not repeat on the same screenshot. They were listed as
 * 未解決の指摘 with a fix button each; they are now their own fold, with no
 * button, under a heading that says what they are.
 */
{
  const blocks = formatReply([
    '5画面すべてに到達しました。',
    '未解決の指摘が2件あります。',
    '・ボタンが動きません',
    '・画像がありません',
    'デザインについての参考意見が2件あります（自動修正の対象外）。',
    '・余白が不揃いです',
    '・アクセントが強すぎます',
  ].join('\n'));
  check('both folds are recognised in one chunk',
    blocks.map((b) => b.kind), ['para', 'findings', 'opinions']);
  check('the findings keep their own items', blocks[1].items, ['ボタンが動きません', '画像がありません']);
  check('and the opinions theirs', [blocks[2].count, blocks[2].items], [2, ['余白が不揃いです', 'アクセントが強すぎます']]);
  check('a reply with only opinions has no findings fold',
    formatReply('デザインについての参考意見が1件あります（自動修正の対象外）。\n・余白').map((b) => b.kind), ['opinions']);
}
check('the backend writes the opinions heading this recognises',
  backend.includes('lines.push(`デザインについての参考意見が${opinions.length}件あります（自動修正の対象外）。`);'), true);
check('and decides which they are by the repair exclusion, not by a list of its own',
  /const opinions = all\.filter\(\(d\) => isCriticFinding\(d\.id\) && !repairable\(d\.id\)\)/.test(backend), true);
const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8');
check('the opinions fold has no fix button',
  /block\.kind === 'opinions' \?[\s\S]*?<\/details>/.exec(app)?.[0].includes('handleFixFinding'), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
