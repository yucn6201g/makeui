// What the chat says when something fails.
//
// The error bubble in App.tsx renders `{error}` and nothing else — whatever
// string a hook put in state is shown to the user as-is. Measured on the server
// side, every terminal job failure in thirty days arrived as an English SDK
// exception; `describeFailure` now rewrites those before they are stored. This
// is the client half of the same problem, and it has two shapes.
//
// The first is the fallbacks. `usePlan` said 「プランの作成に失敗しました」 while
// `useGenerate` said `Generation failed` and `useModify` said
// `Modification timed out` — the same bubble, the same product, two languages,
// decided by which file the failure happened to pass through.
//
// The second is `requestErrorMessage`, whose last line was
// `err.message || fallback`. `isTransientNetworkError` catches the common case,
// a TypeError from `fetch`, but anything else went out verbatim: a JSON parse
// error naming a character offset, a thrown `HTTP 502`. It now keeps a message
// only when it was written for a reader, by the same rule the server uses.
//
//   node test/error-text.test.mjs      (from frontend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/utils/requests/request.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist-test/req.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const { requestErrorMessage, PayloadTooLargeError } = await import(
  pathToFileURL(path.join(root, 'dist-test/req.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok && detail !== undefined) console.log(`      ${detail}`);
  ok ? pass++ : fail++;
};

const FALLBACK = '生成を開始できませんでした。もう一度お試しください。';

// --- requestErrorMessage ----------------------------------------------------
check('a size refusal keeps its own message, which names the size',
  /送信サイズ/.test(requestErrorMessage(new PayloadTooLargeError(9 * 1024 * 1024, true), FALLBACK)));

check('a dropped request is named as a connection problem',
  /通信できませんでした/.test(requestErrorMessage(new TypeError('Failed to fetch'), FALLBACK)));

for (const raw of [
  'HTTP 502',
  'Unexpected token < in JSON at position 0',
  'ThrottlingException: Too many requests',
  'NetworkError when attempting to fetch resource.',
]) {
  const out = requestErrorMessage(new Error(raw), FALLBACK);
  check(`a developer-facing message is replaced: ${raw.slice(0, 32)}…`, out === FALLBACK, out);
}

check('a message written for a reader survives',
  requestErrorMessage(new Error('送信サイズが大きすぎます（9.0MB）。'), FALLBACK)
    === '送信サイズが大きすぎます（9.0MB）。');

check('the server’s own classified message survives',
  requestErrorMessage(new Error('本日の生成量が上限に達しました。日付が変わると再開できます。'), FALLBACK)
    === '本日の生成量が上限に達しました。日付が変わると再開できます。');

check('a non-Error rejection yields the fallback',
  requestErrorMessage('boom', FALLBACK) === FALLBACK);
check('an empty message yields the fallback',
  requestErrorMessage(new Error('   '), FALLBACK) === FALLBACK);

// --- and no hook that feeds the chat bubble writes English ------------------
//
// Scoped to the hooks whose `error` reaches the chat bubble.
const CHAT_HOOKS = ['useGenerate.ts', 'useModify.ts', 'usePlan.ts', 'usePublish.ts'];
const JAPANESE = /[぀-ヿ㐀-鿿]/;
const offenders = [];
for (const file of CHAT_HOOKS) {
  const src = fs.readFileSync(path.join(root, 'src/hooks', file), 'utf8');
  for (const m of src.matchAll(/setError\(\s*(?:[\w.]+\s*\|\|\s*)?'([^']+)'/g)) {
    if (!JAPANESE.test(m[1])) offenders.push(`${file}: ${m[1]}`);
  }
}
check('no hook feeding the chat bubble shows English',
  offenders.length === 0, offenders.join('\n      '));

// --- and nothing puts a raw exception on screen -----------------------------
//
// `x instanceof Error ? x.message : <fallback>` is the shape this file exists to
// close: it looks like handling, and it is the passthrough. The fallback is only
// reached for a non-Error throw, which is the rare case — an Error, which is
// every case that matters, goes out verbatim.
//
// Three places keep it deliberately, and each is listed with its reason rather
// than filtered out silently, because an allowlist nobody can read is how the
// next one gets added.
const KEEPS_THE_RAW_MESSAGE = {
  // Reads Cognito's English to tell a disabled account from an expired temporary
  // password — matching, not showing. What it returns is Japanese (checked below).
  // Until 2026-09-27 the sign-in form and the admin panel showed their raw
  // messages on purpose; both now translate, keeping the distinctions.
  'src/auth/authErrors.ts': 'matches on Cognito’s message to choose a Japanese sentence',
  // A publish that could not build says so in a sentence, then gives the
  // compiler's own words in brackets — the part that locates the problem.
  'src/utils/preview/shareDocument.ts': 'cause in brackets after a sentence written for a reader',
  // The classifier itself.
  'src/utils/requests/request.ts': 'this is requestErrorMessage',
  // Two different reasons in one file. `isStaleChunk` reads the message to
  // MATCH on it, not to show it. The compile errors are shown deliberately and
  // verbatim: `Panel.tsx: Unexpected token (14:2)` names the file and the
  // position, and replacing it with a sentence would remove the only thing that
  // locates the problem.
  'src/utils/preview/reactPreview.ts': 'matching, and compiler output that must stay verbatim',
  // The engine's own complaint about a pattern the user just typed —
  // 「Unterminated group」 says which part of their regex is wrong, where a
  // generic sentence would not.
  'src/utils/editing/codeSearch.ts': 'regex error describing the user’s own input',
};

const sources = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.tsx?$/.test(e.name)) sources.push([path.relative(root, p).replace(/\\/g, '/'), fs.readFileSync(p, 'utf8')]);
  }
})(path.join(root, 'src'));

const raw = [];
for (const [rel, src] of sources) {
  if (KEEPS_THE_RAW_MESSAGE[rel]) continue;
  for (const m of src.matchAll(/(\w+) instanceof Error \? \1\.message/g)) {
    raw.push(`${rel}: ${m[0]}`);
  }
}
check('nothing outside the allowlist shows a raw exception message',
  raw.length === 0, raw.join('\n      '));

// The allowlist must not outlive its entries: a stale name would quietly widen
// the check's blind spot on the next rename.
const stale = Object.keys(KEEPS_THE_RAW_MESSAGE).filter(
  (f) => !sources.some(([rel]) => rel === f)
);
check('every allowlisted file still exists', stale.length === 0, stale.join(', '));

// --- and every message is written the same way ------------------------------
//
// The house style, shared with the API (backend/test/error-style.test.mjs):
// Japanese, polite, ending in 「。」; what could not be done as 「〜できませんでした」,
// never 「失敗しました」; the next step in fixed words — 「もう一度お試しください。」,
// 「しばらく待ってから、もう一度お試しください。」, 「再度ログインしてください。」,
// 「管理者にお問い合わせください。」. Measured on 2026-09-27 before the change:
// half the messages had no full stop, 「失敗しました」 and 「できませんでした」 were
// used for the same thing, and the network message said both.
//
// Read from every call that puts a message on screen, whatever the variable.
const MESSAGE_CALL = /\b(?:set\w*Error|setErr|setProblem|setMessage|showError|alert|requestErrorMessage|readableMessage)\(/g;
const DIAGNOSTICS = new Set([
  // The generated app's own compile and runtime errors, shown verbatim on purpose (see above).
  'src/utils/preview/reactPreview.ts',
  'src/utils/preview/frameworkCompile.ts',
]);
/** The argument text of the call starting at `at`, by bracket depth, strings skipped. */
function argsOf(src, at) {
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '`' || c === '"') {
      const q = c;
      for (i++; i < src.length && src[i] !== q; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return src.slice(at, i + 1);
  }
  return '';
}
const literalsIn = (text) => [...text.matchAll(/'((?:[^'\\\n]|\\.)*)'|`([^`]*)`/g)].map((m) => (m[1] ?? m[2]).replace(/\$\{[^}]*\}/g, 'X'));
const offences = [];
const judge = (rel, t) => {
  if (!JAPANESE.test(t)) return;
  const why = [];
  if (!/[。）]$/.test(t) && !/X$/.test(t)) why.push('no closing 。');
  if (/失敗しました/.test(t) && !/^通信/.test(t)) why.push('「失敗しました」');
  if (/再試行|しばらくしてから|少し待ってから|再度お試し/.test(t)) why.push('not a fixed phrase');
  if (why.length) offences.push(`${rel}: ${t} — ${why.join(', ')}`);
};
let seen = 0;
for (const [rel, src] of sources) {
  if (DIAGNOSTICS.has(rel)) continue;
  for (const m of src.matchAll(MESSAGE_CALL)) {
    const args = argsOf(src, m.index + m[0].length - 1);
    for (const t of literalsIn(args)) { seen++; judge(rel, t); }
    // An English sentence handed straight to the screen.
    if (/^\(\s*'[A-Z][a-z]+ [a-z]/.test(args) && !/requestErrorMessage|readableMessage/.test(m[0])) offences.push(`${rel}: ${args.slice(0, 60)} — English on screen`);
  }
}
// The sign-in sentences are returned rather than set.
const auth = sources.find(([rel]) => rel === 'src/auth/authErrors.ts')[1];
for (const m of auth.matchAll(/(?:return |: |'[\w-]+': |^\s+mfa: )'((?:[^'\\\n]|\\.)*)'/gm)) { seen++; judge('src/auth/authErrors.ts', m[1]); }
for (const m of auth.matchAll(/return `([^`]*)`/g)) { seen++; judge('src/auth/authErrors.ts', m[1].replace(/\$\{[^}]*\}/g, 'X')); }
check('the on-screen messages were found', seen > 80, `${seen}`);
check('every on-screen message follows the house style', offences.length === 0, offences.join('\n      '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
