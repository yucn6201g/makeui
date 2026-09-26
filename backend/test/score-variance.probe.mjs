// The same brief, three times: which parts of the score are signal?
//
// A run-to-run difference has been read as a quality difference all along — and
// the corpus says the same brief has come back at 33 and at 84. Until it is
// known how much the number moves when NOTHING changes, no measurement of an
// improvement means anything: the whole point of the token work was to show
// quality held, and every comparison of it was one run against one run.
//
// scripts/score-items.mjs answered the free half of this — which checks vary
// across DIFFERENT briefs — and 22 of 39 turned out never to move at all, so
// they became gates. What is left is 17 checks and 77 points, and this asks the
// expensive half: of those, which move when the brief is held fixed?
//
// A check that varies here cannot be used to judge a regression. A check that is
// identical across three runs of the same brief, and varies across briefs, is
// the part of the score worth watching.
//
//   node test/score-variance.probe.mjs [runs] [kind]     (from backend/, default 3 react)
//
// Costs one full generation per run. Run it deliberately.
//
// MEASURED, rubric 3, Haiku, React, the brief below, 2026-09-03:
//
//   scores    75  86  75      spread 11
//   contract  76/77  67/77  65/77
//   runtime   32-24  32-5  32-12     (all three rendered)
//   tokens    335,971  187,499  203,614
//   8 checks moved, 35 identical
//
// That is the noise floor: a single-run comparison cannot see a change smaller
// than about ten points, and the eight checks that moved cannot judge a
// regression at all.
//
// The run before it, on the same scale and the same brief, read 30 / 60 / 74 —
// and the 30 was a build that imported `date-fns`, which the preview does not
// have, so the page was blank and the repair that followed was rejected for the
// blank page it could not clear. The guards in build-files.ts and
// repair-files.ts went in between the two measurements. Two samples of three do
// not prove a cause, but the mechanism is not in doubt: `foreignImport` was run
// over that document's own files and catches both of them.
//
// The lesson for reading any of these numbers: a spread of 44 was mostly one
// bug, and a single run of that set would have said 30 or 74 depending on which
// one you drew.
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { DynamoDBClient, PutItemCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

if (!process.execArgv.includes('--enable-source-maps')) {
  execFileSync(process.execPath, ['--enable-source-maps', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit' });
  process.exit(0);
}

const REGION = 'ap-northeast-1';
const ARN = 'arn:aws:bedrock-agentcore:ap-northeast-1:123456789012:runtime/makeuiBackend-EXAMPLE123';
const TABLE = 'makeui-token-usage';
const BUCKET = 'makeui-outputs-123456789012';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runs = Number(process.argv[2] ?? 3);
const kind = process.argv[3] ?? 'react';
/*
 * `--from <dir>` re-analyses documents an earlier invocation already paid for.
 * The rubric changes more often than the corpus does, and paying for three
 * generations to re-read three files answers nothing the files do not.
 */
const fromDir = process.argv.includes('--from') ? process.argv[process.argv.indexOf('--from') + 1] : null;
/*
 * The preset the runs were made with, and it matters.
 *
 * Scoring them with no preset was a 20-point hole: `none` HAS a signature — it
 * is the most-used option and the one where machine-made defaults creep back —
 * so `presetConformance` runs on every real generation and contributes 20 of
 * the contract half's 97 possible points. Passing `undefined` dropped that
 * check from the table entirely, and left the local total reading 14 above the
 * Runtime's, which looked like a stale deploy.
 */
const PRESET = 'none';

/*
 * One brief, held fixed.
 *
 * Ordinary rather than exotic: a form, a list, a detail view and a status
 * change is the shape most briefs reduce to, and an unusual one would measure
 * the pipeline's handling of the unusual instead of its run-to-run spread.
 */
const BRIEF = [
  '経費精算の申請と承認ができる社内向けアプリを作ってください。',
  '申請者は経費を登録し（日付・金額・カテゴリ・目的・領収書の有無）、下書き保存と提出ができます。',
  '承認者は提出済みの一覧を確認し、1件ずつ承認または差し戻しができます。差し戻しには理由が必要です。',
  '一覧は状態（下書き・申請中・承認済み・差し戻し）で絞り込めて、明細をクリックすると詳細が開きます。',
  '月ごとの合計金額と件数がわかるダッシュボードも用意してください。',
].join('\n');

const ddb = new DynamoDBClient({ region: REGION });
const agent = new BedrockAgentCoreClient({ region: REGION });
const s3 = new S3Client({ region: REGION });
const outDir = path.join(root, 'dist/variance');
fs.mkdirSync(outDir, { recursive: true });

async function one(i) {
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const userId = 'variance-probe';
  await ddb.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      pk: { S: `JOB#${jobId}` }, sk: { S: 'META' }, userId: { S: userId },
      status: { S: 'pending' }, createdAt: { S: now }, updatedAt: { S: now },
      ttl: { N: String(Math.floor(Date.now() / 1000) + 7200) },
    },
  }));
  await agent.send(new InvokeAgentRuntimeCommand({
    agentRuntimeArn: ARN,
    runtimeSessionId: crypto.randomUUID().replace(/-/g, '') + `variancerun${i}`,
    payload: new TextEncoder().encode(JSON.stringify({
      jobId, userId, jobType: 'generate',
      input: { prompt: BRIEF, model: 'haiku', effort: 'standard', outputKind: kind, preset: 'none' },
    })),
  }));
  const t0 = Date.now();
  for (let n = 0; n < 500; n += 1) {
    await new Promise((r) => setTimeout(r, 5000));
    const it = (await ddb.send(new GetItemCommand({
      TableName: TABLE, Key: { pk: { S: `JOB#${jobId}` }, sk: { S: 'META' } },
    }))).Item ?? {};
    const st = it.status?.S ?? '?';
    if (st === 'failed') { console.log(`run ${i}: FAILED ${it.errorMsg?.S ?? it.error?.S}`); return null; }
    if (st !== 'completed') continue;
    const res = JSON.parse(it.resultJson.S);
    const html = await (await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: res.s3Key }))).Body.transformToString();
    const file = path.join(outDir, `run${i}.html`);
    fs.writeFileSync(file, html);
    const m = res.metadata ?? {};
    const p = m.scoreParts;
    console.log(`run ${i}: ${Math.round((Date.now() - t0) / 1000)}s  score ${res.qualityScore}` +
      (p ? `  contract ${Math.round(p.contract.earned)}/${p.contract.possible}` +
        `  runtime ${p.runtime ? `${p.runtime.earned}/${p.runtime.possible} -${p.runtime.penalty}` : 'not measured'}` +
        `  rubric ${p.rubric ?? '?'}` : '  (no scoreParts — the deploy is behind)') +
      `  tokens ${m.tokenUsage ? m.tokenUsage.inputTokens + m.tokenUsage.outputTokens : '?'}`);
    return { file, score: res.qualityScore, parts: p, tokens: m.tokenUsage, html };
  }
  console.log(`run ${i}: timed out`);
  return null;
}

console.log(`${runs} runs of one brief, ${kind}, haiku\n`);
const results = fromDir
  ? JSON.parse(fs.readFileSync(path.join(fromDir, 'summary.json'), 'utf8')).runs
      .map((r) => ({ ...r, html: fs.readFileSync(r.file, 'utf8') }))
  : (await Promise.all(Array.from({ length: runs }, (_, i) => one(i + 1)))).filter(Boolean);
if (results.length < 2) { console.error('need at least two runs to say anything about spread'); process.exit(1); }

// --- score each one, recording every check ------------------------------------------
const entry = path.join(root, 'dist/var-entry.ts');
fs.writeFileSync(entry, "export { scoreHtml } from '../src/orchestration/audit/scoring.js';\n");
execFileSync(process.execPath, [path.join(root, 'node_modules/esbuild/bin/esbuild'), entry, '--bundle',
  '--platform=node', '--format=esm', '--sourcemap=inline', `--outfile=${path.join(root, 'dist/var.mjs')}`,
  '--external:@aws-sdk/*', '--external:@smithy/*', '--external:@strands-agents/*'], { stdio: 'pipe', cwd: root });
const bundle = path.join(root, 'dist/var.mjs');
let js = fs.readFileSync(bundle, 'utf8');
let probed = 0;
js = js.replace(/(award\(hit, weight\) \{|partial\(got, weight\) \{|deduct\(points\) \{|gate\(hit, weight\) \{)/g,
  (m) => { probed += 1; return `${m}\nglobalThis.__ITEM__ && globalThis.__ITEM__(new Error().stack, arguments);`; });
if (probed !== 4) { console.error(`probed ${probed} of 4 Rubric methods`); process.exit(1); }
fs.writeFileSync(bundle, js);
const { scoreHtml } = await import(pathToFileURL(bundle).href);

let cur = null;
globalThis.__ITEM__ = (stack, args) => {
  if (!cur) return;
  const frames = String(stack).split('\n');
  const at = /scoring\.ts:(\d+)/.exec(frames[2] ?? '');
  if (!at) return;
  const method = /Rubric\.(\w+)/.exec(frames[1] ?? '');
  cur.push({ site: Number(at[1]), a: args[0], w: args[1], gate: method?.[1] === 'gate' });
};

const src = fs.readFileSync(path.join(root, 'src/orchestration/audit/scoring.ts'), 'utf8').split(/\r?\n/);
const nearest = (line) => {
  for (let i = line - 1; i >= Math.max(0, line - 5); i -= 1) {
    if (/r\.(award|partial|deduct|gate)\(/.test(src[i] ?? '')) return `${i + 1}: ${src[i].trim().slice(0, 66)}`;
  }
  return `${line}: ${(src[line - 1] ?? '').trim().slice(0, 62)}`;
};

/*
 * What one check contributed: a gate pays nothing when it holds and its weight
 * as a demerit when it does not, a demerit is negative, an award is its weight.
 */
const value = (c) => (c.gate ? (c.a === true ? 0 : -c.w)
  : c.w === undefined ? -c.a
  : c.a === true ? c.w : c.a === false ? 0 : Math.max(0, Math.min(c.w, c.a)));
const PROJECT_RUBRIC_ENDS = 300;

const scored = results.map((r) => {
  cur = [];
  const total = scoreHtml(r.html, PRESET, kind);
  const calls = cur; cur = null;
  // Awards and partials only. `contract.earned` is what was earned out of what
  // was available; gates and demerits are the penalty, which is reported beside
  // it and not inside it — summing all three here made two of three runs look
  // like a stale deploy by exactly their deductions.
  const contract = calls
    .filter((c) => c.site < PROJECT_RUBRIC_ENDS && !c.gate && c.w !== undefined)
    .reduce((a, c) => a + value(c), 0);
  return { ...r, rescored: total, contract, calls };
});

/*
 * Is the deployed rubric this rubric?
 *
 * Against the TOTAL it cannot be asked: the Runtime's number includes what a
 * browser measured and nothing here opened a browser, so the two differ by the
 * runtime half every time — which is what the first version of this reported,
 * three times, as a stale deploy.
 *
 * The contract half is deterministic from the document, so it can be asked
 * there, and a disagreement means the deployed scorer is not this file.
 */
for (const s of scored) {
  const stored = s.parts?.contract?.earned;
  if (stored !== undefined && Math.abs(stored - s.contract) > 0.5) {
    console.log(`\nWARNING contract half: Runtime ${Math.round(stored)}, recomputed here ${Math.round(s.contract)}` +
      ' — the deployed scorer is not this code');
  }
}

const bySite = new Map();
for (const s of scored) {
  for (const c of s.calls) {
    if (c.site >= PROJECT_RUBRIC_ENDS) continue;
    const row = bySite.get(c.site) ?? { vals: [], gate: c.gate, w: c.w };
    row.vals.push(value(c));
    bySite.set(c.site, row);
  }
}

const moved = [], held = [], partial = [];
for (const [site, row] of bySite) {
  if (row.vals.length !== scored.length) {
    /*
     * A demerit is only CALLED when its condition holds, so a document without
     * the fault records nothing at that site. Absence there means zero, and
     * treating it as a missing measurement hid a check that fired in one run of
     * three — which is precisely the kind of movement this is looking for.
     *
     * An award or a gate is unconditional. If one of those is missing, a run was
     * not scored on the project rubric at all, and that is a finding about the
     * pipeline rather than a row in a variance table.
     */
    if (row.w === undefined) {
      while (row.vals.length < scored.length) row.vals.push(0);
    } else {
      partial.push({ site, ...row });
      continue;
    }
  }
  const uniq = new Set(row.vals);
  (uniq.size > 1 ? moved : held).push({ site, ...row, spread: Math.max(...row.vals) - Math.min(...row.vals) });
}
moved.sort((a, b) => b.spread - a.spread);

console.log(`\n${scored.length} runs of the same brief\n`);
console.log(`scores      ${scored.map((s) => s.score).join(' ')}`);
if (scored[0].parts) {
  console.log(`contract    ${scored.map((s) => `${Math.round(s.parts.contract.earned)}/${s.parts.contract.possible}`).join('  ')}`);
  console.log(`runtime     ${scored.map((s) => (s.parts.runtime ? `${s.parts.runtime.earned}-${s.parts.runtime.penalty}` : 'n/a')).join('  ')}`);
}
console.log(`tokens      ${scored.map((s) => (s.tokens ? s.tokens.inputTokens + s.tokens.outputTokens : '?')).join(' ')}`);

console.log(`\n${moved.length} checks moved between runs of the SAME brief — these cannot judge a regression:`);
const r1 = (n) => (Math.round(n * 10) / 10).toString();
for (const m of moved) {
  console.log(`  ±${r1(m.spread).padStart(4)}  [${m.vals.map(r1).join(' ')}]  ${nearest(m.site)}`);
}
console.log(`\n${held.length} checks were identical across all runs.`);
if (partial.length) {
  console.log(`\n${partial.length} checks did not run in every document — one run was not scored as a project:`);
  for (const q of partial) console.log(`  ${nearest(q.site)}`);
}

fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
  brief: BRIEF, kind,
  runs: scored.map((s) => ({ score: s.score, parts: s.parts, tokens: s.tokens, file: s.file })),
  moved: moved.map((m) => ({ check: nearest(m.site), values: m.vals })),
}, null, 2));
console.log(`\nwrote ${path.join(outDir, 'summary.json')}`);
