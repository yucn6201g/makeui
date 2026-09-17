// The reply says what the model intended. It never said what came out.
//
// Measured on the newest stored reply (2026-09-04): it opens 「緻密な設計を確認
// しました」 and continues 「これから…一気に生成します」 — future tense, about a
// run that had already finished. Everything needed to answer 「何が出来たのか」
// was measured and already on the wire in `metadata.verification`, and the
// frontend had no reference to any of it.
//
// What is asserted here is the thing that made it worth adding: it must not
// report zeros for a run that never opened the page. 節約 and 高速 skip
// verification, and 「コンソールエラーはありません」 from a run with no browser in
// it is the same false claim the score's 「静的のみ」 mark exists to prevent.
//
//   node test/reply-outcome.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'dist/reply-entry.ts');
fs.mkdirSync(path.dirname(entry), { recursive: true });
fs.writeFileSync(entry,
  "export { describeOutcome, replyWithOutcome, replyText, stripSelfAddressedScaffolding, conciseDescription } from '../src/orchestration/reply-text.js';\n");
execSync(
  `npx esbuild "${entry}" --bundle --platform=node --format=esm --outfile="${path.join(root, 'dist/reply.test.mjs')}" ` +
    `--external:@aws-sdk/* --external:@smithy/* --external:@strands-agents/*`,
  { stdio: 'pipe', cwd: root }
);
const { describeOutcome, replyWithOutcome, replyText, stripSelfAddressedScaffolding, conciseDescription } = await import(
  pathToFileURL(path.join(root, 'dist/reply.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/** The run of 2026-09-04, as its metadata recorded it. */
const RUN = {
  verified: true,
  reached: 5,
  declared: 5,
  consoleErrors: 0,
  files: 31,
  screens: 5,
  components: 15,
  defects: [
    { id: 'action-dead-runtime', note: '画面内の次のボタンは、実際にクリックしても何も起きません: 提出。' },
    { id: 'nav-dead-runtime', note: '実際にクリックしても画面が変わらないナビゲーション項目があります: 承認待ち。' },
    { id: 'contrast-low', note: 'コントラスト比が WCAG AA を下回るテキストがあります。' },
    { id: 'icons', note: 'アイコンがどの画面からも描画されていません。' },
  ],
};

// --- the run that was verified -------------------------------------------------------
{
  const text = describeOutcome(RUN);
  check('it says the screens were all reached', /5画面すべてに到達しました/.test(text), true);
  check('and that nothing threw', /コンソールエラーはありません/.test(text), true);
  check('and how much was built', /31ファイル（画面5・コンポーネント15）/.test(text), true);
  check('and how many findings are open', /未解決の指摘が4件あります/.test(text), true);

  /*
   * Every finding named, none counted.
   *
   * This used to name three and say 「・ほか1件」, because the bullets sat in the
   * reply unfolded and buried what was asked for. The chat folds them now, and a
   * fold that opens onto 「ほか1件」 has nothing in it — so the whole list goes in.
   */
  check('every finding is named', (text.match(/^・/gm) ?? []).length, 4);
  check('and none is merely counted', /ほか\d+件/.test(text), false);
  check('including the one that used to be cut', /アイコンがどの画面からも描画されていません/.test(text), true);
  // The heading is the frontend's anchor for folding; its exact form is pinned
  // on the other side too, in frontend/test/format-reply.test.mjs.
  check('the heading is on its own line, with nothing after it',
    /^未解決の指摘が4件あります。$/m.test(text), true);

  /*
   * Not the score and not the token count. Both have a chip in the meta row, and
   * `UI generated (Score: 74/100)` was removed from this text once already for
   * being a second copy of one of them, in English, in a Japanese thread.
   */
  check('the score is not repeated here', /\d+\s*\/\s*100|Score/.test(text), false);
  check('nor the token count', /token|トークン/i.test(text), false);
}

// --- the run that was not ------------------------------------------------------------
//
// The case this exists for.
{
  const text = describeOutcome({ verified: false, files: 22, screens: 4, components: 9 });
  check('an unverified run says so', /検証は行っていません/.test(text), true);
  check('and claims nothing about errors', /エラー/.test(text), false);
  check('and nothing about reach', /到達/.test(text), false);
  check('but still says what was built', /22ファイル/.test(text), true);
}

// A screen that could not be opened is named as a shortfall rather than rounded up.
{
  const text = describeOutcome({ ...RUN, reached: 3, consoleErrors: 2 });
  check('a partial walk is reported as one', /5画面中 3画面に到達しました/.test(text), true);
  check('and the errors are counted', /コンソールエラー 2件/.test(text), true);
}

// Nothing to say is nothing added, rather than an empty heading.
check('a run with no facts adds nothing', describeOutcome({ verified: false, files: 0 }),
  'ブラウザ実行による検証は行っていません（このモードでは省略されます）。');

// --- and the model's own words are kept ------------------------------------------------
//
// The two halves answer different questions. A fact list has no design reasoning
// in it, and the prose has been wrong about what shipped every time a repair was
// rejected.
{
  const prose = 'カフェの店内モバイルオーダーです。アクセントは焙煎色に絞ります。';
  const text = replyWithOutcome(prose, 'UIを生成しました。', RUN);
  check('the model keeps its paragraph', text.startsWith(prose), true);
  check('and the facts follow it', text.includes('5画面すべてに到達しました'), true);
  check('separated by a blank line, which is what formatReply splits blocks on',
    text.includes(`${prose}\n\n`), true);
}

// A run whose preamble was only a file plan still gets the facts.
{
  const text = replyWithOutcome('新規 src/App.tsx — shell', 'UIを生成しました。', RUN);
  check('the fallback replaces the plan', text.startsWith('UIを生成しました。'), true);
  check('and the facts are still there', /31ファイル/.test(text), true);
}

// --- the scaffolding the model was asked to write for itself --------------------------
//
// The build prompt says 「state your Step 0 choices to yourself」 — our words, our
// label — and the model writes a heading reading 「**Step 0 — 設計委譲前の確認**」.
// 設計委譲前の確認 is a note about a handover the reader is not part of, sitting
// above a list of decisions the reader may well want.
{
  const raw = [
    'カフェの店内モバイルオーダーです。',
    '',
    '**Step 0 — 設計委譲前の確認**',
    '',
    '- **Accent**: 焙煎色 `#8B6F47`',
    '- **Type**: タイトル 24-32px',
    '',
    '以下、React TypeScript で実装します。',
    '',
    '---',
  ].join(String.fromCharCode(10));
  const out = replyText(raw, 'UIを生成しました。');
  check('the label is gone', /Step\s*0/.test(out), false);
  check('but the decisions under it are kept',
    [/#8B6F47/.test(out), /24-32px/.test(out)], [true, true]);
  check('and the rule the document sat under is gone', /---/.test(out), false);

  /*
   * The closing 「これから…実装します」 is future tense about a finished run, which
   * reads oddly — and it usually carries design content too, so a rule that cut
   * it would cut that. The tense is a prompt question, not a text-surgery one,
   * and describeOutcome now follows it with what actually happened.
   */
  check('the closing sentence is left alone', /実装します/.test(out), true);
}

// Prose with no scaffolding in it comes back untouched.
check('an ordinary reply is not edited',
  stripSelfAddressedScaffolding('5画面を構築します。アクセントは1色に絞ります。'),
  '5画面を構築します。アクセントは1色に絞ります。');

// A rule in the middle of a reply is a separator the model chose, not a boundary
// artefact. Only a trailing one is removed.
check('a rule with text after it stays',
  /---/.test(stripSelfAddressedScaffolding('前段です。' + String.fromCharCode(10, 10) + '---' + String.fromCharCode(10, 10) + '後段です。')),
  true);

// --- the description, and only the description ---------------------------------------
//
// The preamble is not one thing. Measured on the stored replies: a sentence or
// two naming the product and the design direction, then — where the build
// prompt's 「state your Step 0 choices」 lands — a worksheet of accent, neutrals,
// type scale, radius and motion. 609 characters where the first 109 answered the
// question 「何を作ったか」.
{
  const NL = String.fromCharCode(10);
  const long = [
    '緻密な設計を確認しました。モバイルオーダーの本質は待ち時間の可視化です。カフェドメインから配色を決めます。',
    '',
    '- Accent: 焙煎色',
    '- Type: タイトル 24-32px',
  ].join(NL);
  const out = conciseDescription(long);
  check('the worksheet is not part of the description', /Accent|24-32px/.test(out), false);

  /*
   * A leading acknowledgement goes too. One reply in four opens 「緻密な設計を
   * 確認しました。」 — an answer to the design phase rather than to the reader.
   */
  check('an acknowledgement opener is dropped', out.startsWith('モバイルオーダー'), true);
}

/*
 * And the pattern is narrow on purpose. 「さくら歯科クリニックの予約システムを構築
 * します。」 is the description itself in the same grammatical shape, and a rule
 * that ate it would delete the answer.
 */
check('a description that merely resembles one is kept',
  conciseDescription('さくら歯科クリニックの予約システムを構築します。5画面を実装します。')
    .startsWith('さくら歯科'), true);

// Three sentences is a summary; the fourth is usually 「これから生成します」, which
// is future tense about a run that has finished.
//
// The fixture is long enough to be prose. `conciseDescription` now requires the
// paragraph it picks to be twenty characters or more, which is what tells
// 「それでは、本体を構築します。」 from a description — 「一です。二です。」 is
// neither, and asserting the sentence cap on a string that no longer qualifies
// would be asserting it on the empty answer.
check('it stops at three sentences',
  (conciseDescription('一つ目の文章です。二つ目の文章です。三つ目の文章です。四つ目の文章です。')
    .match(/。/g) ?? []).length, 3);

/*
 * A reply that is nothing but an acknowledgement now says nothing, and the
 * caller's fallback is what the reader sees.
 *
 * This used to assert the opposite — 「an acknowledgement alone is kept rather
 * than emptied」 — because at the time the alternative was `|| full`, which put
 * the whole preamble back. 「UIを生成しました。」 over the measured outcome is a
 * true sentence about a finished run; 「了解しました。」 is an answer to the
 * design phase that the reader was not part of.
 */
check('an acknowledgement alone yields nothing', conciseDescription('了解しました。'), '');
check('and the reader gets the fallback instead',
  replyWithOutcome('了解しました。', 'UIを生成しました。', { verified: false }).startsWith('UIを生成しました。'), true);
check('and nothing in means nothing out', conciseDescription(''), '');

// The whole point, end to end: the reply is the short description plus what was
// measured, and the worksheet is in neither.
{
  const NL = String.fromCharCode(10);
  const raw = [
    'カフェの店内モバイルオーダーです。待ち時間を見えるようにします。',
    '',
    '**Step 0 — 設計委譲前の確認**',
    '',
    '- **Accent**: 焙煎色',
  ].join(NL);
  const text = replyWithOutcome(raw, 'UIを生成しました。', RUN);
  check('the description leads', text.startsWith('カフェの店内モバイルオーダーです。'), true);
  check('the worksheet is gone', /Accent/.test(text), false);
  check('and the measured outcome follows', /5画面すべてに到達しました/.test(text), true);
}

// --- the user's requirements ----------------------------------------------------------
/*
 * How many of the checkable requirements held, and how many could not be checked
 * by machine at all — stated as a limit rather than folded into a success.
 */
{
  const text = describeOutcome({ ...RUN, requirements: { total: 6, met: 3, unmet: 1, unverified: 2, unmetScreens: [] } });
  check('it states how many checkable requirements held', /自動で確認できる4件中3件を満たしています/.test(text), true);
  check('and how many could not be checked', /ほかの2件は自動では確認できない要件です/.test(text), true);
  check('the line comes before the findings', text.indexOf('要件のうち') < text.indexOf('未解決の指摘が'), true);

  const screens = describeOutcome({ ...RUN, requirements: { total: 2, met: 1, unmet: 1, unverified: 0, unmetScreens: ['予約確認'] } });
  // Screens never reach the repair loop, so this is the only place a missing one is said.
  check('a missing screen is named', /画面「予約確認」は見つかりませんでした/.test(screens), true);

  // Nothing checkable is not a failure, and 「0件中0件」 would read as one.
  const onlyBehaviour = describeOutcome({ ...RUN, requirements: { total: 3, met: 0, unmet: 0, unverified: 3, unmetScreens: [] } });
  check('a request with nothing checkable adds no line', /要件のうち/.test(onlyBehaviour), false);
  check('and no checklist adds no line', /要件のうち/.test(describeOutcome(RUN)), false);
}

/*
 * 「4画面中 6画面に到達しました」, 2026-09-14. The walk lists every screen it landed
 * on under its hash, a parameterised route included, so its count can exceed the
 * project's. The reply counts the declared screens it did not report unreachable.
 */
{
  const graph = fs.readFileSync(path.join(root, 'src/orchestration/graph.ts'), 'utf8');
  check('reach is declared screens less the unreachable, not the walk\'s landing count',
    /reached: scoredFacts\s*\?\s*declaredScreenIds\(finalHtml\)\.length > 0\s*\?\s*Math\.max\(0, declaredScreenIds\(finalHtml\)\.length - scoredFacts\.unreachable\.length\)/.test(graph), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
