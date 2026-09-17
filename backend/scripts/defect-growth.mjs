// "The repair was accepted and the defect count went UP." Is the run getting
// worse, or is the number moving on its own?
//
// Two things make the total rise without anything getting worse. The accept rule
// (graph.ts) is convergentCount(after) < convergentCount(before), where
// convergent means "not visual-" — so the critic's re-sampled findings can move
// freely under an accepted pass. And `remaining` carries regression entries
// (`*-introduced`) that are deliberately not carried forward.
//
// Measured 2026-09-04 over 45 days: 12 of 181 accepted passes ended with a
// higher total, and all 12 are covered by visual- re-samples alone. The set the
// next pass is actually handed shrank in 136, held in 17, and grew in 5 — and
// every one of those 5 had blank-render or layout-broken in front of it, so what
// it gained were defects that were always there behind a page that did not
// render.
//
// Costs nothing; reads CloudWatch.
//
//   node scripts/defect-growth.mjs      (from backend/)
import { runtimeLogGroup } from './lib/aws-env.mjs';
import { execFileSync } from 'node:child_process';
const G = runtimeLogGroup();
const q = (p) => {
  const out = []; let token;
  do {
    const a = ['logs','filter-log-events','--region','ap-northeast-1','--log-group-name',G,
      '--filter-pattern',`"${p}"`,'--start-time',String(Date.now()-45*86400000),
      '--query','{events: events[].message, next: nextToken}','--output','json'];
    if (token) a.push('--next-token', token);
    const r = JSON.parse(execFileSync('aws', a, {encoding:'utf8', maxBuffer:1<<28}));
    for (const m of r.events ?? []) { try { out.push(JSON.parse(m)); } catch {} }
    token = r.next;
  } while (token);
  return out;
};

const given = new Map();
for (const r of q('Quality defects detected'))
  if (r.requestId && r.pass != null) given.set(`${r.requestId}#${r.pass}`, (r.defects ?? []).map(String));

const acc = q('Interaction repair accepted').filter((r) => r.requestId && r.pass != null && r.remaining);
const isVisual = (id) => id.startsWith('visual-');
const isRegression = (id) => id.endsWith('-introduced');

let grew = 0, growVisualOnly = 0, growRegressionOnly = 0, growReal = 0;
const realRows = [];
for (const r of acc) {
  const d = r.after - r.before;
  if (d <= 0) continue;
  grew += 1;
  const conv = r.remaining.filter((id) => !isVisual(id));
  const carried = conv.filter((id) => !isRegression(id));
  // The rise cannot be convergent-and-carried, or the pass would not have been
  // accepted — unless convergentBefore was 0. Show what the rise is made of.
  const vis = r.remaining.length - conv.length;
  const reg = conv.length - carried.length;
  if (vis >= d) growVisualOnly += 1;
  else if (vis + reg >= d) growRegressionOnly += 1;
  else { growReal += 1; realRows.push(r); }
}
console.log(`${acc.length} accepted passes`);
console.log(`  total count rose: ${grew}`);
console.log(`    rise covered by visual- re-samples alone : ${growVisualOnly}`);
console.log(`    rise needing regression entries too      : ${growRegressionOnly}`);
console.log(`    rise not explained by either             : ${growReal}`);
for (const r of realRows) console.log(`      ${r.requestId} pass ${r.pass}: ${r.before}->${r.after}  [${r.remaining.join(', ')}]`);

// And the decisive one: the set the NEXT pass is handed.
let up = 0, down = 0, flat = 0; const ups = [];
for (const r of acc) {
  const next = given.get(`${r.requestId}#${r.pass + 1}`);
  const now = given.get(`${r.requestId}#${r.pass}`);
  if (!next || !now) continue;
  if (next.length > now.length) { up += 1; ups.push(`${r.requestId} pass ${r.pass}: ${now.length}->${next.length}  gained [${next.filter((x)=>!now.includes(x)).join(', ')}]`); }
  else if (next.length < now.length) down += 1; else flat += 1;
}
console.log(`\nafter an accepted pass, the set handed to the next pass:`);
console.log(`  smaller: ${down}   same: ${flat}   larger: ${up}`);
for (const s of ups) console.log('    ' + s);
