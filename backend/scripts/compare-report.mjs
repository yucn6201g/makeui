// Reads the runs `compare-generate.mjs` finished, with their logs. No model calls.
//
//   node scripts/compare-report.mjs <label> [<label> ...] [--out <dir>]
//
// One table row per run and one mean per label, so two labels read side by side:
// score, requirements (met / checkable, + unverifiable), open findings, tokens
// in and out, output by stage (repair, build, design), repair passes accepted
// and why the rest were rejected, and the patch-form repairs.
//
// Read as a comparison of means over few runs. The score moves about 11 points
// on an identical input (project_score_noise_floor), so a difference smaller than
// that between 3-run means is not a finding.
//
// The token ledger log carries no requestId, so a run's ledger is the one logged
// within five seconds of its `Token usage: generateUI` line, which does.
import { runtimeLogGroup } from './lib/aws-env.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GROUP = runtimeLogGroup();
const outIdx = process.argv.indexOf('--out');
const outDir = outIdx === -1 ? path.join(os.tmpdir(), 'makeui-compare') : process.argv[outIdx + 1];
const labels = process.argv.slice(2).filter((a, i, all) => a !== '--out' && all[i - 1] !== '--out');
if (labels.length === 0) {
  console.error('usage: node scripts/compare-report.mjs <label> [<label> ...] [--out <dir>]');
  process.exit(2);
}

const jobs = fs.readdirSync(outDir)
  .filter((f) => f.startsWith('job-') && f.endsWith('.json') && labels.some((l) => f.startsWith(`job-${l}-b`)))
  .map((f) => ({ id: f.slice(4, -5), ...JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8')) }));
if (jobs.length === 0) {
  console.error(`no finished runs for ${labels.join(', ')} in ${outDir}`);
  process.exit(1);
}
const since = Math.min(...jobs.map((j) => Number(j.id.split('-').pop()))) - 60_000;

function fetchAll(message) {
  const out = [];
  let token;
  do {
    const args = ['logs', 'filter-log-events', '--region', 'ap-northeast-1', '--log-group-name', GROUP,
      '--filter-pattern', `"${message}"`, '--start-time', String(since),
      '--query', '{events: events[].message, next: nextToken}', '--output', 'json'];
    if (token) args.push('--next-token', token);
    const r = JSON.parse(execFileSync('aws', args, { encoding: 'utf8', maxBuffer: 1 << 28 }));
    for (const m of r.events ?? []) { try { out.push(JSON.parse(m)); } catch { /* not ours */ } }
    token = r.next;
  } while (token);
  return out;
}

const ledgers = fetchAll('Token ledger').filter((l) => l.run === 'runGeneration');
const usage = fetchAll('Token usage: generateUI');
const accepted = fetchAll('Interaction repair accepted');
const rejected = fetchAll('Interaction repair rejected');
const sizes = fetchAll('File repair change size');
const patchMisses = fetchAll('File repair patch did not apply');

const rows = [];
for (const j of jobs.sort((a, b) => a.id.localeCompare(b.id))) {
  const m = j.result?.metadata ?? {};
  const rid = /\/([0-9a-f-]{36})\.html$/.exec(m.outputKey ?? '')?.[1];
  const u = usage.find((x) => x.requestId === rid);
  const led = u && ledgers.find((l) => Math.abs(Date.parse(l.timestamp) - Date.parse(u.timestamp)) < 5000);
  const out = (prefix) => (led?.stages ?? []).filter((s) => s.stage.startsWith(prefix)).reduce((a, s) => a + (s.out || 0), 0);
  const req = m.requirements;
  rows.push({
    label: labels.find((l) => j.id.startsWith(`${l}-b`)),
    run: j.id.replace(/-\d+$/, ''),
    status: j.status,
    sec: j.seconds,
    score: j.result?.qualityScore,
    req: req ? `${req.met}/${req.total - req.unverified}+${req.unverified}?` : '-',
    open: m.openFindings,
    tokens: led?.total,
    out: led?.output,
    repairOut: out('repair:per-file'),
    buildOut: out('build'),
    designOut: out('design'),
    accepted: accepted.filter((a) => a.requestId === rid).length,
    rejected: rejected.filter((a) => a.requestId === rid).map((r) => r.reason.split(':')[0]).join(', '),
  });
}
console.table(rows);

for (const l of labels) {
  const rs = rows.filter((r) => r.label === l);
  const mean = (k) => Math.round(rs.reduce((a, r) => a + (Number(r[k]) || 0), 0) / Math.max(rs.length, 1));
  console.log(`${l} (${rs.length} runs) mean:`, { sec: mean('sec'), score: mean('score'), open: mean('open'), tokens: mean('tokens'), out: mean('out'), repairOut: mean('repairOut'), buildOut: mean('buildOut'), designOut: mean('designOut'), accepted: mean('accepted') });
}

// The patch form is logged per file, not per request, so it is read over the whole window.
const patched = sizes.filter((s) => s.format === 'patch');
console.log(`\nrepaired files in the window: ${sizes.length}, as patches: ${patched.length}, patches that did not apply: ${patchMisses.length}`);
if (patched.length) {
  const share = patched.reduce((a, s) => a + s.replyChars, 0) / Math.max(1, patched.reduce((a, s) => a + s.outChars, 0));
  console.log(`patch replies were ${Math.round(share * 100)}% of the whole files they changed`);
}
