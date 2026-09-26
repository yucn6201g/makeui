// What the finished run says in the chat.
//
// The reply is rendered as the assistant's message and nothing is added to it,
// so it is the whole of the answer to 「何が出来たのか」. Measured across 45 stored
// results, 14 were not that — and both failures are extraction artifacts rather
// than anything a model chose to say:
//
//    8  nothing but the planner's file list, in English. 「新規
//       src/screens/ContactScreen.tsx — new contact form screen with
//       validation」 and four more like it. (Twelve OPEN with such a line;
//       four of those go on to say something, and keep it — which is why
//       `isFilePlan` asks about every line rather than the first.)
//    6  a transported file block, because the preamble is everything before the
//       document begins and a SPECIFICATION.md written ahead of it is inside
//       that. The longest reply ran to 6,541 characters, nearly all spec.
//
// Replaying these rules over all 45 takes them from 44,645 characters to 12,552,
// and the longest from 6,541 to 1,042.
//
// The inputs below are those stored replies, shortened but not reshaped.
//
// The assertion that matters most is the negative one: 「編集画面を追加しました」
// is prose that happens to start with 編集, and a check that fired on the verb
// would replace a good description with a generic sentence. So the plan shape is
// anchored on a path with an extension, not on the word.
//
//   node test/reply-text.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/orchestration/prompts/reply-text.ts')}" --bundle --platform=node ` +
    `--format=esm --outfile="${path.join(root, 'dist/rt.test.mjs')}" --external:@aws-sdk/*`,
  { stdio: 'pipe', cwd: root }
);
const { replyText, stripTransportedFiles, isFilePlan, describeEditResult, describeEditReply } =
  await import(pathToFileURL(path.join(root, 'dist/rt.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok && detail !== undefined) console.log(`      ${detail}`);
  ok ? pass++ : fail++;
};

// --- a good reply is left exactly as it is ---------------------------------
//
// The median stored reply, verbatim. Nothing here should be touched: this is the
// brief description of the built UI that the rest of the file exists to protect.
const GOOD = '社内備品の貸出管理に特化したダッシュボードです。スカイブルーのアクセント（#0ea5e9）で信頼感と専門性を表現し、ニュートラルな温かみのあるグレースケールで落ち着いた雰囲気を実現。備品カードは実物の写真と在庫数を並べ、貸出申請はモーダルフォームで実装しました。';
check('a description of the built UI passes through untouched',
  replyText(GOOD, 'UIを生成しました。') === GOOD);

// --- the spec that rode along in the preamble -------------------------------
const WITH_SPEC = `デザイン制作会社向けの案件管理ツール。4画面の統合システムです。

<script type="text/markdown" data-file="SPECIFICATION.md">
# 案件管理ツール — プロダクト仕様書

## 画面一覧
| 画面ID | 名前 |
|--------|------|
| projects | 案件一覧 |
</script>`;
const stripped = replyText(WITH_SPEC, 'UIを生成しました。');
check('the transported spec is removed', !stripped.includes('SPECIFICATION.md'), stripped.slice(0, 80));
check('the description in front of it is kept',
  stripped === 'デザイン制作会社向けの案件管理ツール。4画面の統合システムです。', stripped);

const WITH_FENCE = `在庫管理の画面をつくりました。

@@@makeui:file src/App.tsx
export function App() { return null }
@@@makeui:endfile
`;
check('a fenced file block is removed too',
  replyText(WITH_FENCE, 'x') === '在庫管理の画面をつくりました。', replyText(WITH_FENCE, 'x'));

// A preamble cut off mid-block leaves an opening sentinel and no close.
const TRUNCATED = `在庫管理の画面をつくりました。

<script type="text/markdown" data-file="SPECIFICATION.md">
# 仕様書
## 画面一覧`;
check('an unclosed file block is removed rather than left dangling',
  replyText(TRUNCATED, 'x') === '在庫管理の画面をつくりました。', replyText(TRUNCATED, 'x'));

// --- the file plan ----------------------------------------------------------
const FILE_PLAN = `新規 src/screens/ContactScreen.tsx — new contact form screen with validation and confirmation modal
編集 src/routes.ts — add 'contact' to ScreenId union and NAV_ITEMS
編集 src/App.tsx — import ContactScreen and add routing branch`;
check('a file plan is recognised', isFilePlan(FILE_PLAN));
check('a file plan does not become the reply',
  replyText(FILE_PLAN, '変更を適用しました。') === '変更を適用しました。');

const OUTCOME = `✓ 新規 src/components/SearchBox.tsx — 検索ボックスを追加
✓ 編集 src/styles/tokens.css — ボタンの色
× 新規 src/components/ExportButton.tsx — CSV（適用できませんでした）`;
check('an outcome list is recognised as a file plan too', isFilePlan(OUTCOME));

// --- and the negative that decides whether this is safe ---------------------
check('prose that begins with 編集 is not mistaken for a plan',
  !isFilePlan('編集画面を追加しました。一覧から遷移できます。'), '編集画面…');
check('prose that begins with 新規 is not mistaken for a plan',
  !isFilePlan('新規登録フォームをつくりました。'), '新規登録…');
check('a sentence followed by a file list is left alone, since the sentence is the answer',
  !isFilePlan(`検索と絞り込みを追加しました。\n編集 src/App.tsx — wire the filter`));

// The per-file BUILD writes this instead of a preamble — there is no single
// response for prose to sit in front of. It names a path and must still survive,
// which is why the plan shape needs a path in the leading position rather than
// anywhere in the line.
const PER_FILE_BUILD = `4画面と6個の共通部品に分けて実装しました。
画面: ListScreen.tsx、DetailScreen.tsx、FormScreen.tsx、HistoryScreen.tsx
共通の見た目は src/styles/globals.css に集約し、各画面はそのクラスだけを使っています。`;
check('the per-file build summary is not mistaken for a file plan', !isFilePlan(PER_FILE_BUILD));
check('the per-file build summary survives intact',
  replyText(PER_FILE_BUILD, 'UIを生成しました。') === PER_FILE_BUILD);

// --- what an edit says instead ----------------------------------------------
const parts = [
  { text: '一覧画面に検索ボックスを追加して' },
  { text: '主要ボタンの色を #B85C38 に変えて' },
  { text: 'CSVダウンロードのボタンも付けて' },
];
const multi = describeEditResult(parts, 'ignored', FILE_PLAN);
check('a multi-part edit is reported in the user’s own words',
  parts.every((p) => multi.includes(p.text)), multi);
check('it says what happened before listing anything', multi.startsWith('次の変更を適用しました。'), multi);
check('it carries no file paths', !/\.tsx|\.ts\b|\.css/.test(multi), multi);

const single = describeEditResult([{ text: 'only one' }], '著作権表示を2026年に更新して', FILE_PLAN);
check('a single-part edit uses the instruction rather than the part list',
  single.includes('著作権表示を2026年に更新して'), single);

// A partial edit keeps the list: it is the only record of which half is missing,
// and 「適用しました」 over an incomplete edit would be worse than paths.
const partial = describeEditResult(parts, 'x', OUTCOME);
check('a partial edit says so first', partial.startsWith('一部の変更を適用できませんでした。'), partial.split('\n')[0]);
check('a partial edit keeps the record of what did not land',
  partial.includes('× 新規 src/components/ExportButton.tsx'), partial);

// --- degenerate input --------------------------------------------------------
check('an empty reply falls back', replyText('', 'UIを生成しました。') === 'UIを生成しました。');
check('a whitespace reply falls back', replyText('   \n\n ', 'x') === 'x');
check('a missing reply falls back', replyText(undefined, 'x') === 'x');
check('a reply that is nothing but a file block falls back',
  replyText('@@@makeui:file a.ts\nx\n@@@makeui:endfile', 'x') === 'x');
check('stripping leaves no run of blank lines behind',
  !/\n{3}/.test(stripTransportedFiles('a\n\n<script data-file="x">y</script>\n\n\nb')));

// --- both paths clean the reply the same way -----------------------------------
/*
 * The generate path has run everything through `replyText` since it was written.
 * The edit path stopped at `stripTransportedFiles`, so an edit whose reply
 * happened to be prose rather than a file plan was shown exactly as the model
 * wrote it — the 「**Step 0 — 設計委譲前の確認**」 worksheet and the rule under it
 * included. Reported as 「整形前の応答がそのまま表示されている」.
 */
const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const meta = fs.readFileSync(path.join(here, 'src/orchestration/edit/meta-orchestrator.ts'), 'utf8');
check('the edit reply is built by describeEditReply', meta.includes('describeEditReply(plan, routePlan.parts, instruction, editChecks)'));
/*
 * And not by `replyText(plan, '')`, which was the bug: it returns its fallback
 * for a file plan, so the caller's file-plan branch only ever saw '' and every
 * per-file edit replied 「変更を適用しました。」 alone.
 */
check('not through replyText, whose fallback swallowed the file plan', !/replyText\(plan, ''\)/.test(meta));
check('and not through the half of it that was there before',
  !/const cleanedPlan = stripTransportedFiles/.test(meta));
/*
 * But NOT through `conciseDescription`. On the generate side it cuts a
 * 1,597-character design essay down to what was built; an edit reply is already
 * one or two sentences about one change, and taking its first three sentences
 * would start dropping half of a two-part answer.
 */
check('the edit reply is not also truncated to three sentences',
  !/conciseDescription\(/.test(meta));
// The worksheet is what this removes, and it is worth one direct check.
const WORKSHEET = '**Step 0 — 設計委譲前の確認**\n\nアクセントは #0b6 です。';
check('a Step 0 worksheet does not survive', !/Step 0/.test(replyText(WORKSHEET, 'x')));
check('and what it was scaffolding around does', replyText(WORKSHEET, 'x').includes('#0b6'));

// --- the whole edit reply ---------------------------------------------------------
{
  // The verification edit of 2026-09-13: two parts, a per-file plan, and a reply
  // that said 「変更を適用しました。」 and nothing else.
  const PARTS = [
    { text: '「貸出登録」画面の登録ボタンの文言を「貸出を確定する」に変更' },
    { text: 'フッターに「開館時間 9:00〜19:00」と表示' },
  ];
  const PLAN = '編集 src/screens/CheckoutScreen.tsx — 登録ボタンの文言とフッター';
  const req = (text, check, status, extra = {}) => ({ requirement: { text, check }, status, ...extra });
  const label = req('貸出を確定する', { kind: 'text', value: '貸出を確定する', where: '貸出登録' }, 'met');

  const clean = describeEditReply(PLAN, PARTS, 'x', [label, req('開館時間', { kind: 'text', value: '開館時間 9:00〜19:00', where: 'shared' }, 'met')]);
  check('a per-file edit lists its parts again', PARTS.every((p) => clean.includes(p.text)), clean);
  check('and is not the bare fallback', clean !== '変更を適用しました。', clean);
  check('a clean check says how many parts were confirmed', clean.endsWith('指示のうち自動で確認できる2件は、変更後のソースで確認しました。'), clean);

  const misplaced = describeEditReply(PLAN, PARTS, 'x', [label,
    req('フッターに開館時間を表示', { kind: 'text', value: '開館時間 9:00〜19:00', where: 'shared' }, 'unmet',
      { reason: 'misplaced', paths: ['src/App.tsx', 'src/screens/CheckoutScreen.tsx'] })]);
  check('a misplaced one says where it went wrong, without a path',
    misplaced.includes('・フッターに開館時間を表示（全画面に共通する場所ではなく、一部の画面にだけあります）') && !/\.tsx/.test(misplaced), misplaced);
  check('and does not also claim the checks passed', !misplaced.includes('確認しました'), misplaced);

  const onlyBehaviour = describeEditReply(PLAN, PARTS, 'x', [req('見やすく', { kind: 'behaviour' }, 'unverified')]);
  check('nothing checkable claims nothing', !onlyBehaviour.includes('確認'), onlyBehaviour);

  const prose = describeEditReply('検索ボックスを一覧の上に追加しました。', PARTS, 'x', []);
  check('a prose reply from a full rewrite is kept as written', prose === '検索ボックスを一覧の上に追加しました。', prose);
  check('an empty plan still lists the parts', PARTS.every((p) => describeEditReply('', PARTS, 'x', []).includes(p.text)));
  check('and the worksheet is still stripped', !/Step 0/.test(describeEditReply(WORKSHEET, PARTS, 'x', [])));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
