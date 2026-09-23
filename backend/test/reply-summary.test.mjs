/**
 * What the chat says a generation did.
 *
 * The reply is the model's preamble followed by what the run measured, and the
 * preamble is written BEFORE anything is built. Read against the stored replies,
 * that first half had three ways of saying nothing:
 *
 *   1,597 chars -> 21   「まず、私の仕様理解と設計方針を確認します。」 — the whole
 *                       first paragraph is an announcement, and the paragraph
 *                       that describes the product is three below it.
 *     637 chars -> 609  the Step 0 worksheet survives its heading being stripped
 *                       and is bullets of hex codes.
 *                       and when nothing qualified, `|| full` put all 1,597
 *                       characters back.
 *
 * And the measured half counted the screens without naming them. 「5画面すべてに
 * 到達しました」 says the run went well and nothing about what was built, so the
 * screens are named from the project's own NAV_ITEMS — 90 of the 91 corpus
 * documents that declare screens have them.
 *
 *   node test/reply-summary.test.mjs      (from backend/)
 */
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'dist/reply-summary-entry.ts');
fs.mkdirSync(path.dirname(entry), { recursive: true });
fs.writeFileSync(entry, [
  "export { replyWithOutcome, conciseDescription, describeOutcome, projectFileCounts } from '../src/orchestration/reply-text.js';",
  "export { screenLabels } from '../src/orchestration/interaction-audit.js';",
].join('\n'));
execSync(
  `npx esbuild "${entry}" --bundle --platform=node --format=esm --outfile="${path.join(root, 'dist/reply-summary.test.mjs')}" `
    + `--external:@aws-sdk/* --external:@smithy/* --external:@strands-agents/* --loader:.txt=text`,
  { stdio: 'pipe', cwd: root }
);
const { replyWithOutcome, conciseDescription, describeOutcome, screenLabels, projectFileCounts } = await import(
  pathToFileURL(path.join(root, 'dist/reply-summary.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- the description is the paragraph that describes something ----------------------
{
  const ANNOUNCED = [
    'まず、私の仕様理解と設計方針を確認します。',
    '',
    '## Step 0: ビジュアル設計の基礎確定',
    '',
    '- アクセント色: #0d6e3f',
    '- ニュートラル: #fafaf9 から #1c1917',
    '- タイプ: システムフォント',
    '- 密度: 運用コンソール密度',
    '',
    '---',
    '',
    'それでは、本体を構築します。',
    '',
    '稼働状況ダッシュボード、ジョブ一覧、ジョブ詳細の3画面。ハッシュルーター、共有state、再実行モーダルを実装。14件のジョブをプリロード。',
  ].join('\n');

  const got = conciseDescription(ANNOUNCED);
  check('the announcement is not the answer', /確認します/.test(got), false);
  check('nor is the worksheet', /#0d6e3f/.test(got), false);
  check('nor the rule the document used to sit under', got.trim(), got.trim().replace(/^-+$/, ''));
  check('the paragraph that describes the product is', /稼働状況ダッシュボード/.test(got), true);

  /*
   * 「それでは、本体を構築します。」 is fourteen characters and says nothing;
   * 「さくら歯科クリニックの予約システムを構築します。」 is twenty-four and is the
   * description. Both are 「〜を構築します。」, so the cut is on length and the two
   * real cases sit either side of it.
   */
  check('a bare transition is skipped', /本体を構築します/.test(got), false);
  check('but a short real description is kept',
    conciseDescription('さくら歯科クリニックの予約システムを構築します。'),
    'さくら歯科クリニックの予約システムを構築します。');
}

// --- and when nothing qualifies, the fallback rather than the worksheet ---------------
{
  const ONLY_WORKSHEET = ['## Step 0', '', '- 色: #fff', '- 余白: 8px', '- 角丸: 4px'].join('\n');
  const out = replyWithOutcome(ONLY_WORKSHEET, 'UIを生成しました。', { verified: false });
  check('the worksheet is not shown', /#fff/.test(out), false);
  check('the fallback is', /UIを生成しました。/.test(out), true);
}

// --- the outcome names the screens ---------------------------------------------------
{
  const named = describeOutcome({
    verified: true, reached: 5, declared: 5, consoleErrors: 0,
    files: 32, screens: 5, components: 18,
    screenNames: ['ホーム', 'ジョブ一覧', 'ジョブ詳細', 'アラート', '設定'],
  });
  check('every screen is named when every screen has a name',
    /ホーム・ジョブ一覧・ジョブ詳細・アラート・設定 の5画面を作成しました。/.test(named), true);
  /*
   * The file line stops repeating the screen count once the screens are named.
   * Saying 「5画面」 twice in three lines is how a summary stops being read.
   */
  check('and the file line no longer repeats the count', /画面5/.test(named), false);
  check('the component count stays', /コンポーネント18/.test(named), true);

  // Partly labelled: a screen reached from a list rather than the nav has no label.
  const partial = describeOutcome({
    verified: true, reached: 3, declared: 3, consoleErrors: 0,
    files: 20, screens: 3, components: 9,
    screenNames: ['レビュー一覧'],
  });
  check('the unlabelled ones are counted, not invented',
    /レビュー一覧 ほか2画面を作成しました。/.test(partial), true);

  // None labelled: back to the count, with nothing made up.
  const none = describeOutcome({
    verified: true, reached: 2, declared: 2, consoleErrors: 0,
    files: 11, screens: 2, components: 4, screenNames: [],
  });
  check('no names means no naming line', /作成しました/.test(none), false);
  check('and the count comes back to the file line', /画面2/.test(none), true);
}

// --- the labels come from NAV_ITEMS and only from there --------------------------------
{
  const doc = (routes) => `<!DOCTYPE html><html><body><div id="root"></div>
@@@makeui:file src/routes.ts
${routes}
@@@makeui:endfile
@@@makeui:file src/App.tsx
export default function App(){ return null }
@@@makeui:endfile
</body></html>`;

  check('a NAV_ITEMS list is read', screenLabels(doc([
    "export type ScreenId = 'list' | 'detail';",
    "export const NAV_ITEMS: NavItem[] = [",
    "  { id: 'list', label: 'レビュー一覧' },",
    "  { id: 'detail', label: '詳細' },",
    '];',
  ].join('\n'))), ['レビュー一覧', '詳細']);

  /*
   * routes.ts is also where the filter and sort menus are declared, and they are
   * objects with labels. Matching every `{ … label: … }` in the file returned ten
   * names for a three-screen project.
   */
  check('a menu declared beside it is not', screenLabels(doc([
    "export const NAV_ITEMS: NavItem[] = [",
    "  { id: 'home', label: 'ホーム' },",
    '];',
    'export const SORTS = [',
    "  { value: 'new', label: '新着順' },",
    "  { value: 'price', label: '価格：低い順' },",
    '];',
  ].join('\n'))), ['ホーム']);

  check('a project with no NAV_ITEMS answers with nothing',
    screenLabels(doc("export type ScreenId = 'a' | 'b';")), []);
}

// --- a stylesheet beside a screen is not another screen ------------------------------
{
  // The file list of a real run (2026-09-13): three screens, each with its own CSS.
  const files = ['SPECIFICATION.md', 'src/main.tsx', 'src/App.tsx', 'src/routes.ts',
    'src/screens/HoldingsScreen.tsx', 'src/screens/CheckoutScreen.tsx', 'src/screens/AlertsScreen.tsx',
    'src/components/BookDetailModal.tsx', 'src/components/ConfirmReturnModal.tsx',
    'src/styles/globals.css', 'src/screens/HoldingsScreen.css', 'src/screens/CheckoutScreen.css',
    'src/screens/AlertsScreen.css', 'src/components/BookDetailModal.css', 'src/components/ConfirmReturnModal.css',
    'src/screens/Board.vue', 'src/components/Card.tsx']
  const doc = '<!DOCTYPE html><html><body>' + files.map((p) => `\n@@@makeui:file ${p}\nx\n@@@makeui:endfile`).join('') + '\n</body></html>'
  const counts = projectFileCounts(doc)
  check('three screens with their stylesheets are three screens, plus a Vue one', counts.screens, 4)
  check('components count their source, not their CSS', counts.components, 3)
  check('the file total still counts every file but the spec', counts.files, 16)
  const reply = describeOutcome({ verified: true, reached: 3, declared: 3, consoleErrors: 0,
    files: counts.files, screens: 3, components: counts.components,
    screenNames: ['蔵書一覧', '貸出登録', '返却期限アラート'] })
  check('so the reply names them without inventing more', /ほか/.test(reply), false)
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
