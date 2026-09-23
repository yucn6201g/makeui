// Passes whose every attempted defect is one the judge cannot count.
//
// The judge decides on convergent findings — everything but the critic's
// `visual-*` — whenever the document has any. A pass that attempts only critic
// findings on such a document can only be accepted by a convergent defect it was
// never asked about going away. This counts how often that happens, and what
// those passes are accepted at against every other pass.
//
//   node scripts/visual-only-passes.mjs [days]      (from backend/, default 30)
//
// Message and field names copied from graph.ts:
//   'Quality defects detected'       requestId, pass, defects   (the attempted ids)
//   'Interaction repair accepted'    requestId, pass
//   'Interaction repair rejected'    requestId, pass, reason, convergentBefore
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
      'logs', 'filter-log-events',
      '--region', REGION,
      '--log-group-name', GROUP,
      '--filter-pattern', `"${pattern}"`,
      '--start-time', String(Date.now() - days * 86400_000),
      '--query', '{events: events[].message, next: nextToken}',
      '--output', 'json',
    ];
    if (token) args.push('--next-token', token);
    const res = JSON.parse(execFileSync('aws', args, { encoding: 'utf8', maxBuffer: 1 << 28 }));
    for (const m of res.events ?? []) {
      try { out.push(JSON.parse(m)); } catch { /* not one of ours */ }
    }
    token = res.next;
  } while (token);
  return out;
}

const key = (r) => `${r.requestId}#${r.pass}`;
const attempted = new Map();
for (const r of fetchAll('Quality defects detected')) {
  if (r.requestId && r.pass != null) attempted.set(key(r), (r.defects ?? []).map(String));
}
const accepted = new Set(fetchAll('Interaction repair accepted').map(key));
const rejected = new Map();
for (const r of fetchAll('Interaction repair rejected')) {
  if (!rejected.has(key(r))) rejected.set(key(r), r);
}

const groups = { 'visual only': [], 'mixed': [], 'no visual': [] };
for (const [k, ids] of attempted) {
  if (!accepted.has(k) && !rejected.has(k)) continue;
  const visual = ids.filter((id) => id.startsWith('visual-')).length;
  const g = visual === ids.length ? 'visual only' : visual === 0 ? 'no visual' : 'mixed';
  groups[g].push({ k, ids, ok: accepted.has(k), rej: rejected.get(k) });
}

for (const [g, rows] of Object.entries(groups)) {
  const ok = rows.filter((r) => r.ok).length;
  const pass1 = rows.filter((r) => r.k.endsWith('#1'));
  console.log(`${g.padEnd(12)} passes ${String(rows.length).padStart(4)}  accepted ${String(ok).padStart(4)}  ${rows.length ? Math.round((ok / rows.length) * 100) : 0}%   (pass 1: ${pass1.length}, later: ${rows.length - pass1.length})`);
}
console.log('\nvisual-only passes, one per line:');
for (const r of groups['visual only']) {
  console.log(`  ${r.k.split('#')[1]}  ${r.ok ? 'ACCEPTED' : 'rejected'}  convergentBefore=${r.rej?.convergentBefore ?? '-'}  ${r.rej?.reason ?? ''}  [${r.ids.join(', ')}]`);
}
