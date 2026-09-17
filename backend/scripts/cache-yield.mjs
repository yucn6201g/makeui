// Does a prompt-cache breakpoint pay for itself?
//
// A write bills at about 1.25x and a read at about 0.1x, so a breakpoint is a
// loss until the same bytes come back often enough — break-even is a hit rate
// near 28%.
//
// The trap this exists for: `cacheRead` is billed to the READER. A stage can
// show write>0 and read=0 and still be the reason three other stages are cheap.
// Measured 2026-09-05: `design:layout-architect` wrote 41,125 and read nothing,
// and the three specialists after it read 340,329 — that write pays. In the same
// data `build:single-call` wrote 149,831 and nothing anywhere read it, because
// it is one call per run and an entry does not survive to the next generation.
// Its breakpoint was removed; the design graph's were kept.
//
// So read the per-RUN totals first, then the per-stage rows.
//
// Costs nothing; reads CloudWatch.
//
//   node scripts/cache-yield.mjs      (from backend/)
import { runtimeLogGroup } from './lib/aws-env.mjs';
import { execFileSync } from 'node:child_process';
const G=runtimeLogGroup();
const out=[];let token;
do{const a=['logs','filter-log-events','--region','ap-northeast-1','--log-group-name',G,
 '--filter-pattern','"Token ledger"','--start-time',String(Date.now()-60*86400000),
 '--query','{events: events[].{m: message, t: timestamp}, next: nextToken}','--output','json'];
 if(token)a.push('--next-token',token);
 const r=JSON.parse(execFileSync('aws',a,{encoding:'utf8',maxBuffer:1<<28}));
 for(const e of r.events??[]){try{const j=JSON.parse(e.m);j._t=e.t;out.push(j);}catch{}}
 token=r.next;}while(token);
const gens=out.filter(r=>r.run==='runGeneration'&&Array.isArray(r.stages));

console.log(`${gens.length} generation ledgers\n`);
// Per run: total written vs total read. If a run writes and never reads, the
// whole write was wasted whatever stage did it.
let wRuns=0, wasted=0, paid=0;
for(const r of gens){
  const w=r.cacheWrite??0, rd=r.cacheRead??0;
  if(w>0){wRuns++; if(rd===0) wasted+=w; else paid+=w;}
}
console.log(`runs that wrote a cache: ${wRuns}`);
console.log(`  written in runs that NEVER read one : ${wasted.toLocaleString()}`);
console.log(`  written in runs that did read       : ${paid.toLocaleString()}`);

// And within a run, does the assembler's own write ever come back?
console.log('\nper stage: does any run show this stage reading?');
const agg=new Map();
for(const r of gens) for(const s of r.stages){
  const e=agg.get(s.stage) ?? {w:0,rd:0,runsWithRead:0,n:0};
  e.w+=s.cacheWrite||0; e.rd+=s.cacheRead||0; e.n++;
  if((s.cacheRead||0)>0) e.runsWithRead++;
  agg.set(s.stage,e);
}
for(const [st,e] of [...agg].sort((a,b)=>b[1].w-a[1].w)){
  if(e.w===0&&e.rd===0) continue;
  console.log(`  ${st.padEnd(28)} write ${String(e.w).padStart(8)}  read ${String(e.rd).padStart(8)}  runs-with-read ${e.runsWithRead}/${e.n}`);
}
