/**
 * The critic no longer asks for findings nothing acts on.
 *
 * `repairable()` has refused `visual-spacing`, `visual-alignment` and
 * `visual-hierarchy` for a while — measured yield 4%, 21%, 23% — but the critic
 * was still asked for them. Over 14 days of Runtime logs they were detected 102
 * times, skipped 102 times, and shipped: a share of 96 vision calls a fortnight
 * spent producing a to-do list nobody was working from, and an "open defects"
 * report that named things the pipeline had already decided not to attempt.
 *
 * The removal is deliberately in two places. The prompt stops asking, which is
 * where the tokens are; and the output is filtered anyway, because a prompt is a
 * request and not a constraint — a model told not to mention spacing will
 * mention spacing.
 *
 * The filter is keyed off the SAME `repairable()` the repair loop consults, so
 * the two cannot drift. That is the property this file exists to hold: making
 * one of them repairable again is one edit, in repair-yield.ts, and the critic
 * has to start asking for it again on its own.
 *
 *   node test/visual-critic-scope.test.mjs      (from backend/)
 */
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist/visual-critic-scope.test.mjs');
fs.mkdirSync(path.dirname(out), { recursive: true });
const entry = path.join(root, 'dist/visual-critic-scope-entry.ts');
fs.writeFileSync(entry, [
  "export { critiqueScreenshot } from '../src/orchestration/visual-critic.js'",
  "export { repairable } from '../src/orchestration/repair-yield.js'",
].join('\n'));
await esbuild.build({
  entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out,
  external: ['@aws-sdk/*', '@smithy/*', '@strands-agents/*'],
});
const { critiqueScreenshot, repairable } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/** Answers with whatever it is told to, and records the prompt it was given. */
let systemSeen = '';
const stub = (reply) => async (system) => { systemSeen = system; return reply; };
const ids = (ds) => ds.map((d) => d.id).sort();

// --- the prompt no longer asks -------------------------------------------------
await critiqueScreenshot('AAAA', 'ctx', stub('OK'));
check('the critic was asked something', systemSeen.length > 0, true);
check('the three it will not act on are not in the reply schema',
  ['hierarchy|', '|spacing', '|alignment'].filter((t) => systemSeen.includes(t)), []);
check('and the categories it does act on still are',
  ['typography', 'density'].filter((t) => !systemSeen.includes(t)), []);
// Accent and artefact left on 2026-09-14: repairs left them standing more often than asking twice did.
check('accent and artefact are not in the reply schema either',
  ['|accent', 'accent|', '|artefact', 'artefact|', 'アクセントの使い方', '装飾の事故'].filter((t) => systemSeen.includes(t)), []);
// The bullets that described them are gone too, or the model is being told to
// look for something the schema has no slot for.
check('nor are they described in the list of what to report',
  ['階層が読めない', '余白のリズム', '整列が揃っていない'].filter((t) => systemSeen.includes(t)), []);

// --- and the output is filtered anyway ----------------------------------------
/*
 * A prompt is a request, not a constraint. This is the half that holds when the
 * model answers outside the schema, which it will.
 */
const asked = JSON.stringify({
  issues: [
    { id: 'spacing', fix: 'カード間のギャップを24pxに統一する' },
    { id: 'hierarchy', fix: '見出しを20pxにして本文との差をつける' },
    { id: 'alignment', fix: '左端を16pxに揃える' },
    { id: 'density', fix: '一覧の行高を32pxに詰める' },
    { id: 'accent', fix: '主要アクションだけをブランド色にする' },
  ],
});
const kept = await critiqueScreenshot('AAAA', 'ctx', stub(asked));
check('a refused finding is dropped even when the model returns it',
  ids(kept), ['visual-density']);
/*
 * And the cap is spent on what a pass can act on.
 *
 * It was applied before the filter, so a reply opening with spacing, hierarchy
 * and alignment had three of its four slots gone before anything was dropped —
 * the fixture above lost `visual-accent` entirely. The cap bounds what a pass is
 * asked to do, so it has to count only what a pass can be asked to do.
 */
const crowded = await critiqueScreenshot('AAAA', 'ctx', stub(JSON.stringify({
  issues: [
    { id: 'spacing', fix: 'カード間のギャップを24pxに統一する' },
    { id: 'hierarchy', fix: '見出しを20pxにして本文との差をつける' },
    { id: 'alignment', fix: '左端を16pxに揃える' },
    { id: 'density', fix: '一覧の行高を32pxに詰める' },
    { id: 'accent', fix: '主要アクションだけをブランド色にする' },
    { id: 'typography', fix: '本文を14pxに下げる' },
    { id: 'artefact', fix: 'フォーカスリングが出たままなので消す' },
  ],
})));
check('refused findings do not eat the budget', ids(crowded),
  ['visual-density', 'visual-typography']);
// The cap, with more acted-on findings than it allows.
const many = await critiqueScreenshot('AAAA', 'ctx', stub(JSON.stringify({
  issues: [1, 2, 3, 4, 5].flatMap((n) => [
    { id: 'typography', fix: `見出し${n}を20pxにして本文との差をつける` },
    { id: 'density', fix: `一覧${n}の行高を32pxに詰める` },
  ]),
})));
check('and the cap still holds at four', many.length, 4);
check('and what survives keeps its instruction',
  kept.every((d) => d.instruction.length > 10), true);

// The filter and the repair loop read one list.
check('the dropped ones are exactly the ones the loop refuses',
  ['visual-spacing', 'visual-alignment', 'visual-hierarchy', 'visual-accent', 'visual-artefact'].filter(repairable), []);
check('and the kept ones are ones it accepts',
  ids(kept).filter((id) => !repairable(id)), []);
// Stated against the source, because "they happen to agree today" is not the
// property — the property is that there is one list.
const critic = fs.readFileSync(path.join(root, 'src/orchestration/visual-critic.ts'), 'utf8');
check('the critic imports that list rather than restating it',
  /import \{ repairable \} from '\.\/repair-yield\.js'/.test(critic), true);
check('and has no second copy of the names',
  /visual-spacing|visual-alignment|visual-hierarchy/.test(
    critic.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')), false);
// Only report the drop when there was one: a line on every clean critique is
// noise in the log this measurement came from.
check('a drop is logged', /dropped findings nothing repairs/.test(critic), true);
check('only when something was dropped', /kept\.length < found\.length/.test(critic), true);

// --- the cases that must not change -------------------------------------------
check('a clean screenshot still returns nothing', await critiqueScreenshot('AAAA', 'ctx', stub('OK')), []);
check('no screenshot at all is not a call',
  await critiqueScreenshot('', 'ctx', async () => { throw new Error('should not be called'); }), []);
// A critique is an improvement, never a gate.
check('an unparsable reply is not a failure',
  await critiqueScreenshot('AAAA', 'ctx', stub('すみません、判断できません')), []);
check('nor is a thrown call',
  await critiqueScreenshot('AAAA', 'ctx', async () => { throw new Error('boom'); }), []);
// A fix too short to act on was never a finding.
check('an empty instruction is still dropped',
  await critiqueScreenshot('AAAA', 'ctx', stub(JSON.stringify({ issues: [{ id: 'density', fix: '短い' }] }))), []);

// --- what the user reads is not what the repair model is told ----------------------
/*
 * The 2026-09-13 reply listed a critic finding as the instruction itself, with
 * the suffix this module appends, clipped: 「…大きくする（現在、…不足している）
 * 画面の構成や文言は変えず、この…」. The reply below is REAL — Haiku, against the
 * current prompt, on a screenshot of that run's shipped document.
 */
{
  const REAL = "```json\n{\n  \"issues\": [\n    {\n      \"id\": \"typography\",\n      \"problem\": \"ページタイトル「蔵書一覧」が見出しとして機能していません\",\n      \"fix\": \"「蔵書一覧」のフォントサイズを28px以上に拡大し、フォントウェイトを700に変更する\"\n    },\n    {\n      \"id\": \"artefact\",\n      \"problem\": \"テーブル内の背景色が行によって異なり、統一性がありません\",\n      \"fix\": \"テーブルの行背景色を白に統一するか、奇数行と偶数行で明確に分ける場合はその基準を全行に適用する\"\n    },\n    {\n      \"id\": \"density\",\n      \"problem\": \"テーブルのセル内の縦方向の余白が圧縮されており、テキストが窮屈です\",\n      \"fix\": \"テーブルセルのpadding-topとpadding-bottomをそれぞれ12pxに設定する\"\n    }\n  ]\n}\n```";
  const found = await critiqueScreenshot('AAAA', 'ctx', stub(REAL));
  // The artefact finding in that reply is dropped since 2026-09-14; the two the loop acts on remain.
  check('the user reads the problem', found.map((d) => d.note), [
    'ページタイトル「蔵書一覧」が見出しとして機能していません',
    'テーブルのセル内の縦方向の余白が圧縮されており、テキストが窮屈です',
  ]);
  check('the repair model still gets the fix, with its guard', found[0].instruction,
    '「蔵書一覧」のフォントサイズを28px以上に拡大し、フォントウェイトを700に変更する 画面の構成や文言は変えず、この見た目の問題だけを直してください。');
  check('the prompt asks for it', systemSeen.includes('"problem":'), true);

  // A model that leaves `problem` out still does not leak the instruction's tail.
  const bare = await critiqueScreenshot('AAAA', 'ctx', stub(JSON.stringify({ issues: [{ id: 'typography',
    fix: 'ページタイトル「蔵書一覧」のフォントサイズを、サイドバーの「蔵書一覧」ボタンより明確に大きくする（現在、ボタンとタイトルの視覚階層が不足している）' }] })));
  check('without a problem, the category and the head of the fix',
    bare[0].note, '文字の大きさや強弱: ページタイトル「蔵書一覧」のフォントサイズを、サイドバーの「蔵書一覧」ボタンより明確に大きくする');
  check('never the suffix meant for the model', /画面の構成や文言は変えず/.test(bare[0].note), false);
  check('and never longer than sixty characters', bare[0].note.length <= 60, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
