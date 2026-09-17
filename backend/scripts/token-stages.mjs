// Where a run's tokens actually go, per stage, for generation and for edits.
//
// `logLedger` already records this per run; this adds them up. Every proposal to
// spend less has to start here, because the shares are not what anyone guesses:
// measured 2026-09-05 over 34 generations and 6 edits,
//
//   generation  270,164 tokens / 39 calls
//     repair:per-file      92,472  34%   28.3 calls
//     build:single-call    69,642  26%    1.0 call
//     design (5 agents)    60,111  22%    4.4 calls
//
//   edit         57,022 tokens / 5 calls
//     meta:rewrite:stream  38,507  68%    0.5 calls  (~77k each time it fires)
//     meta:invokeText      15,709  28%    3.8 calls  (~4k each)
//
// The two numbers that decide most proposals are in there: a per-file repair
// call sends the FILE ITSELF, so nothing is shared between calls and no cache
// can help it — the only lever is how many calls there are. And a full rewrite
// costs about nineteen per-file edits, so every fallback to it is expensive.
//
// Costs nothing; reads CloudWatch.
//
//   node scripts/token-stages.mjs      (from backend/)
import { runtimeLogGroup } from './lib/aws-env.mjs';
import { execFileSync } from 'node:child_process';
const G=runtimeLogGroup();
const q=(p)=>{const out=[];let token;
 do{const a=['logs','filter-log-events','--region','ap-northeast-1','--log-group-name',G,
   '--filter-pattern',`"${p}"`,'--start-time',String(Date.now()-60*86400000),
   '--query','{events: events[].{m: message, t: timestamp}, next: nextToken}','--output','json'];
  if(token)a.push('--next-token',token);
  const r=JSON.parse(execFileSync('aws',a,{encoding:'utf8',maxBuffer:1<<28}));
  for(const e of r.events??[]){try{const j=JSON.parse(e.m);j._t=e.t;out.push(j);}catch{}}
  token=r.next;}while(token);
 return out.sort((a,b)=>a._t-b._t);};

const ledgers=q('Token ledger').filter(r=>Array.isArray(r.stages)&&r.stages.length);
const kinds=new Map();
for(const r of ledgers) kinds.set(r.run, (kinds.get(r.run)??0)+1);
console.log('run kinds:',[...kinds].map(([k,v])=>`${k}=${v}`).join(', '));

function report(name, rows){
  if(!rows.length){console.log(`\n${name}: none`);return;}
  const agg=new Map(); let total=0, runs=rows.length, calls=0;
  for(const r of rows){
    total += r.total ?? 0; calls += r.calls ?? 0;
    for(const s of r.stages){
      const e=agg.get(s.stage) ?? {in:0,out:0,calls:0,cr:0,cw:0};
      e.in+=s.in||0; e.out+=s.out||0; e.calls+=s.calls||0; e.cr+=s.cacheRead||0; e.cw+=s.cacheWrite||0;
      agg.set(s.stage,e);
    }
  }
  console.log(`\n=== ${name} — ${runs} runs, mean ${Math.round(total/runs).toLocaleString()} tokens, ${Math.round(calls/runs)} calls ===`);
  console.log('  stage'.padEnd(30)+'per run'.padStart(10)+'in'.padStart(10)+'out'.padStart(10)+'calls'.padStart(7)+'   share   cache');
  const sorted=[...agg].sort((a,b)=>(b[1].in+b[1].out)-(a[1].in+a[1].out));
  for(const [stage,e] of sorted){
    const t=e.in+e.out; if(t/runs<300) continue;
    console.log('  '+stage.padEnd(28)+
      Math.round(t/runs).toLocaleString().padStart(10)+
      Math.round(e.in/runs).toLocaleString().padStart(10)+
      Math.round(e.out/runs).toLocaleString().padStart(10)+
      (e.calls/runs).toFixed(1).padStart(7)+
      `  ${(t/total*100).toFixed(1)}%`.padStart(8)+
      `   cacheR ${Math.round(e.cr/runs).toLocaleString()} / cacheW ${Math.round(e.cw/runs).toLocaleString()}`);
  }
}
for(const [k] of [...kinds].sort((a,b)=>b[1]-a[1])) report(k, ledgers.filter(r=>r.run===k));
