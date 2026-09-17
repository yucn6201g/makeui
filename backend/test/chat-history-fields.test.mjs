// Every field the thread keeps must be a field the client sends.
//
// `useChatHistory.flush` copies each message through an explicit allow-list
// before the PUT. That is the right default — `html` is a whole document per
// message and must never be stored — but it is silent in one direction: a field
// added to the message simply never arrives, nothing errors, and the loss shows
// only after a reload, by which time the thread that lost it is gone.
//
// It has now happened twice. `runInfo` was the first, and the comment left
// behind said to add new fields here on purpose. `phases` was the second, and it
// went further: the SERVER had already been built for it. `saveChatMessages`
// drops transcripts from the oldest replies before it will cut the conversation,
// on the reasoning that a reply and its request are the thing itself while the
// working is a record of how it was produced. That loop could not run, because
// no message carrying a transcript ever reached it — so 「生成過程を表示」 was
// missing from every reply after reopening a project.
//
// A comment did not stop the second occurrence, so this reads the two sides
// against each other instead. Textual on purpose, for the reason
// `api-routes.test.mjs` is: the question is which names each side spells.
//
//   node test/chat-history-fields.test.mjs      (from backend/)
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf8');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      server ${JSON.stringify(got)}\n      client ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- what the server stores -------------------------------------------------
const service = read('src/services/chat-history.ts');
const iface = /export interface StoredMessage \{([\s\S]*?)\n\}/.exec(service);
if (!iface) {
  console.log('FAIL  StoredMessage could not be located — this test is reading the wrong shape');
  process.exit(1);
}
const serverFields = [...iface[1].matchAll(/^\s{2}([A-Za-z_$][\w$]*)\??:/gm)].map((m) => m[1]).sort();

// --- what the client sends --------------------------------------------------
const hook = read('../frontend/src/hooks/useChatHistory.ts');
const stripped = /const stripped = messages\.map\(\(\{([^}]*)\}\)/.exec(hook);
if (!stripped) {
  console.log('FAIL  the allow-list could not be located in useChatHistory');
  process.exit(1);
}
const clientFields = stripped[1].split(',').map((s) => s.trim()).filter(Boolean).sort();

check('the client sends exactly the fields the thread stores', serverFields, clientFields);

// --- and the client's own type names the same set ---------------------------
//
// The destructuring above silently drops anything the type does not have, so a
// field present in the type and absent from the list is the shape of both
// failures so far.
const clientIface = /interface StoredMessage \{([\s\S]*?)\n\}/.exec(hook);
const clientTypeFields = [...clientIface[1].matchAll(/^\s{2}([A-Za-z_$][\w$]*)\??:/gm)].map((m) => m[1]).sort();
check('the client type names the same set it sends', clientTypeFields, clientFields);

// --- and the shapes inside them agree too -----------------------------------
//
// Names matching is not enough, and this is not hypothetical: `runInfo` was in
// all three lists while the stored version named only `{ modelTier, preset }`
// and the message carried `{ modelTier, preset, effort, scoreVerified }`. Two of
// the four were dropped on save with every list agreeing.
//
// `scoreVerified` is the reason this assertion exists rather than being a tidy
// idea. The score chip marks a score static-only by reading `=== false`; after a
// reload it read `undefined`, took the other branch, and presented an unverified
// score under 「ブラウザ実行の計測を含むスコアです」. Not a missing chip — a wrong
// claim about a number the user is told to compare against others.
// Built from plain strings rather than template literals: inside a template
// literal `\s` is the letter s, so a pattern written that way silently searches
// for something else and finds nothing.
const shapeOf = (src, name, field) => {
  const iface = new RegExp('interface ' + name + ' \\{([\\s\\S]*?)\\n\\}').exec(src);
  if (!iface) return `(no interface ${name})`;
  const line = new RegExp('^\\s{2}' + field + '\\??:\\s*\\{([^}]*)\\}', 'm').exec(iface[1]);
  if (!line) return `(${field} is not an inline object in ${name})`;
  return line[1].split(';').map((s) => s.trim().split(/[?:]/)[0].trim()).filter(Boolean).sort();
};

const app = read('../frontend/src/App.tsx');
for (const field of ['runInfo', 'proposal']) {
  const inMessage = shapeOf(app, 'ChatMessage', field);
  const inStored = shapeOf(hook, 'StoredMessage', field);
  const onServer = shapeOf(service, 'StoredMessage', field);
  check(`${field} keeps its whole shape on the way out`, inMessage, inStored);
  check(`${field} keeps its whole shape on the server`, inMessage, onServer);
}

// --- html must stay out of all three ----------------------------------------
//
// The one field that is deliberately not stored: a whole document per message,
// against a 400KB item ceiling. Asserted rather than assumed, because the checks
// above only ask that the three lists agree — adding `html` to all of them would
// satisfy every one of them and break saving for any project with a real thread.
for (const [where, fields] of [
  ['the server type', serverFields],
  ['the allow-list', clientFields],
  ['the client type', clientTypeFields],
]) {
  const ok = !fields.includes('html');
  console.log(`${ok ? 'PASS' : 'FAIL'}  html is not in ${where}`);
  ok ? pass++ : fail++;
}

// --- the server's transcript handling has something to handle ---------------
//
// `saveChatMessages` drops `phases` from the oldest replies before cutting the
// thread. If the field ever leaves the allow-list again, that loop goes back to
// being unreachable — which is the state it was in for as long as it existed.
const dropsTranscripts = /if \(!batch\[i\]\.phases\) continue/.test(service);
const sendsTranscripts = clientFields.includes('phases');
const ok = !dropsTranscripts || sendsTranscripts;
console.log(`${ok ? 'PASS' : 'FAIL'}  the server's transcript trimming is reachable`);
if (!ok) console.log('      the server drops `phases` to stay under the item limit, but none are sent');
ok ? pass++ : fail++;

// --- and the two mechanisms that keep a thread from being destroyed ---------
//
// Not about fields, but about this file's subject: what a thread loses without
// saying so. Both are one line each, and both were absent.
//
// `loadMessages` returned `[]` for "this project has no messages" and for "the
// request failed" alike. The caller read the second as the first, opened the
// save gate on it, and the next message written saved a thread of one over a
// thread of forty — with no error anywhere in the chain. The union return type
// carries that distinction now, so narrowing it back removes the only thing
// standing between a failed read and a destroyed conversation.
//
// The save checked nothing: `.catch(() => {})` over a fetch whose result nobody
// read. An HTTP error RESOLVES, so a 429 from the rate limiter or a 503 from the
// ledger guard never reached that catch at all. `pendingRef` was cleared before
// the request went out, so there was also nothing left to retry from.
const loadSig = /loadMessages = useCallback\(async \(projectId: string\): (Promise<[^>]*>)/.exec(hook);
check('a failed read is distinguishable from an empty thread',
  loadSig && loadSig[1], 'Promise<StoredMessage[] | null>');

const flushBody = /const flush = useCallback\(\(\) => \{([\s\S]*?)\n  \}, \[token, apiUrl\]\);/.exec(hook);
const beforeFetch = flushBody ? flushBody[1].split('fetch(')[0] : '';

const checksStatus = Boolean(flushBody) && /if \(!res\.ok\) throw/.test(flushBody[1]);
console.log(`${checksStatus ? 'PASS' : 'FAIL'}  a save that is refused counts as a failure`);
if (!checksStatus) console.log('      an HTTP error resolves; without res.ok the catch never runs');
checksStatus ? pass++ : fail++;

const holdsPayload = Boolean(flushBody) && !/pendingRef\.current = null;/.test(beforeFetch);
console.log(`${holdsPayload ? 'PASS' : 'FAIL'}  the thread is held until the save lands`);
if (!holdsPayload) console.log('      pendingRef is cleared before the request, leaving nothing to retry');
holdsPayload ? pass++ : fail++;

console.log(`\nstored: ${serverFields.join(', ')}`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
