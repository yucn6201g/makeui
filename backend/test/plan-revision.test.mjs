// A message that answers a proposal amends it; it is not a new brief.
//
// Plan mode ran the whole design phase — about 42,000 tokens — on 「画面をもう1つ
// 増やして」 alone, without the proposal it was changing. One call now reads the
// specification and the change, and writes both the amendment and the rewritten
// proposal.
//
//   node test/plan-revision.test.mjs      (from backend/)
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await esbuild.build({
  entryPoints: [path.join(root, 'src/orchestration/plan-revision.ts')], bundle: true, platform: 'node', format: 'esm',
  outfile: path.join(root, 'dist/plan-revision.test.mjs'), logLevel: 'error',
});
const pr = await import(pathToFileURL(path.join(root, 'dist/plan-revision.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const REVISION = { spec: 'SCREENS\n- products\n- cart', plan: '## 作るもの\nEC サイトです。', prompt: 'ECサイトを作って' };
const PLAN = '## 作るもの\nレディースアパレルの EC サイトです。\n\n## 画面構成\n- 商品一覧 — 写真・商品名・価格のカードを3列で表示\n- お気に入り — ハートを押した商品の一覧\n- カート — 数量変更と小計\n\n## 主な動作\n- ハートを押すとお気に入りに追加';

{
  const reply = `<<<REVISIONS>>>\n- お気に入り画面を追加。商品カードのハートで追加し、ナビに載せる\n<<<PLAN>>>\n${PLAN}`;
  const r = pr.applyRevision(REVISION, 'お気に入り画面を追加して', reply);
  check('the amendment is read', r.revisions, '- お気に入り画面を追加。商品カードのハートで追加し、ナビに載せる');
  check('the rewritten proposal is read', [r.rewrote, r.plan], [true, PLAN]);
  check('the amendment goes on top of the specification', r.spec.startsWith(pr.REVISIONS_HEADING), true);
  check('saying it overrides what follows', /下の設計仕様より優先/.test(r.spec.split('\n')[0]), true);
  check('with the change in the user\'s words', r.spec.includes('追加指示: 「お気に入り画面を追加して」'), true);
  check('and the specification it amends below, whole', r.spec.endsWith(REVISION.spec), true);

  // A second amendment stacks above the first: newest first, as the note says.
  const again = pr.applyRevision({ ...REVISION, spec: r.spec }, '色を緑に', `<<<REVISIONS>>>\n- アクセント #1B7F3A\n<<<PLAN>>>\n${PLAN}`);
  check('a second amendment stacks above the first',
    [again.spec.indexOf('色を緑に') < again.spec.indexOf('お気に入り画面を追加して'), again.spec.split(pr.REVISIONS_HEADING).length - 1], [true, 2]);
}
{
  // No markers: the whole reply is the amendment, and the caller writes the proposal.
  const r = pr.applyRevision(REVISION, '画面を増やして', '- 設定画面を追加');
  check('a reply without markers keeps the change', [r.revisions, r.rewrote, r.plan], ['- 設定画面を追加', false, '']);
  // A PLAN section too thin to show is not shown.
  const thin = pr.applyRevision(REVISION, 'x', '<<<REVISIONS>>>\n- a\n<<<PLAN>>>\n了解しました');
  check('a proposal without its headings is rewritten by the caller', thin.rewrote, false);
  // Fences around the reply are not part of it.
  const fenced = pr.applyRevision(REVISION, 'x', '```\n<<<REVISIONS>>>\n- a\n<<<PLAN>>>\n' + PLAN + '\n```');
  check('fences are stripped', [fenced.revisions, fenced.plan.endsWith('お気に入りに追加')], ['- a', true]);
  // An empty amendment still records the instruction, which must not be lost.
  const empty = pr.applyRevision(REVISION, '文言を丁寧に', `<<<REVISIONS>>>\n<<<PLAN>>>\n${PLAN}`);
  check('an empty amendment still carries the instruction', empty.spec.includes('追加指示: 「文言を丁寧に」'), true);
}
{
  const input = pr.reviserInput({ ...REVISION, spec: 'x'.repeat(50_000) }, 'お気に入りを追加');
  check('the reviser reads the request, the change, the proposal and the specification',
    ['元の依頼: "ECサイトを作って"', '追加指示: "お気に入りを追加"', '## 作るもの', 'x'.repeat(100)].every((s) => input.includes(s)), true);
  check('and a bounded part of a long specification', input.length < 30_000, true);
  const sys = pr.reviserSystem('FORMAT-HERE');
  check('the system prompt carries the proposal format', sys.includes('FORMAT-HERE'), true);
}

// --- wiring ------------------------------------------------------------------------
const graph = fs.readFileSync(path.join(root, 'src/orchestration/graph.ts'), 'utf8');
const planBody = graph.slice(graph.indexOf('async function runPlan('), graph.indexOf('const PLAN_WRITER_SYSTEM'));
check('runPlan amends before it would run the design phase',
  planBody.indexOf('options.revision') > -1 && planBody.indexOf('options.revision') < planBody.indexOf('runDesignSwarm({'), true);
check('the amendment is its own ledger stage', /'plan:revise'/.test(planBody), true);
check('and every plan writer call is attributed', (planBody.match(/invokeModel\(/g) ?? []).length, (planBody.match(/'plan:(?:write|write-change|revise)'/g) ?? []).length);
const handler = fs.readFileSync(path.join(root, 'src/handlers/lambda-handler.ts'), 'utf8');
check('the route checks the revision', /revision must carry spec/.test(handler), true);
check('and sends a long specification through S3', /uploadSpecIfNeeded\(jobId, r\.spec\)/.test(handler), true);
const runner = fs.readFileSync(path.join(root, 'src/handlers/job-runner.ts'), 'utf8');
check('the job passes it to planUI', /revision: await resolveJobRevision\(input\)/.test(runner), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
