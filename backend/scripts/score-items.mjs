// Which rubric items actually do any work?
//
// The project rubric is 176 possible points spread over 39 checks. Before asking
// how much a score varies between runs, ask which of its terms vary at all: a
// check every document passes and a check no document can pass carry the same
// amount of information, which is none — and the second is exactly how the
// `data-file` break hid while the number kept looking like a number.
//
// Costs nothing. It scores documents already sitting in S3; no model calls.
//
//   node scripts/score-items.mjs [n]      (from backend/, default 60 documents)
//
// How the per-check numbers are obtained: `Rubric.award` is called from ~40
// places and none of them carry a name, so the call SITE is the name. The bundle
// is built with an inline source map, `award`/`partial`/`deduct` get one probe
// line each, and Node's --enable-source-maps turns the stack frame back into a
// scoring.ts line. Nothing under src/ is touched, so this cannot drift from what
// production scores — it runs the same code.
import { outputsBucket } from './lib/aws-env.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.execArgv.includes('--enable-source-maps')) {
  // Re-exec rather than print instructions: without the flag every frame points
  // into the bundle, every check reports as the same site, and that looks like
  // an answer.
  execFileSync(process.execPath, ['--enable-source-maps', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit' });
  process.exit(0);
}

const BUCKET = outputsBucket();
const REGION = 'ap-northeast-1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const want = Number(process.argv[2] ?? 60);

// --- an instrumented copy of the real scorer ---------------------------------------
const entry = path.join(root, 'dist/item-entry.ts');
fs.mkdirSync(path.dirname(entry), { recursive: true });
fs.writeFileSync(entry, "export { scoreHtml } from '../src/orchestration/scoring.js';\n");
// esbuild's own entry script under node, rather than `npx` through a shell:
// passing an argument array through a shell concatenates instead of escaping
// (Node deprecates it for that reason), and spawning `npx.cmd` without one is
// EINVAL on Windows.
execFileSync(process.execPath, [path.join(root, 'node_modules/esbuild/bin/esbuild'), entry, '--bundle', '--platform=node', '--format=esm', '--sourcemap=inline',
  `--outfile=${path.join(root, 'dist/item.mjs')}`, '--external:@aws-sdk/*', '--external:@smithy/*', '--external:@strands-agents/*'],
  { stdio: 'pipe', cwd: root });

const bundle = path.join(root, 'dist/item.mjs');
const probe = 'globalThis.__ITEM__ && globalThis.__ITEM__(new Error().stack, arguments);';
let js = fs.readFileSync(bundle, 'utf8');
let probed = 0;
js = js.replace(/(award\(hit, weight\) \{|partial\(got, weight\) \{|deduct\(points\) \{|gate\(hit, weight\) \{)/g,
  (m) => { probed += 1; return `${m}\n${probe}`; });
if (probed !== 4) {
  console.error(`expected to probe 4 methods, probed ${probed} — Rubric's signatures moved`);
  process.exit(1);
}
fs.writeFileSync(bundle, js);
const { scoreHtml } = await import(pathToFileURL(bundle).href);

// --- a sample of real output --------------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'score-items-'));
const listing = execFileSync('aws', ['s3', 'ls', `s3://${BUCKET}/outputs/`, '--region', REGION, '--recursive'],
  { encoding: 'utf8', maxBuffer: 1 << 26 });
const keys = listing.split(/\r?\n/)
  .map((l) => l.trim().split(/\s+/))
  .filter((p) => p.length === 4 && Number(p[2]) > 40_000)   // a truncated run is not a sample
  .map((p) => p[3]);
// Newest first: the rubric describes today's pipeline, and a good part of this
// bucket predates the project format entirely.
const sample = keys.reverse().slice(0, want);
/*
 * Each document is scored against the preset it was BUILT for, read off the S3
 * object's own metadata.
 *
 * Passing no preset was a 20-point hole in this table. `none` has a signature —
 * it is the most-used option and the one where machine-made defaults creep back
 * — so `presetConformance` runs on every real generation and contributes 20 of
 * the contract half's 97 possible points. With `undefined` the check never ran
 * here, the table reported 77 possible instead of 97, and a whole term went
 * unmeasured while looking like it had been.
 */
const presets = [];
for (const [i, k] of sample.entries()) {
  execFileSync('aws', ['s3', 'cp', `s3://${BUCKET}/${k}`, path.join(dir, `d${i}.html`), '--region', REGION, '--quiet']);
  const meta = JSON.parse(execFileSync('aws', ['s3api', 'head-object', '--bucket', BUCKET, '--key', k,
    '--region', REGION, '--query', 'Metadata', '--output', 'json'], { encoding: 'utf8' }));
  presets.push(meta.preset || 'none');
}

// --- score them, recording every check ------------------------------------------------
let cur = null;
let sawGate = 0;
globalThis.__ITEM__ = (stack, args) => {
  if (!cur) return;
  const frames = String(stack).split('\n');
  const at = /scoring\.ts:(\d+)/.exec(frames[2] ?? '');
  if (!at) return;
  // A gate takes (hit, weight) exactly like an award but pays into the penalty,
  // so the two cannot be told apart by their arguments. V8 names the method in
  // the frame above the call site, which is the only place that says which.
  const method = /Rubric\.(\w+)/.exec(frames[1] ?? '');
  if (method && method[1] === 'gate') sawGate += 1;
  cur.push({ site: Number(at[1]), a: args[0], w: args[1], gate: method?.[1] === 'gate' });
};
const framework = (d) =>
  (/@@@makeui:file [^\n]*\.svelte/.test(d) ? 'svelte' : /@@@makeui:file [^\n]*\.vue/.test(d) ? 'vue' : 'react');

const docs = [];
for (const f of fs.readdirSync(dir)) {
  const doc = fs.readFileSync(path.join(dir, f), 'utf8');
  const preset = presets[Number(/d(\d+)\.html/.exec(f)?.[1] ?? -1)] ?? 'none';
  cur = [];
  let total;
  try { total = scoreHtml(doc, preset, framework(doc)); } catch { cur = null; continue; }
  docs.push({ total, calls: cur });
  cur = null;
}
fs.rmSync(dir, { recursive: true, force: true });
// A gate that never reports is a gate counted as an award, and the bands below
// would then say nothing changed.
if (sawGate === 0) { console.error('no gate calls were seen — the probe is not telling them apart'); process.exit(1); }

/*
 * Two rubrics live in `scoreHtml`: a project document goes to `scoreProject`,
 * and anything else to a rubric for a single interactive page that rewards
 * <style> blocks and document length. Everything MakeUI produces now is the
 * first kind. Averaging them would fold a check that no longer runs into one
 * that runs every time, so the single-page documents are dropped, not mixed in.
 */
const PROJECT_RUBRIC_ENDS = 300;
const kept = docs.filter((d) => d.calls.some((c) => c.site < PROJECT_RUBRIC_ENDS));

const sites = new Map();
for (const d of kept) {
  for (const c of d.calls) {
    if (c.site >= PROJECT_RUBRIC_ENDS) continue;
    const r = sites.get(c.site) ?? { n: 0, got: 0, weight: 0, deduct: 0, gate: c.gate };
    r.n += 1;
    if (c.gate) { if (c.a !== true) r.deduct += c.w; }
    else if (c.w === undefined) r.deduct += c.a;
    else {
      r.weight += c.w;
      r.got += c.a === true ? c.w : c.a === false ? 0 : Math.max(0, Math.min(c.w, c.a));
    }
    sites.set(c.site, r);
  }
}

// V8 reports the line a call EXPRESSION starts on, which for a call spanning
// lines is not the line holding `r.award`. Search back a little rather than
// printing whatever text happens to sit there.
const src = fs.readFileSync(path.join(root, 'src/orchestration/scoring.ts'), 'utf8').split(/\r?\n/);
const nearest = (line) => {
  for (let i = line - 1; i >= Math.max(0, line - 5); i -= 1) {
    if (/r\.(award|partial|deduct|gate)\(/.test(src[i] ?? '')) return `${i + 1}: ${src[i].trim().slice(0, 72)}`;
  }
  return `${line}: ${(src[line - 1] ?? '').trim().slice(0, 68)}`;
};

const rows = [...sites].map(([line, r]) => ({
  gate: r.gate,
  rate: r.weight ? r.got / r.weight : null,
  weight: r.weight / Math.max(1, r.n),
  deduct: r.deduct,
  n: r.n,
  code: nearest(line),
})).sort((a, b) => (a.rate ?? 2) - (b.rate ?? 2));

console.log(`${docs.length} documents scored, ${kept.length} of them project documents\n`);
console.log('rate'.padStart(6) + 'wt'.padStart(6) + 'n'.padStart(5) + '  check');
for (const r of rows) {
  console.log((r.rate === null ? `-${r.deduct}` : `${Math.round(r.rate * 100)}%`).padStart(6) +
    r.weight.toFixed(1).padStart(6) + String(r.n).padStart(5) + (r.gate ? '  gate ' : '  ') + r.code);
}

const aw = rows.filter((r) => r.rate !== null);
const pts = (rs) => rs.reduce((a, r) => a + r.weight, 0);
const band = (lo, hi) => aw.filter((r) => r.rate >= lo && r.rate <= hi);
console.log(`\n${pts(aw).toFixed(0)} possible points over ${aw.length} checks`);
for (const [name, rs] of [
  ['never move (95-100%)', band(0.95, 1)],
  ['barely move (85-95%)', band(0.85, 0.9499)],
  ['discriminate (<85%)', band(0, 0.8499)],
]) {
  console.log(`  ${name.padEnd(22)} ${String(rs.length).padStart(2)} checks ${pts(rs).toFixed(0).padStart(4)} pts  ` +
    `${((pts(rs) / pts(aw)) * 100).toFixed(0)}%`);
}

// And where the spread comes from. Before the gates, the earned ratio was
// compressed from below by the 99 points of checks that never moved (59-96%, sd
// 6.9) and the penalty did most of the work; the two numbers below are how that
// stands now.
const per = kept.map((d) => {
  let e = 0, p = 0, w = 0;
  for (const c of d.calls) {
    if (c.site >= PROJECT_RUBRIC_ENDS) continue;
    if (c.gate) { if (c.a !== true) p += c.w; }
    else if (c.w === undefined) p += c.a;
    else {
      w += c.w;
      e += c.a === true ? c.w : c.a === false ? 0 : Math.max(0, Math.min(c.w, c.a));
    }
  }
  return { pct: (e / w) * 100, p, t: d.total };
});
const sd = (xs) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};
const col = (xs) => `${Math.min(...xs).toFixed(0)}-${Math.max(...xs).toFixed(0)} (sd ${sd(xs).toFixed(1)})`;
console.log(`\nearned ratio ${col(per.map((r) => r.pct))}%`);
console.log(`penalty      ${col(per.map((r) => r.p))} — failed gates and demerits, not part of possible`);
console.log(`total        ${col(per.map((r) => r.t))}`);
// The floor is part of the scale: every document that reaches it is a document
// the number can no longer tell apart from another.
const atFloor = per.filter((r) => r.t === 30).length;
console.log(`at the floor ${atFloor} of ${per.length}`);
console.log(`totals       ${per.map((r) => r.t).sort((a, b) => a - b).join(' ')}`);
