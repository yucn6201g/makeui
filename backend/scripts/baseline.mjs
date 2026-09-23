// One row per generation, from the Runtime log: what it was asked, what it cost,
// what it scored and what it shipped still wrong. Then the eight questions the
// 2026-09-23 requirements ask, answered from those rows.
//
//   node scripts/baseline.mjs [days]      (from backend/, default 30)
//
// Every message and field name is copied from the source (graph.ts), not
// remembered — a query for a line nobody writes returns zero, and zero reads as
// "it never happened":
//
//   'Build effort'                 requestId, effort
//   'Pipeline starting'            requestId, preset
//   'Quality defects detected'     requestId, outputKind, pass, defects
//   'Shipping with open defects'   requestId, defects       (absent = none open)
//   'Pipeline completed'           requestId, score, duration
//   'Token ledger'                 requestId? run, total    (runGeneration)
//   'Browser verification failed'  requestId (only since 2026-09-23)
//
// Reads CloudWatch and costs nothing.
import { runtimeLogGroup } from './lib/aws-env.mjs';
import { execFileSync } from 'node:child_process';

const GROUP = runtimeLogGroup();
const REGION = 'ap-northeast-1';
const days = Number(process.argv[2] ?? 30);

function fetchAll(pattern) {
  const out = [];
  let token;
  do {
    const args = [
      'logs', 'filter-log-events', '--region', REGION, '--log-group-name', GROUP,
      '--filter-pattern', `"${pattern}"`,
      '--start-time', String(Date.now() - days * 86400_000),
      '--query', '{events: events[].message, next: nextToken}', '--output', 'json',
    ];
    if (token) args.push('--next-token', token);
    const res = JSON.parse(execFileSync('aws', args, { encoding: 'utf8', maxBuffer: 1 << 28 }));
    for (const m of res.events ?? []) { try { out.push(JSON.parse(m)); } catch { /* not ours */ } }
    token = res.next;
  } while (token);
  return out;
}

const runs = new Map();
const row = (id) => {
  if (!runs.has(id)) runs.set(id, { id, open: [] });
  return runs.get(id);
};

for (const r of fetchAll('Build effort')) if (r.requestId) row(r.requestId).effort = r.effort;
for (const r of fetchAll('Pipeline starting')) if (r.requestId) row(r.requestId).preset = r.preset;
for (const r of fetchAll('Quality defects detected')) {
  if (!r.requestId) continue;
  const x = row(r.requestId);
  x.kind = r.outputKind ?? x.kind;
  if (r.pass === 1) x.firstDefects = (r.defects ?? []).map(String);
}
for (const r of fetchAll('Shipping with open defects')) if (r.requestId) row(r.requestId).open = (r.defects ?? []).map(String);
for (const r of fetchAll('Pipeline completed')) if (r.requestId) { const x = row(r.requestId); x.score = r.score; x.done = true; }
for (const r of fetchAll('Token ledger')) if (r.requestId && r.run === 'runGeneration') row(r.requestId).tokens = r.total;

const done = [...runs.values()].filter((r) => r.done);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '-');
const tally = (rows, key) => {
  const t = new Map();
  for (const r of rows) for (const id of r[key] ?? []) t.set(id, (t.get(id) ?? 0) + 1);
  return [...t].sort((a, b) => b[1] - a[1]);
};

console.log(`${days} days — ${done.length} completed generations\n`);

// --- 3. unresolved findings at ship -------------------------------------------------
const clean = done.filter((r) => r.open.length === 0).length;
console.log('3. UNRESOLVED AT SHIP');
console.log(`   shipped with none open: ${clean}/${done.length} (${pct(clean, done.length)})   mean open: ${mean(done.map((r) => r.open.length)).toFixed(2)}`);
for (const [id, n] of tally(done, 'open').slice(0, 14)) console.log(`   ${String(n).padStart(4)}  ${pct(n, done.length).padStart(4)}  ${id}`);

// --- 4. shipped unable to display ---------------------------------------------------
const FATAL = ['blank-render', 'app-fallback', 'console-error', 'syntax-error', 'route-unrendered', 'page-frozen', 'import-missing', 'export-missing', 'component-unresolved'];
const fatal = done.filter((r) => r.open.some((id) => FATAL.includes(id)));
console.log('\n4. SHIPPED WITH A FINDING THAT CAN STOP IT DISPLAYING');
console.log(`   ${fatal.length}/${done.length} (${pct(fatal.length, done.length)})`);
for (const id of FATAL) {
  const n = done.filter((r) => r.open.includes(id)).length;
  if (n) console.log(`   ${String(n).padStart(4)}  ${id}`);
}

// --- 6. React vs Vue ------------------------------------------------------------------
console.log('\n6. REACT vs VUE (checked runs only, so the modes are comparable)');
for (const kind of ['react', 'vue']) {
  const rs = done.filter((r) => r.kind === kind && r.effort === 'checked');
  const scores = rs.map((r) => r.score).filter((s) => typeof s === 'number');
  console.log(`   ${kind.padEnd(6)} runs ${String(rs.length).padStart(3)}  score ${mean(scores).toFixed(1)}  open ${mean(rs.map((r) => r.open.length)).toFixed(2)}  clean ${pct(rs.filter((r) => r.open.length === 0).length, rs.length)}  tokens ${Math.round(mean(rs.map((r) => r.tokens).filter(Boolean)) || 0)}`);
  console.log(`          top open: ${tally(rs, 'open').slice(0, 6).map(([id, n]) => `${id} ${n}`).join(', ')}`);
}

// --- 7. presets -----------------------------------------------------------------------
console.log('\n7. PRESETS');
const PRESET_IDS = ['preset-drift', 'palette-size', 'default-palette', 'preset-composition', 'preset-scale'];
const byPreset = new Map();
for (const r of done) { const k = r.preset ?? '?'; if (!byPreset.has(k)) byPreset.set(k, []); byPreset.get(k).push(r); }
for (const [preset, rs] of [...byPreset].sort((a, b) => b[1].length - a[1].length)) {
  const scores = rs.map((r) => r.score).filter((s) => typeof s === 'number');
  const first = tally(rs, 'firstDefects').filter(([id]) => PRESET_IDS.some((p) => id.startsWith(p.split('-')[0]) || id === p));
  const shipped = tally(rs, 'open').filter(([id]) => PRESET_IDS.includes(id) || /^preset|palette/.test(id));
  console.log(`   ${preset.padEnd(16)} runs ${String(rs.length).padStart(3)}  score ${mean(scores).toFixed(1)}  preset findings at pass 1: ${first.map(([i, n]) => `${i} ${n}`).join(', ') || '-'}  at ship: ${shipped.map(([i, n]) => `${i} ${n}`).join(', ') || '-'}`);
}

// --- 1. tokens --------------------------------------------------------------------------
console.log('\n1. TOKENS PER GENERATION');
for (const effort of ['checked', 'draft']) {
  const rs = done.filter((r) => r.effort === effort && r.tokens);
  if (rs.length) console.log(`   ${effort.padEnd(8)} runs ${String(rs.length).padStart(3)}  mean ${Math.round(mean(rs.map((r) => r.tokens)))}  score ${mean(rs.map((r) => r.score).filter((s) => typeof s === 'number')).toFixed(1)}`);
}
