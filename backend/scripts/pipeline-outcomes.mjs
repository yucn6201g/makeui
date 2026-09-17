// What the 2026-09-13 changes are doing in production, read from the Runtime log.
//
//   node scripts/pipeline-outcomes.mjs [days]      (from backend/, default 7)
//
// Each section answers one question a change was made to settle, from the log
// lines that change writes. The message strings and field names are copied from
// the source, not remembered: a query for a message nobody logs returns zero,
// and zero reads as "it never happened".
//
//   requirements   do the build's missed requirements get fixed by a repair pass,
//                  how many requirements generations and edits meet
//   judge          accepted vs rejected and why, what the weighting and the
//                  pre-judge corrections changed, export-missing repairs
//   salvage        does reverting one file rescue a pass that broke the app
//   contrast       does the deterministic contrast fix close the defect now
//   re-walk        how often the shipped document is measured again
//   dead actions   how often the walk reports a dead in-screen button
//
// Shells out to the AWS CLI with an argument array and no shell, so the log
// group's leading slash survives Git Bash.
import { runtimeLogGroup } from './lib/aws-env.mjs';
import { execFileSync } from 'node:child_process';

const GROUP = runtimeLogGroup();
const days = Number(process.argv[2] ?? 7);
const since = Date.now() - days * 86400_000;

function fetchAll(message) {
  const out = [];
  let token;
  do {
    const args = [
      'logs', 'filter-log-events', '--region', 'ap-northeast-1', '--log-group-name', GROUP,
      '--filter-pattern', `"${message}"`, '--start-time', String(since),
      '--query', '{events: events[].message, next: nextToken}', '--output', 'json',
    ];
    if (token) args.push('--next-token', token);
    const res = JSON.parse(execFileSync('aws', args, { encoding: 'utf8', maxBuffer: 1 << 28 }));
    for (const m of res.events ?? []) {
      try {
        const j = JSON.parse(m);
        // The filter matches substrings; keep only the exact message.
        if (j.message === message) out.push(j);
      } catch { /* not one of ours */ }
    }
    token = res.next;
  } while (token);
  return out;
}

const pct = (n, d) => (d === 0 ? '—' : `${Math.round((n / d) * 100)}%`);
const line = (label, value) => console.log(`  ${label.padEnd(52)} ${value}`);

console.log(`${days} days\n`);
const runs = fetchAll('Pipeline starting').length;
console.log(`generations started: ${runs}\n`);

// --- requirements ----------------------------------------------------------------------
{
  console.log('requirements');
  const detected = fetchAll('Quality defects detected');
  const accepted = fetchAll('Interaction repair accepted');
  const withReq = detected.filter((d) => (d.defects ?? []).includes('requirement-unmet'));
  const acceptedByPass = new Map(accepted.map((a) => [`${a.requestId}#${a.pass}`, a]));
  const closed = withReq.filter((d) => {
    const a = acceptedByPass.get(`${d.requestId}#${d.pass}`);
    return a && !(a.remaining ?? []).includes('requirement-unmet');
  });
  line('repair passes handed requirement-unmet', withReq.length);
  line('  accepted with it no longer remaining', `${closed.length} (${pct(closed.length, withReq.length)})`);

  const generated = fetchAll('Requirements checked');
  const gsum = (k) => generated.reduce((a, e) => a + (e[k] ?? 0), 0);
  line('generations checked', generated.length);
  line('  checkable requirements met / total', `${gsum('met')} / ${gsum('total') - gsum('unverified')}`);
  line('  open findings shipped (median)', generated.length
    ? String([...generated.map((g) => g.openFindings ?? 0)].sort((a, b) => a - b)[Math.floor(generated.length / 2)])
    : '—');

  const edits = fetchAll('Edit requirements checked');
  const sum = (k) => edits.reduce((a, e) => a + (e[k] ?? 0), 0);
  line('edits checked', edits.length);
  line('  checkable requirements met / total', `${sum('met')} / ${sum('total') - sum('unverified')}`);
  line('  misses repaired before the reply', sum('repairedMisses'));
  line('  still unmet in the reply (of which misplaced)', `${sum('unmet')} (${sum('misplaced')})`);
  line('  edit repairs rejected for breaking the build',
    fetchAll('Edit quality repair rejected — the project no longer builds').length);
  console.log();
}

// --- the judge --------------------------------------------------------------------------
{
  console.log('repair judge');
  const accepted = fetchAll('Interaction repair accepted');
  const rejected = fetchAll('Interaction repair rejected');
  const weighed = accepted.filter((a) => typeof a.weightedAfter === 'number');
  // Accepted on weight while the plain count did not go down: what the weighting changed.
  const onWeight = weighed.filter((a) => a.after >= a.before);
  line('passes accepted / rejected', `${accepted.length} / ${rejected.length} (${pct(accepted.length, accepted.length + rejected.length)} accepted)`);
  line('  accepted only because findings are weighted', `${onWeight.length} of ${weighed.length} weighed`);
  const reasons = {};
  for (const r of rejected) {
    const key = String(r.reason ?? '?').replace(/: .*/, '');
    reasons[key] = (reasons[key] ?? 0) + 1;
  }
  line('  rejected by reason', Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join(', ') || '—');
  line('candidates corrected before judging (framework idioms)', fetchAll('Corrected a repair candidate before judging it').length);
  line('candidates recoloured before judging (contrast)', fetchAll('Fixed a repair candidate deterministically before judging it').length);
  line('candidates that broke the app, diagnosed / kept',
    `${fetchAll('A repair candidate broke the app').length} / ${fetchAll('Kept the rejected repair candidate').length}`);
  line('  failed to keep (check the S3 permission)', fetchAll('Could not keep the rejected repair candidate').length);

  const detected = fetchAll('Quality defects detected');
  const byPass = new Map(accepted.map((a) => [`${a.requestId}#${a.pass}`, a]));
  const handed = detected.filter((d) => (d.defects ?? []).includes('export-missing'));
  const closed = handed.filter((d) => {
    const a = byPass.get(`${d.requestId}#${d.pass}`);
    return a && !(a.remaining ?? []).includes('export-missing');
  });
  line('passes handed export-missing', handed.length);
  // The decision this line exists for: a shipped runtime failure the score does
  // not deduct for. Deduct (and raise SCORE_RUBRIC) only if this is not zero.
  const shipped = fetchAll('Shipping with open defects').filter((x) => (x.defects ?? []).includes('export-missing'));
  line('  generations that shipped with it still open', `${shipped.length} (score does not deduct for it — decide when not zero)`);
  line('  accepted with it no longer remaining', `${closed.length} (${pct(closed.length, handed.length)})`);
  console.log();
}

// --- salvage ---------------------------------------------------------------------------
{
  console.log('salvage of a pass that broke the app');
  const tries = fetchAll('Retrying the repair without one file');
  const accepted = fetchAll('Interaction repair accepted');
  const single = accepted.filter((a) => / reverted\)$/.test(a.kind ?? '') && !/routing reverted|uncompilable file reverted/.test(a.kind));
  const routing = accepted.filter((a) => /\(routing reverted\)$/.test(a.kind ?? ''));
  const passesTried = new Set(tries.map((t) => `${t.requestId}#${t.pass}`)).size;
  line('passes that tried single-file reverts', passesTried);
  line('  rescued by one', `${single.length} (${pct(single.length, passesTried)})`);
  line('passes rescued by the routing revert', routing.length);
  const dropped = [...fetchAll('Retrying the repair without the files that route'), ...tries]
    .reduce((a, t) => a + (Array.isArray(t.dropped) ? t.dropped.length : 0), 0);
  line('  new files dropped as orphans across salvage attempts', dropped);
  console.log();
}

// --- contrast --------------------------------------------------------------------------
{
  console.log('deterministic contrast fix');
  const fixes = fetchAll('Fixed deterministically, without a model call')
    .filter((f) => (f.changes ?? []).some((c) => String(c).startsWith('contrast')));
  const closed = fixes.filter((f) => String(f.defects ?? '').includes('contrast-low'));
  line('runs that recoloured something', fixes.length);
  line('  closed contrast-low without a model', `${closed.length} (${pct(closed.length, fixes.length)})`);
  console.log();
}

// --- re-walk ---------------------------------------------------------------------------
{
  console.log('shipped document measured again');
  const rewalks = fetchAll('Re-measured after the post-verification repairs');
  line('re-walks', `${rewalks.length} (${pct(rewalks.length, runs)} of generations)`);
  const moved = rewalks.filter((r) => r.consoleErrorsBefore !== r.consoleErrorsAfter || r.screensBefore !== r.screensAfter);
  line('  where errors or screens changed', moved.length);
  console.log();
}

// --- dead actions ----------------------------------------------------------------------
{
  console.log('walk');
  const walks = fetchAll('Browser verification completed');
  const dead = walks.filter((w) => w.deadActions && w.deadActions !== 'none');
  const labels = dead.reduce((a, w) => a + String(w.deadActions).split(',').length, 0);
  line('browser verifications', walks.length);
  const recorded = walks.filter((w) => typeof w.truncated === 'boolean');
  const cut = recorded.filter((w) => w.truncated);
  line('  stopped at the deadline (of those recording it)', `${cut.length} / ${recorded.length} (${pct(cut.length, recorded.length)})`);
  const ms = walks.map((w) => w.durationMs).filter((n) => typeof n === 'number').sort((a, b) => a - b);
  line('  median duration', ms.length ? `${Math.round(ms[Math.floor(ms.length / 2)] / 100) / 10}s` : '—');
  const sum = (k) => recorded.reduce((a, w) => a + (w[k] ?? 0), 0);
  line('  actions / probes / cleared as already selected', `${sum('actions')} / ${sum('probes')} / ${sum('alreadySelected')}`);
  const tz = [...new Set(walks.map((w) => w.tzOffset).filter((t) => t !== undefined))];
  line('  page timezone offsets seen (minutes behind UTC)', tz.join(', ') || '—');
  line('  reporting a dead in-screen button', `${dead.length} (${pct(dead.length, walks.length)}), ${labels} labels`);
  // Before the v436 deploy (2026-09-13) the walk counted controls it had clicked
  // after they left the page, so only windows after it compare.
  console.log('  (compare only windows after 2026-09-13 — earlier walks counted stale clicks as dead)');
}

// --- 2026-09-14 ------------------------------------------------------------------------
// The patch form, the emoji rewrite, the widened default-import fixup and the
// storage stand-in. Each reads the lines its change writes; see docs/04_backend.md.
// Patches were offered to every repair until v449 and only to local ones after,
// so read windows that start after 2026-09-14 01:00 JST for the patch share.
{
  console.log('\npatch-form repairs');
  const sizes = fetchAll('File repair change size');
  const patched = sizes.filter((s) => s.format === 'patch');
  const misses = fetchAll('File repair patch did not apply');
  line('repaired files (those logging a format)', `${sizes.filter((s) => s.format).length} of ${sizes.length}`);
  line('  as patches', `${patched.length} (${pct(patched.length, sizes.filter((s) => s.format).length)})`);
  const share = patched.reduce((a, s) => a + (s.replyChars ?? 0), 0) / Math.max(1, patched.reduce((a, s) => a + (s.outChars ?? 0), 0));
  line('  patch replies, as a share of the whole files', patched.length ? `${Math.round(share * 100)}% (a whole file is 100%)` : '—');
  line('  patches that did not apply and were retried whole', `${misses.length} (${pct(misses.length, patched.length + misses.length)})`);
  const reasons = misses.reduce((a, m) => { const k = String(m.error).replace(/^block \d+: /, ''); a[k] = (a[k] ?? 0) + 1; return a; }, {});
  line('    by reason', Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join(', ') || '—');

  console.log('\ndeterministic rewrites');
  const idioms = [...fetchAll('Repaired framework idioms'), ...fetchAll('Corrected a repair candidate before judging it')];
  const has = (needle) => idioms.filter((l) => (l.fixed ?? []).some((f) => String(f).includes(needle)));
  line('builds or candidates with emoji rewritten', has('emoji (').length);
  line('builds or candidates with a default import made named', has('default import を名前付き import に修正').length);
  const broke = fetchAll('A repair candidate broke the app');
  const undef = broke.filter((b) => (b.runtimeErrors ?? []).some((e) => String(e).includes('React #130')));
  const storage = broke.filter((b) => (b.runtimeErrors ?? []).some((e) => /localStorage|sessionStorage/.test(String(e))));
  line('candidates that broke the app', broke.length);
  line('  with React #130 (a component rendered as undefined)', `${undef.length} (${pct(undef.length, broke.length)}) — 4 of the 5 before v452 were the default import the fixup now widens to`);
  line('  with a web storage SecurityError', `${storage.length} (the stand-in shipped in v450)`);
}
