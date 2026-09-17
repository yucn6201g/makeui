// Runs the same generations through the deployed Runtime, for a before/after comparison.
//
//   node scripts/compare-generate.mjs --label before [--briefs 0,1,2] [--repeat 1]
//                                     [--no-briefing] [--preset digital-agency] [--user probe-compare] [--yes]
//
// COSTS MONEY. Each generation is a full Haiku `checked` run: about 17-20万
// tokens, roughly 0.5 USD (measured 2026-09-14: 6 runs 3.2 USD, 3 runs 1.4 USD).
// Without --yes it prints what it would run and the estimate, and stops.
//
// Why a script and not the app: the deployed app cannot be logged into from an
// automated session, so comparisons invoke the Runtime directly — the same entry
// point the API Lambda dispatches to. The job record is created here the way the
// Lambda creates it, the Runtime session is pinged so it is not reclaimed, and
// the finished job is written to disk for `compare-report.mjs` to read.
//
// The fixed briefs are the three used for the 2026-09-14 baseline, so a new run
// is comparable with those. Each states checkable requirements (a quoted string
// with a place, a key, an absent word, named screens) and one behaviour.
//
// The user defaults to `probe-compare`, not a real account: the runs stay out of
// anyone's monthly usage, and `purge-probe-users.mjs` removes their rows and S3
// documents afterwards (non-uuid ids are what it treats as probes).
//
// --no-briefing sets `experiment.requirementBriefing: false`, which withholds the
// requirement checklist from the design phase and named screens from the build.
// Only a direct Runtime invocation can set it; the API strips the field.
import { createRequire } from 'node:module';
import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } = require('@aws-sdk/client-bedrock-agentcore');
const { DynamoDBClient, PutItemCommand, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { LambdaClient, GetFunctionConfigurationCommand } = require('@aws-sdk/client-lambda');

const REGION = process.env.AWS_REGION || 'ap-northeast-1';
const TABLE = process.env.USAGE_TABLE_NAME || 'makeui-token-usage';
const USD_PER_RUN = 0.5;

export const BRIEFS = [
  '会議室予約アプリを作ってください。画面は「会議室一覧」「予約フォーム」「予約確認」「マイ予約」の4つです。' +
    'フッターに「総務部 内線 1234」と表示してください。満室の部屋には「満室」と表示し、その部屋の予約ボタンは押せないようにします。' +
    '予約を確定すると、ヘッダーに表示しているマイ予約の件数がすぐに増えます。モーダルは Esc キーで閉じられるようにしてください。' +
    '「革新的」という言葉は使わないでください。',
  '小売店向けの在庫管理ツールを作ってください。画面は「ダッシュボード」「商品一覧」「商品詳細」「入荷登録」「設定」です。' +
    '在庫が10個以下の商品には「要発注」と表示します。商品一覧では / キーで検索欄にフォーカスします。' +
    '入荷を登録すると、商品一覧の在庫数が増えます。検索結果が0件のときは「該当する商品がありません」と表示してください。',
  '語学学習のフラッシュカードアプリを作ってください。画面は「デッキ一覧」「学習」「結果」「デッキ編集」です。' +
    '学習画面ではスペースキーでカードを裏返し、左右の矢印キーで前後のカードに移動します。' +
    'すべてのカードを終えると、結果画面に「お疲れさまでした」と正答率を表示します。' +
    'デッキが1つもないときは「デッキを作成しましょう」と表示してください。',
];

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const flag = (name) => process.argv.includes(`--${name}`);

const label = arg('label');
if (!label || !/^[a-z0-9-]+$/.test(label)) {
  console.error('--label is required (lowercase letters, digits and hyphens): it prefixes the job ids compare-report.mjs groups by');
  process.exit(2);
}
const briefs = arg('briefs', '0,1,2').split(',').map(Number);
if (briefs.some((b) => !(b in BRIEFS))) {
  console.error(`--briefs takes indices 0-${BRIEFS.length - 1}`);
  process.exit(2);
}
const repeat = Number(arg('repeat', '1'));
const user = arg('user', 'probe-compare');
// The design preset to bind, as the composer would send it. Absent leaves it to the pipeline's
// default, which is digital-agency (getPresetConfig) — the 2026-09-14 baseline ran on that.
const preset = arg('preset');
const outDir = arg('out', path.join(os.tmpdir(), 'makeui-compare'));
const runs = briefs.length * repeat;

console.log(`label ${label}: briefs ${briefs.join(',')} x ${repeat} = ${runs} Haiku checked generation(s), user ${user}${preset ? `, preset ${preset}` : ''}${flag('no-briefing') ? ', requirement briefing withheld' : ''}`);
console.log(`estimated cost: about ${(runs * USD_PER_RUN).toFixed(1)} USD. Results: ${outDir}`);
if (!flag('yes')) {
  console.log('Not run. Add --yes to spend it.');
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
const lambda = new LambdaClient({ region: REGION });
const ARN = (await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: 'makeui-backend' }))).Environment?.Variables?.AGENT_RUNTIME_ARN;
if (!ARN) throw new Error('AGENT_RUNTIME_ARN is not set on makeui-backend');

const ac = new BedrockAgentCoreClient({ region: REGION });
const ddb = new DynamoDBClient({ region: REGION });
// The Lambda's own rule, so a session id here is one the Runtime would accept from it.
const sessionIdFor = (id) => (id.length >= 33 ? id : `${id}-makeui-session-padding-0000000000`.slice(0, 40));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => { const line = `${new Date().toISOString()} ${m}`; console.log(line); appendFileSync(path.join(outDir, 'run.log'), line + '\n'); };

async function invoke(jobId, payload) {
  const res = await ac.send(new InvokeAgentRuntimeCommand({
    agentRuntimeArn: ARN, runtimeSessionId: sessionIdFor(jobId),
    contentType: 'application/json', accept: 'application/json',
    payload: new TextEncoder().encode(JSON.stringify(payload)),
  }));
  return { status: res.statusCode, body: res.response ? await res.response.transformToString() : '' };
}

async function runOne(i) {
  const jobId = `${label}-b${i}-${Date.now()}`;
  const now = new Date().toISOString();
  await ddb.send(new PutItemCommand({ TableName: TABLE, Item: {
    pk: { S: `JOB#${jobId}` }, sk: { S: 'META' }, userId: { S: user }, status: { S: 'pending' },
    createdAt: { S: now }, updatedAt: { S: now }, ttl: { N: String(Math.floor(Date.now() / 1000) + 3600) },
  } }));
  const payload = { jobId, userId: user, jobType: 'generate', input: {
    prompt: BRIEFS[i], model: 'haiku', effort: 'checked', outputKind: 'react',
    ...(preset ? { preset } : {}),
    ...(flag('no-briefing') ? { experiment: { requirementBriefing: false } } : {}),
  } };
  const r = await invoke(jobId, payload);
  log(`${jobId} dispatched ${r.status}`);
  const t0 = Date.now();
  let lastPing = Date.now();
  while (Date.now() - t0 < 40 * 60_000) {
    await sleep(15_000);
    // The Lambda pings every two minutes for the same reason: an idle session is reclaimed.
    if (Date.now() - lastPing > 110_000) {
      lastPing = Date.now();
      try { await invoke(jobId, { ping: true }); } catch (e) { log(`${jobId} ping failed ${e}`); }
    }
    const g = await ddb.send(new GetItemCommand({ TableName: TABLE, Key: { pk: { S: `JOB#${jobId}` }, sk: { S: 'META' } } }));
    const st = g.Item?.status?.S;
    if (st === 'completed' || st === 'failed') {
      writeFileSync(path.join(outDir, `job-${jobId}.json`), JSON.stringify({
        status: st, error: g.Item?.errorMsg?.S, seconds: Math.round((Date.now() - t0) / 1000),
        result: g.Item?.resultJson?.S ? JSON.parse(g.Item.resultJson.S) : null,
      }, null, 1));
      log(`${jobId} ${st} in ${Math.round((Date.now() - t0) / 1000)}s`);
      return;
    }
  }
  log(`${jobId} TIMED OUT waiting`);
}

// Three at a time at most, 20s apart, so design graphs do not hit the throughput quota together.
const queue = [];
for (let r = 0; r < repeat; r += 1) for (const b of briefs) queue.push(b);
for (let i = 0; i < queue.length; i += 3) {
  await Promise.all(queue.slice(i, i + 3).map((b, k) => sleep(k * 20_000).then(() => runOne(b))));
}
log(`label ${label} done. Next: node scripts/compare-report.mjs ${label} --out "${outDir}"`);
