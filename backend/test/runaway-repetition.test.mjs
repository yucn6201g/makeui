// A specialist that stopped writing and started repeating.
//
// 2026-09-18, a Vue storefront on Spindle: `layout-architect` wrote its screens
// and then emitted 「 ← 」 until it hit the model's token ceiling, at which point
// the SDK failed the node —
//
//   node_id=<layout-architect>,
//   error=<Model reached maximum token limit. This is an unrecoverable state
//          that requires intervention.>
//
// Three things followed, and the user reported all three. The progress
// transcript showed nothing but arrows. The 34,349 characters that reached the
// build were the architect's section ALONE — the three specialists that hang off
// it never ran — carrying hundreds of arrows at the end. And the run recorded
// `partial: false`, so nothing anywhere said the specification was a quarter of
// one.
//
// Measured over 60 days: 353 design phases, 313 with all four sections, 39
// without, 18 of those carrying the architect's section alone. 11%.
//
//   node test/runaway-repetition.test.mjs      (from backend/)
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist/runaway.test.mjs');
await esbuild.build({
  entryPoints: [path.join(root, 'src/orchestration/strands-design.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile: out,
  external: ['@aws-sdk/*', '@smithy/*', '@strands-agents/*'],
  logLevel: 'error',
});
const { withoutRunaway, focusedStream } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- the shape that shipped -------------------------------------------------
const REAL = `══ SCREENS AND INFORMATION ARCHITECTURE ══
1. 商品一覧 (products) — 新着順に商品カードを並べる。カテゴリと価格帯で絞り込む。
2. 商品詳細 (product) — 写真、価格、素材、サイズ選択、カートに追加。
3. カート (cart) — 明細、数量変更、削除、小計と合計。`;
const ARROWS = ' ←'.repeat(350);

{
  const r = withoutRunaway(REAL + ARROWS);
  check('the repetition is cut', r.text, REAL);
  check('and its size is reported', r.cut, ARROWS.length);
  check('nothing of the specialist is lost', r.text.includes('カートに追加'), true);
}

// --- what must not be touched ------------------------------------------------
check('ordinary prose is returned unchanged', withoutRunaway(REAL).cut, 0);
check('a short text is left alone', withoutRunaway('画面は3つです。').cut, 0);
check('an empty text is safe', withoutRunaway('').cut, 0);
// A table or a rule is a legitimate run of one character, and it stops at a
// line. A model that has stopped writing does not stop at a line.
check('a horizontal rule survives', withoutRunaway(`${REAL}\n${'─'.repeat(40)}`).cut, 0);
check('a markdown table divider survives', withoutRunaway(`${REAL}\n|${'---|'.repeat(6)}`).cut, 0);
check('a rule on a line of its own is still decoration',
  withoutRunaway(`${REAL}\n${'─'.repeat(90)}`).cut, 0);
// The loop this was written for is not the only shape one takes.
check('a repeated word is cut too', withoutRunaway(`${REAL}${' です。'.repeat(80)}`).cut > 0, true);
check('a repeated newline pair is cut', withoutRunaway(`${REAL}${'\n-'.repeat(200)}`).cut > 0, true);

// --- the transcript stops showing it -----------------------------------------
{
  const byNode = new Map();
  const shown = [];
  const s = focusedStream(byNode, (t) => shown.push(t));
  s.started('layout-architect');
  s.delta('layout-architect', REAL);
  for (let i = 0; i < 350; i++) s.delta('layout-architect', ' ←');
  check('the last thing the user sees is the writing, not the loop', shown.at(-1), REAL);
  check('but the raw text is still captured in full',
    byNode.get('layout-architect').length, REAL.length + ARROWS.length);
}

// --- it is cheap enough to run on every delta --------------------------------
{
  const long = REAL.repeat(400);            // ~70,000 characters of real prose
  const started = Date.now();
  for (let i = 0; i < 2000; i++) withoutRunaway(long);
  const ms = Date.now() - started;
  check(`2,000 calls on 70KB of prose stay under 300ms (${ms}ms)`, ms < 300, true);
}

// --- the wiring ---------------------------------------------------------------
const src = fs.readFileSync(path.join(root, 'src/orchestration/strands-design.ts'), 'utf8');
check('the streamed backfill cuts it before the spec is assembled',
  /const \{ text: usable, cut \} = withoutRunaway\(text\.trim\(\)\)/.test(src), true);
check('a specialist that produced nothing is asked again, once',
  /absent\.map\(async \(id\) => \{[\s\S]{0,400}byId\[id\]\.invoke\(/.test(src), true);
check('and it is handed what the graph would have handed it',
  /\$\{briefText\}[\s\S]{0,40}\$\{SECTION_TITLE\[source\]\}[\s\S]{0,20}\$\{sourceText\}/.test(src), true);
check('the retry is billed like any other call',
  /recordTokens\(usage\.inputTokens, usage\.outputTokens, `design:\$\{id\}`\)/.test(src), true);
check('a missing section makes the run partial',
  /partial: timedOut \|\| stillMissing\.length > 0/.test(src), true);
check('and the log names what is missing', /missing: stillMissing\.join\(','\)/.test(src), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
