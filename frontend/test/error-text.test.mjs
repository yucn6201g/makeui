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
  `npx esbuild "${path.join(root, 'src/utils/request.ts')}" --bundle --platform=node --format=esm ` +
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
  /通信に失敗/.test(requestErrorMessage(new TypeError('Failed to fetch'), FALLBACK)));

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
  // Cognito's messages distinguish a wrong password from an unknown user from
  // an expired code. Replacing them with one sentence would leave someone
  // retyping a password that was never the problem.
  'src/App.tsx': 'Cognito auth errors — the distinctions are what the user needs',
  // An operator surface. The raw text is the useful one.
  'src/hooks/useAdmin.ts': 'admin panel — raw message is the point',
  // `error` is never destructured at the call site, so nothing renders it.
  'src/hooks/useHistory.ts': 'not rendered anywhere',
  // The classifier itself.
  'src/utils/request.ts': 'this is requestErrorMessage',
  // Two different reasons in one file. `isStaleChunk` reads the message to
  // MATCH on it, not to show it. The compile errors are shown deliberately and
  // verbatim: `Panel.tsx: Unexpected token (14:2)` names the file and the
  // position, and replacing it with a sentence would remove the only thing that
  // locates the problem.
  'src/utils/reactPreview.ts': 'matching, and compiler output that must stay verbatim',
  // The engine's own complaint about a pattern the user just typed —
  // 「Unterminated group」 says which part of their regex is wrong, where a
  // generic sentence would not.
  'src/utils/codeSearch.ts': 'regex error describing the user’s own input',
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
