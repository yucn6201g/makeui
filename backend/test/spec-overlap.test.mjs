/**
 * How much the design specialists repeat each other.
 *
 * The specification is the most expensive prose in a run — a median 49,336
 * characters over 14 days, interaction 31% / style 28% / content 25% / layout
 * 12% — written as output and then read again by the build. Three specialists
 * are fanned out from the same layout-architect text, so each may restate its
 * screen list. Whether a terser format is worth trying depends on how much of
 * the spec is repetition, and nothing measured it.
 *
 * The measurement must be a FLOOR: exact normalised lines, so paraphrase is not
 * counted. A floor that is large makes the case; a floor that is small says
 * repetition is not where the characters go. An over-count would argue for a
 * change the data does not support.
 *
 *   node test/spec-overlap.test.mjs      (from backend/)
 */
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist/spec-overlap.test.mjs');
await esbuild.build({
  entryPoints: [path.join(root, 'src/orchestration/generate/strands-design.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile: out,
  external: ['@aws-sdk/*', '@smithy/*', '@strands-agents/*'],
  logLevel: 'error',
});
const { specOverlap } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const SCREENS = [
  '- DashboardScreen: 本日の受注件数と売上を数値カードで表示する',
  '- OrderListScreen: 注文番号・顧客名・金額・ステータスの一覧',
  '- OrderDetailScreen: 明細と配送先、ステータス変更の操作',
].join('\n');

const byNode = new Map([
  ['layout-architect', `## 画面\n${SCREENS}`],
  // Restates the architect's screen list, then adds its own.
  ['interaction-designer', `${SCREENS}\n- 発送済みにするボタンは確認モーダルを開いてから状態を書き換える`],
  // Shares nothing with anyone.
  ['style-expert', '- アクセントは深い藍色で、中立色は温かい灰色の階調を使う\n- 見出しは明朝体、本文はゴシック体で組む'],
]);
const o = specOverlap(byNode);

check('a specialist that restates the architect is measured as doing so', o.fromArchitect['interaction-designer'], 0.75);
check('one that shares nothing is zero', o.fromArchitect['style-expert'], 0);
check('pairs are measured too', o.pairwise['interaction-designer|style-expert'], 0);

// Formatting differences are not originality: the same line with other markers is a repeat.
const reformatted = new Map([
  ['layout-architect', '- DashboardScreen: 本日の受注件数と売上を数値カードで表示する'],
  ['content-strategist', '* **DashboardScreen**：本日の受注件数と売上を数値カードで表示する。'],
]);
check('the same line under different markup still counts as a repeat',
  specOverlap(reformatted).fromArchitect['content-strategist'], 1);

// A floor: a paraphrase is not counted, so the figure never over-states redundancy.
const paraphrase = new Map([
  ['layout-architect', '- DashboardScreen: 本日の受注件数と売上を数値カードで表示する'],
  ['content-strategist', '- ダッシュボードには今日の注文数と売上金額をカードで並べる'],
]);
check('a paraphrase is not counted', specOverlap(paraphrase).fromArchitect['content-strategist'], 0);

// Short lines are headings and labels that legitimately recur.
const headings = new Map([
  ['layout-architect', '## 画面一覧\n## 共有状態'],
  ['interaction-designer', '## 画面一覧\n## 共有状態'],
]);
check('short heading lines do not count as repetition', specOverlap(headings).fromArchitect, {});

const src = fs.readFileSync(path.join(root, 'src/orchestration/generate/strands-design.ts'), 'utf8');
check('the overlap is logged once per design phase', (src.match(/logSpecOverlap\(byNode\)/g) ?? []).length, 1);
check('from the texts the phase already assembled', src.indexOf('logSpecOverlap(byNode)') > src.indexOf('const byNode = new Map'), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
