/**
 * The user's requirements, as a checklist the finished project is checked against.
 *
 * Nothing in the pipeline looked at the request after the build. A requirement
 * the user stated and the build dropped — arrow-key navigation, on the
 * verification run — was invisible to the score and to the repair loop, and on
 * the edit path an instruction whose change never appeared was reported as
 * applied because a file had been written.
 *
 * The fixtures below are REAL Haiku replies, captured on 2026-09-13 against the
 * production prompt, not hand-written JSON. Two of them are why the parser's
 * guards exist rather than trusting the prompt's rules:
 *
 *   - asked never to return a one-character value as text, it returned 「×」 as
 *     text anyway
 *   - asked for at most twelve requirements, it returned fifteen
 *
 * A guard that only a hand-written fixture exercises is a guard nobody knows is
 * needed.
 *
 *   node test/requirements.test.mjs      (from backend/)
 */
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/orchestration/requirements.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/rq.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'pipe', cwd: root }
);
const { parseRequirements, checkRequirements, requirementDefects, requirementsBlock, designRequirementsBlock, summarizeRequirements } =
  await import(pathToFileURL(path.join(root, 'dist/rq.test.mjs')).href);
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};
const kinds = (reqs) => reqs.map((r) => r.check.kind);

// --- fixtures: real Haiku replies, verbatim ------------------------------------------
const BOOKING = "```json\n{\n  \"requirements\": [\n    {\n      \"text\": \"埋まっている枠に「×」と表示される\",\n      \"check\": {\n        \"kind\": \"text\",\n        \"value\": \"×\"\n      }\n    },\n    {\n      \"text\": \"埋まっている枠に「満席」と表示される\",\n      \"check\": {\n        \"kind\": \"text\",\n        \"value\": \"満席\"\n      }\n    },\n    {\n      \"text\": \"キャンセル期限を過ぎた予約は、変更できない理由が画面に表示される\",\n      \"check\": {\n        \"kind\": \"behaviour\"\n      }\n    },\n    {\n      \"text\": \"カレンダーで矢印キーで日付を移動できる\",\n      \"check\": {\n        \"kind\": \"key\",\n        \"keys\": [\n          \"ArrowLeft\",\n          \"ArrowRight\",\n          \"ArrowUp\",\n          \"ArrowDown\"\n        ]\n      }\n    },\n    {\n      \"text\": \"カレンダーでEnterキーで枠を選べる\",\n      \"check\": {\n        \"kind\": \"key\",\n        \"keys\": [\n          \"Enter\"\n        ]\n      }\n    },\n    {\n      \"text\": \"選んだ日時は入力画面と完了画面でも常に見えている\",\n      \"check\": {\n        \"kind\": \"behaviour\"\n      }\n    },\n    {\n      \"text\": \"週表示のカレンダーで空き枠を表示する\",\n      \"check\": {\n        \"kind\": \"behaviour\"\n      }\n    },\n    {\n      \"text\": \"前週/翌週への移動ができる\",\n      \"check\": {\n        \"kind\": \"behaviour\"\n      }\n    },\n    {\n      \"text\": \"診療メニュー（検診・クリーニング・治療相談）で絞り込みできる\",\n      \"check\": {\n        \"kind\": \"behaviour\"\n      }\n    },\n    {\n      \"text\": \"キャンセルは確認モーダルを出す\",\n      \"check\": {\n        \"kind\": \"behaviour\"\n      }\n    },\n    {\n      \"text\": \"予約を取ったらその枠が埋まり、カレンダーに即座に反映される\",\n      \"check\": {\n        \"kind\": \"behaviour\"\n      }\n    },\n    {\n      \"text\": \"診療案内画面が存在する\",\n      \"check\": {\n        \"kind\": \"screen\",\n        \"name\": \"診療案内\"\n      }\n    },\n    {\n      \"text\": \"予約枠選択画面が存在する\",\n      \"check\": {\n        \"kind\": \"screen\",\n        \"name\": \"予約枠選択\"\n      }\n    },\n    {\n      \"text\": \"予約内容の入力画面が存在する\",\n      \"check\": {\n        \"kind\": \"screen\",\n        \"name\": \"予約内容の入力\"\n      }\n    },\n    {\n      \"text\": \"予約完了画面が存在する\",\n      \"check\": {\n        \"kind\": \"screen\",\n        \"name\": \"予約完了\"\n      }\n    },\n    {\n      \"text\": \"予約確認・変更画面が存在する\",\n      \"check\": {\n        \"kind\": \"screen\",\n        \"name\": \"予約確認・変更\"\n      }\n    }\n  ]\n}\n```";
const LP = "```json\n{\n  \"requirements\": [\n    {\n      \"text\": \"革新的\",\n      \"check\": {\"kind\": \"absent\", \"value\": \"革新的\"}\n    },\n    {\n      \"text\": \"シームレス\",\n      \"check\": {\"kind\": \"absent\", \"value\": \"シームレス\"}\n    },\n    {\n      \"text\": \"次世代\",\n      \"check\": {\"kind\": \"absent\", \"value\": \"次世代\"}\n    },\n    {\n      \"text\": \"料金ページで選んだプランが申込フォームに自動的に引き継がれる\",\n      \"check\": {\"kind\": \"behaviour\"}\n    },\n    {\n      \"text\": \"年払い/月払い切替で全プランの金額が変わる\",\n      \"check\": {\"kind\": \"behaviour\"}\n    },\n    {\n      \"text\": \"料金は税込か税抜かを明記する\",\n      \"check\": {\"kind\": \"behaviour\"}\n    },\n    {\n      \"text\": \"画面が狭いとき、料金の比較表はプランごとのカードに積み替える\",\n      \"check\": {\"kind\": \"behaviour\"}\n    },\n    {\n      \"text\": \"申込フォームの入力途中に項目ごとの検証エラーを表示する\",\n      \"check\": {\"kind\": \"behaviour\"}\n    },\n    {\n      \"text\": \"導入事例の絞り込みで該当0件のときそう表示する\",\n      \"check\": {\"kind\": \"behaviour\"}\n    },\n    {\n      \"text\": \"FAQの検索に該当がないときそう表示する\",\n      \"check\": {\"kind\": \"behaviour\"}\n    },\n    {\n      \"text\": \"トップ\",\n      \"check\": {\"kind\": \"screen\", \"name\": \"トップ\"}\n    },\n    {\n      \"text\": \"料金\",\n      \"check\": {\"kind\": \"screen\", \"name\": \"料金\"}\n    },\n    {\n      \"text\": \"導入事例\",\n      \"check\": {\"kind\": \"screen\", \"name\": \"導入事例\"}\n    },\n    {\n      \"text\": \"申込フォーム\",\n      \"check\": {\"kind\": \"screen\", \"name\": \"申込フォーム\"}\n    },\n    {\n      \"text\": \"申込完了\",\n      \"check\": {\"kind\": \"screen\", \"name\": \"申込完了\"}\n    }\n  ]\n}\n```";
const RELABEL = "```json\n{\n  \"requirements\": [\n    {\n      \"text\": \"予約を確定する\",\n      \"check\": {\n        \"kind\": \"text\",\n        \"value\": \"予約を確定する\"\n      }\n    },\n    {\n      \"text\": \"Escキーでモーダルを閉じられる\",\n      \"check\": {\n        \"kind\": \"key\",\n        \"keys\": [\"Escape\"]\n      }\n    }\n  ]\n}\n```";
const STRAY = "```json\n{\n  \"requirements\": [\n    {\n      \"text\": \"一部の画面の上部に表示されている「I need to create ~」などの無関係な文言を削除する\",\n      \"check\": {\n        \"kind\": \"absent\",\n        \"value\": \"I need to create\"\n      }\n    }\n  ]\n}\n```";

// --- parsing real replies ----------------------------------------------------------
const booking = parseRequirements(BOOKING);
// The model returned 「×」 as text. One character matches everything, so the
// parser keeps the requirement and drops the search.
check('a one-character value the model marked as text becomes unverifiable',
  booking.find((r) => r.text.includes('「×」'))?.check, { kind: 'behaviour' });
check('while 「満席」 stays a text check',
  booking.find((r) => r.check.kind === 'text')?.check, { kind: 'text', value: '満席' });
check('arrow-key navigation is a key check',
  booking.find((r) => r.text.includes('矢印'))?.check, { kind: 'key', keys: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'] });
check('the rest are behaviour, not guessed into a search',
  booking.filter((r) => r.check.kind === 'behaviour').length >= 6, true);

const lp = parseRequirements(LP);
/*
 * The case a regular expression reads backwards. The template says 「"革新的"
 * 「シームレス」「次世代」のような語は使わない」 — quoted words that must NOT
 * appear. A pattern keyed on quotation marks would have required all three.
 */
check('negated quotes come back as absent', lp.filter((r) => r.check.kind === 'absent').map((r) => r.check.value),
  ['革新的', 'シームレス', '次世代']);
check('and none of them as text', lp.some((r) => r.check.kind === 'text'), false);
// It returned fifteen. The list is a checklist, not a restatement of the brief.
check('the model returned more than twelve', (LP.match(/"kind"/g) ?? []).length > 12, true);
check('and the parser keeps twelve', lp.length, 12);

check('an edit instruction yields its label and its key',
  parseRequirements(RELABEL).map((r) => r.check),
  [{ kind: 'text', value: '予約を確定する' }, { kind: 'key', keys: ['Escape'] }]);
check('and text to remove comes back as absent',
  parseRequirements(STRAY).map((r) => r.check.kind), ['absent']);

// --- where, and shortcut letters: real replies to the prompt that asks for them ---------
/*
 * Captured 2026-09-13 against the prompt with `where` and letter keys added. The
 * edit is the verification run's own instruction, whose footer landed inside
 * one screen and was reported as done.
 */
const LIBRARY = "```json\n{\n  \"requirements\": [\n    {\n      \"text\": \"みどり市立図書館\",\n      \"check\": {\n        \"kind\": \"text\",\n        \"value\": \"みどり市立図書館\",\n        \"where\": \"shared\"\n      }\n    },\n    {\n      \"text\": \"Ctrl+K で検索欄にフォーカス\",\n      \"check\": {\n        \"kind\": \"key\",\n        \"keys\": [\"k\"]\n      }\n    },\n    {\n      \"text\": \"モーダルは Escape キーで閉じられる\",\n      \"check\": {\n        \"kind\": \"key\",\n        \"keys\": [\"Escape\"]\n      }\n    },\n    {\n      \"text\": \"蔵書一覧は書名・著者・請求記号・貸出状況の列を持つ表\",\n      \"check\": {\n        \"kind\": \"behaviour\"\n      }\n    },\n    {\n      \"text\": \"蔵書一覧画面\",\n      \"check\": {\n        \"kind\": \"screen\",\n        \"name\": \"蔵書一覧\"\n      }\n    },\n    {\n      \"text\": \"貸出登録画面\",\n      \"check\": {\n        \"kind\": \"screen\",\n        \"name\": \"貸出登録\"\n      }\n    },\n    {\n      \"text\": \"返却期限アラート画面\",\n      \"check\": {\n        \"kind\": \"screen\",\n        \"name\": \"返却期限アラート\"\n      }\n    }\n  ]\n}\n```";
const HOURS_EDIT = "```json\n{\n  \"requirements\": [\n    {\n      \"text\": \"貸出を確定する\",\n      \"check\": {\n        \"kind\": \"text\",\n        \"value\": \"貸出を確定する\",\n        \"where\": \"貸出登録\"\n      }\n    },\n    {\n      \"text\": \"フッターに開館時間を表示\",\n      \"check\": {\n        \"kind\": \"text\",\n        \"value\": \"開館時間 9:00〜19:00\",\n        \"where\": \"shared\"\n      }\n    }\n  ]\n}\n```";
const library = parseRequirements(LIBRARY);
const hours = parseRequirements(HOURS_EDIT);
check('a header string is placed on every screen', library[0].check, { kind: 'text', value: 'みどり市立図書館', where: 'shared' });
check('Ctrl+K comes back as its letter, and is kept', library.find((r) => r.text.includes('Ctrl+K'))?.check, { kind: 'key', keys: ['k'] });
check('a label on a named screen carries the screen', hours[0].check, { kind: 'text', value: '貸出を確定する', where: '貸出登録' });
check('a footer carries shared', hours[1].check, { kind: 'text', value: '開館時間 9:00〜19:00', where: 'shared' });
check('a place is dropped from anything but text',
  parseRequirements('{"requirements":[{"text":"x","check":{"kind":"absent","value":"革新的","where":"shared"}}]}')[0].check,
  { kind: 'absent', value: '革新的' });
check('an upper-case letter is folded, a word is not a key',
  parseRequirements('{"requirements":[{"text":"x","check":{"kind":"key","keys":["K","slash"]}}]}')[0].check,
  { kind: 'key', keys: ['k'] });

// --- parsing what a model should not return -----------------------------------------
check('no JSON is no checklist', parseRequirements('すみません、抽出できませんでした'), []);
check('an unknown kind is dropped', parseRequirements('{"requirements":[{"text":"x","check":{"kind":"vibes"}}]}'), []);
// "left arrow" would never match and would read as an unmet requirement the build
// had satisfied.
check('a key name that is not a KeyboardEvent.key becomes unverifiable',
  parseRequirements('{"requirements":[{"text":"左","check":{"kind":"key","keys":["left arrow"]}}]}')[0].check, { kind: 'behaviour' });
check('quotation marks left on a value are not searched for',
  parseRequirements('{"requirements":[{"text":"x","check":{"kind":"text","value":"「満席」"}}]}')[0].check.value, '満席');
check('a duplicate is kept once',
  parseRequirements('{"requirements":[{"text":"a","check":{"kind":"text","value":"満席"}},{"text":"b","check":{"kind":"text","value":"満席"}}]}').length, 1);

// --- checking against a project -------------------------------------------------------
const block = (p, body) => `@@@makeui:file ${p}\n${body}\n@@@makeui:endfile\n`;
const PROJECT = `<html><body><div id="root"></div>
${block('SPECIFICATION.md', '# 予約\n埋まっている枠は「満席」と表示する。矢印キーで移動。')}
${block('docs/design-guidelines.md', 'ArrowRight で次の日へ')}
${block('src/screens/Calendar.tsx', "export default function C(){ return <div onMouseEnter={()=>{}}>空き</div> }")}
${block('src/screens/Landing.tsx', "export default function L(){ return <h1>革新的な予約体験</h1> }")}
</body></html>`;

const reqs = [
  { text: '満席と表示', check: { kind: 'text', value: '満席' } },
  { text: '矢印キー', check: { kind: 'key', keys: ['ArrowRight'] } },
  { text: 'Enterで選ぶ', check: { kind: 'key', keys: ['Enter'] } },
  { text: '革新的は使わない', check: { kind: 'absent', value: '革新的' } },
  { text: '予約確認画面', check: { kind: 'screen', name: '予約確認' } },
  { text: '即座に反映', check: { kind: 'behaviour' } },
];
const results = checkRequirements(PROJECT, reqs);
const status = (i) => results[i].status;
/*
 * The specification and docs are not the UI. The build restates the brief in
 * SPECIFICATION.md, so a check that read it would find 「満席」 whether or not
 * a single screen shows it — checking that the requirement was repeated, not met.
 */
check('text only in SPECIFICATION.md is unmet', status(0), 'unmet');
check('a key only in docs/ is unmet', status(1), 'unmet');
// Quoted, so `onMouseEnter` is not handling Enter.
check('onMouseEnter is not an Enter handler', status(2), 'unmet');
check('forbidden text in a screen is unmet', status(3), 'unmet');
check('and names the file it is in', results[3].paths, ['src/screens/Landing.tsx']);
check('a missing screen is unmet', status(4), 'unmet');
check('behaviour is never claimed', status(5), 'unverified');

const FIXED = PROJECT
  .replace('空き</div>', "{full ? '満席' : '空き'}</div>")
  .replace('onMouseEnter={()=>{}}', "onKeyDown={(e)=>{ if (e.key === 'ArrowRight') next(); if (e.key === 'Enter') pick(); }}")
  .replace('革新的な予約体験', '予約をかんたんに');
const fixed = checkRequirements(FIXED, reqs);
check('once the screen shows it, it is met', fixed[0].status, 'met');
check('a quoted key comparison is met', fixed[1].status, 'met');
check('Enter too', fixed[2].status, 'met');
check('and the forbidden text gone is met', fixed[3].status, 'met');
check('no requirements, no results', checkRequirements(PROJECT, []), []);

// --- a text requirement that says where --------------------------------------------------
{
  const ROUTES = "export const NAV_ITEMS: NavItem[] = [\n  { id: 'holdings', label: '蔵書一覧' },\n  { id: 'checkout', label: '貸出登録' },\n];";
  const project = (app, holdings, checkout, extra = '') => `<html><body>
${block('src/routes.ts', ROUTES)}
${block('src/App.tsx', app)}
${block('src/screens/HoldingsScreen.tsx', holdings)}
${block('src/screens/CheckoutScreen.tsx', checkout)}${extra}
</body></html>`;
  const FOOTER = [{ text: 'フッターに開館時間', check: { kind: 'text', value: '開館時間 9:00〜19:00', where: 'shared' } }];
  const LABEL = [{ text: '貸出を確定する', check: { kind: 'text', value: '貸出を確定する', where: '貸出登録' } }];

  // The measured edit: the footer written into the one screen the instruction also named.
  const confined = checkRequirements(project('<main/>', '<h1>蔵書</h1>', '<footer><p>開館時間 9:00〜19:00</p></footer>'), FOOTER)[0];
  check('shared text confined to one screen is misplaced', [confined.status, confined.reason], ['unmet', 'misplaced']);
  check('and names the shell to move it to, then where it is', confined.paths, ['src/App.tsx', 'src/screens/CheckoutScreen.tsx']);
  check('in the shell it is met',
    checkRequirements(project('<footer>開館時間 9:00〜19:00</footer>', '', ''), FOOTER)[0].status, 'met');
  check('in a component, which a screen may render, it is met: imports are not followed',
    checkRequirements(project('', '', '', block('src/components/SiteFooter.tsx', '<p>開館時間 9:00〜19:00</p>')), FOOTER)[0].status, 'met');
  check('on every screen it is met',
    checkRequirements(project('', '開館時間 9:00〜19:00', '開館時間 9:00〜19:00'), FOOTER)[0].status, 'met');
  const nowhere = checkRequirements(project('<main/>', '', ''), FOOTER)[0];
  check('nowhere is missing, and goes to the shell', [nowhere.reason, nowhere.paths], ['missing', ['src/App.tsx']]);

  check('a label on its named screen is met',
    checkRequirements(project('', '', '<button>貸出を確定する</button>'), LABEL)[0].status, 'met');
  const wrongScreen = checkRequirements(project('', '<button>貸出を確定する</button>', '<button>登録</button>'), LABEL)[0];
  check('on another screen it is misplaced, and names the screen it belongs on',
    [wrongScreen.reason, wrongScreen.paths], ['misplaced', ['src/screens/CheckoutScreen.tsx']]);
  check('a screen name the nav does not know is checked as presence, never guessed',
    checkRequirements(project('', '<button>貸出を確定する</button>', ''),
      [{ text: 'x', check: { kind: 'text', value: '貸出を確定する', where: '返却' } }])[0].status, 'met');

  const misplacedDefects = requirementDefects([confined, wrongScreen]);
  check('both become repair defects that skip the planner', misplacedDefects.map((d) => d.paths),
    [['src/App.tsx', 'src/screens/CheckoutScreen.tsx'], ['src/screens/CheckoutScreen.tsx']]);
  check('the shared one says to put it in the shell once and remove the copies',
    misplacedDefects[0].instruction.includes('src/App.tsx の共通レイアウトに一度だけ置き、各画面に個別に書いた同じ表示は取り除いて'), true);
  check('the build is told where',
    requirementsBlock(FOOTER).includes('in the layout every screen shares') && requirementsBlock(LABEL).includes('on the 「貸出登録」 screen'), true);

  // The shortcut letter: 'k', 'K' or its code spelling.
  const K = [{ text: 'Ctrl+K', check: { kind: 'key', keys: ['k'] } }];
  check("e.key === 'k' is handled", checkRequirements(project("if (e.ctrlKey && e.key === 'k') focus()", '', ''), K)[0].status, 'met');
  check("e.code === 'KeyK' is handled", checkRequirements(project("if (e.code === 'KeyK') focus()", '', ''), K)[0].status, 'met');
  check('a bare k in a word is not', checkRequirements(project('const bookmark = 1', '', ''), K)[0].status, 'unmet');
}

// --- a screen not found by name, in a project with room for it ------------------------------
{
  // The inventory generation of 2026-09-13: three asked for, three built under English ids.
  const ROUTES = "export type ScreenId = 'inventory-list' | 'product-detail' | 'transaction-register';";
  const built = `<html><body>
${block('src/routes.ts', ROUTES)}
${block('src/screens/InventoryListScreen.tsx', '<h1>在庫一覧</h1>')}
${block('src/screens/ProductDetailScreen.tsx', '<h1>商品情報</h1>')}
${block('src/screens/TransactionRegisterScreen.tsx', '<h1>入出庫の記録</h1>')}
</body></html>`;
  const asked = ['在庫一覧', '商品詳細', '入出庫登録'].map((name) => ({ text: `${name}画面`, check: { kind: 'screen', name } }));
  check('a screen found by name is met, and names built under other ids are unverified, not missing',
    checkRequirements(built, asked).map((r) => r.status), ['met', 'unverified', 'unverified']);
  check('so the reply no longer claims they are missing', summarizeRequirements(checkRequirements(built, asked)).unmetScreens, []);

  // Fewer screens declared than asked for: some really are missing.
  const short = built.replace(" | 'transaction-register'", '').replace(/@@@makeui:file src\/screens\/TransactionRegisterScreen[\s\S]*?@@@makeui:endfile\n/, '');
  check('with fewer screens than names, the unfound stay unmet',
    checkRequirements(short, asked).map((r) => r.status), ['met', 'unmet', 'unmet']);
}

// --- what reaches the repair loop -------------------------------------------------------
const defects = requirementDefects(results);
check('text, key and absent become repair defects', defects.length, 4);
check('all under one id, so the fix rate is measurable', [...new Set(defects.map((d) => d.id))], ['requirement-unmet']);
/*
 * Not screens. A screen checked by name can be built under another — 「予約内容の
 * 入力」 as 「予約入力」 — and a false "missing" handed to a repair is an
 * instruction to build a duplicate screen. Screens land 79 in 80 already.
 */
check('a missing screen is never sent to repair', defects.some((d) => d.note.includes('予約確認画面')), false);
check('nor is behaviour', defects.some((d) => d.note.includes('即座に反映')), false);
// Located, so the planner is skipped for it.
check('forbidden text carries the file it is in', defects.find((d) => d.note.includes('革新的'))?.paths, ['src/screens/Landing.tsx']);
check('the instruction asks for the string verbatim', /言い換えず/.test(defects[0].instruction), true);

// --- what the build is told --------------------------------------------------------------
const told = requirementsBlock(reqs);
check('the build is told the checkable requirements', /「満席」/.test(told) && /ArrowRight/.test(told) && /「革新的」/.test(told), true);
check('and told they are checked', /checked mechanically/.test(told), true);
// Behaviour is already in the request the build receives verbatim.
check('behaviour is not restated', /即座に反映/.test(told), false);
// A screen is, by the user's name for it: the checker finds a screen by that name.
check('a named screen is told by its exact name', /Provide the screen 「予約確認」, with that exact name as its heading and as its NAV_ITEMS label/.test(told), true);

// --- what the design phase is told -------------------------------------------------------
const designTold = designRequirementsBlock(reqs);
check('the design phase hears every checkable requirement', /「満席」/.test(designTold) && /ArrowRight/.test(designTold) && /「革新的」/.test(designTold) && /「予約確認」 under that exact name/.test(designTold), true);
check('and names the control that handles a key rather than onKeyDown', /onKeyDown/.test(designTold), false);
check('behaviour is not restated to it either', /即座に反映/.test(designTold), false);
check('nothing checkable, nothing added to the brief', designRequirementsBlock([{ text: 'x', check: { kind: 'behaviour' } }]), '');
check('nothing checkable, nothing added', requirementsBlock([{ text: 'x', check: { kind: 'behaviour' } }]), '');

// --- counts for the reply ------------------------------------------------------------------
check('the summary counts every status', summarizeRequirements(results),
  { total: 6, met: 0, unmet: 5, unverified: 1, unmetScreens: ['予約確認'] });

// --- wiring ----------------------------------------------------------------------------------
const graph = read('src/orchestration/graph.ts');
const meta = read('src/orchestration/meta-orchestrator.ts');
const budget = read('src/orchestration/repair-budget.ts');
const reply = read('src/orchestration/reply-text.ts');
const extract = read('src/orchestration/requirements.ts');

check('extraction is always Haiku', /modelId: config\.haikuId/.test(extract), true);
check('and billed to the run', /recordTokens\([^)]*'requirements:extract'\)/.test(extract), true);
check('a failed extraction is counted, not billed as zero', /recordUnreportedCall\('requirements:extract'\)/.test(extract), true);
// Concurrent with the design phase, and bounded so the draft profile cannot wait on it.
check('generation starts extracting before the design phase',
  graph.indexOf('const requirementsPromise = extractRequirements(prompt)') < graph.indexOf("log('design-analyst')"), true);
check('and waits a bounded time for it', /requirements = await Promise\.race\(\[\s*requirementsPromise/.test(graph), true);
const design = read('src/orchestration/strands-design.ts');
check('the design phase waits for the checklist before it starts',
  /requirements = await Promise\.race\(\[\s*requirementsPromise[\s\S]{0,200}\]\)\s*designPlan = await runDesignSwarm\(\{[\s\S]{0,400}requirements: briefRequirements \? designRequirementsBlock\(requirements\) : ''/.test(graph), true);
check('and so does the plan, whose specification an approved build uses instead', /requirements: designRequirementsBlock\(planRequirements\)/.test(graph), true);
check('the specialists receive it in the brief', /Design this product: "\$\{prompt\}"\$\{dataContext \?\? ''\}\$\{requirements \?\? ''\}/.test(design), true);
check('and the critic checks the specification against it', /Design brief: "\$\{prompt\}"\$\{requirements \?\? ''\}/.test(design) && /9\. REQUIREMENTS/.test(design), true);
check('the build is told', /Original user request: "\$\{prompt\}"\$\{requirementsBlock\(briefRequirements \? requirements : requirements\.filter\(\(r\) => r\.check\.kind !== 'screen'\)\)\}/.test(graph), true);
// The comparison switch: on unless a direct Runtime invocation turns it off, and the API cannot pass it.
check('requirement briefing is on unless an experiment turns it off', /const briefRequirements = experiment\?\.requirementBriefing !== false/.test(graph), true);
check('the API strips the experiment field before dispatch', /experiment: _experiment, \.\.\.inputWithoutImage/.test(read('src/handlers/lambda-handler.ts')), true);
check('the job runner forwards it only as that one switch', /requirementBriefing: input\.experiment\.requirementBriefing !== false/.test(read('src/handlers/job-runner.ts')), true);
/*
 * In the collector and nowhere else, so the judge measures it on both sides of a
 * repair pass. Anywhere else, it would vanish from `after` and read as fixed.
 */
check('checked inside collectDefects', /\.\.\.requirementDefects\(checkRequirements\(doc, requirements\)\)/.test(graph), true);
check('exactly once', (graph.match(/requirementDefects\(/g) ?? []).length, 1);
check('reported on the document that ships', /const requirementSummary = summarizeRequirements\(checkRequirements\(finalHtml, requirements\)\)/.test(graph) && /requirements: requirementSummary,/.test(graph), true);
check('a file carrying a requirement is repaired first', /carriesRequirement\(b\) - carriesRequirement\(a\)/.test(budget), true);
check('the reply states what was checked', /自動で確認できる\$\{checked\}件中\$\{req\.met\}件を満たしています/.test(reply), true);
check('and says what could not be checked, rather than implying it held', /自動では確認できない要件です/.test(reply), true);

check('the edit path extracts from the instruction the user wrote', /const editRequirementsPromise = extractRequirements\(requestedInstruction\)/.test(meta), true);
check('checks the edited project', /checkRequirements\(modifiedHtml, editRequirements\)/.test(meta), true);
check('and says which instructions did not land', read('src/orchestration/reply-text.ts').includes('次の指示は、変更後のソースで確認できませんでした'), true);
check('an edit sends its misses to the repair before replying',
  /const requirementMisses = requirementDefects\(checkRequirements\(modifiedHtml, editRequirements\)\)[\s\S]*introduced\.push\(\.\.\.requirementMisses\)[\s\S]*if \(introduced\.length > 0\)/.test(meta), true);
check('and re-checks them on the repaired document',
  meta.includes('after.push(...requirementDefects(checkRequirements(repaired, editRequirements)))'), true);
check('an edit repair that stops the project building is never kept',
  /const brokeBuild = Boolean\(toRunnableDocument\(repaired\)\.error\) && !toRunnableDocument\(modifiedHtml\)\.error[\s\S]*if \(!brokeBuild && after\.length < introduced\.length\)/.test(meta), true);
check('the repair is told the files a defect located', meta.includes('対象ファイル: ${d.paths.join'), true);
check('the reply is built from the checks on the shipped document', meta.includes('describeEditReply(plan, routePlan.parts, instruction, editChecks)'), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
