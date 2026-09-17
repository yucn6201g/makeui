/**
 * The outcomes script reads log lines by message, and a message nobody logs
 * reads back as zero — which looks exactly like "it never happened". Every
 * message the script asks for must be one the source actually logs.
 *
 *   node test/pipeline-outcomes.test.mjs      (from backend/)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = fs.readFileSync(path.join(root, 'scripts/pipeline-outcomes.mjs'), 'utf8');

function sources(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (e.name.endsWith('.ts')) out.push(fs.readFileSync(p, 'utf8'));
  }
  return out;
}
const src = sources(path.join(root, 'src')).join('\n');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const messages = [...script.matchAll(/fetchAll\('([^']+)'\)/g)].map((m) => m[1]);
check('the script reads several messages', messages.length >= 8, true);
for (const m of new Set(messages)) {
  check(`logged by the source: ${m}`, src.includes(`logger.info('${m}'`) || src.includes(`logger.warn('${m}'`), true);
}
/*
 * And the fields it reads off them. A renamed field is the same silent zero as a
 * renamed message.
 */
const fields = {
  'Edit requirements checked': ['total', 'met', 'unmet', 'unverified', 'misplaced', 'repairedMisses'],
  'Quality defects detected': ['requestId', 'pass', 'defects'],
  'Interaction repair accepted': ['requestId', 'pass', 'kind', 'remaining', 'before', 'after', 'weightedBefore', 'weightedAfter'],
  'Interaction repair rejected': ['reason'],
  'Requirements checked': ['total', 'met', 'unverified', 'openFindings'],
  'Shipping with open defects': ['defects'],
  'Retrying the repair without the files that route': ['dropped'],
  'Retrying the repair without one file': ['requestId', 'pass'],
  'Re-measured after the post-verification repairs': ['consoleErrorsBefore', 'consoleErrorsAfter', 'screensBefore', 'screensAfter'],
  'Browser verification completed': ['deadActions', 'durationMs', 'truncated', 'actions', 'probes', 'alreadySelected', 'tzOffset'],
  'Fixed deterministically, without a model call': ['defects', 'changes'],
  'File repair change size': ['format', 'replyChars', 'outChars'],
  'File repair patch did not apply': ['error'],
  'Repaired framework idioms': ['fixed'],
  'Corrected a repair candidate before judging it': ['fixed'],
  'A repair candidate broke the app': ['runtimeErrors'],
};
// The fixup texts the script searches for, spelled as the source writes them.
check('the emoji rewrite writes the text the script counts', src.includes('emoji (${e.replaced} drawn as icons'), true);
check('the default-import fixup writes the text the script counts', src.includes('default import を名前付き import に修正'), true);
for (const [message, names] of Object.entries(fields)) {
  const at = src.indexOf(`logger.info('${message}'`);
  const call = src.slice(at, src.indexOf('})', at));
  for (const name of names) check(`${message} carries ${name}`, new RegExp(`\\b${name}\\b`).test(call), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
