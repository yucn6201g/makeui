/**
 * A refused poll is not a finished job.
 *
 * A generation is a server-side job the browser polls every two seconds for up
 * to thirty minutes. The ID token lives one hour. Between those two facts sat
 * the reported failure — 「認証が生成途中で切れて生成がストップする」 — and it had
 * two halves, both of which had to go:
 *
 *   the token the poll sent was a ref, updated by an effect when the auth
 *     context changed, and the context changed on a 15-minute `setInterval` or
 *     on window focus. A background tab has its timers throttled and a sleeping
 *     laptop has them stopped, so "every 15 minutes" is a promise the browser
 *     does not make. `getSession()` exchanges the 7-day refresh token whenever
 *     the ID token has expired — which is exactly the case a stale ref cannot
 *     notice — so the token is now read at request time.
 *   and a refusal ended the run. ANY 4xx except 429 set the message and turned
 *     `isGenerating` off. The job kept running on the server and finished; the
 *     browser had stopped looking, and there was no way back to it from the
 *     screen.
 *
 * All three polling hooks had the same two lines, so all three are checked here
 * rather than the one that was reported.
 *
 *   node test/poll-auth.test.mjs      (from frontend/)
 */
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/*
 * The real module, next to a stubbed Cognito.
 *
 * `pollAuth.ts` is copied rather than reimplemented — a test that reimplements
 * the thing it checks passes when the real file is deleted — and its one import
 * is answered by a stub, so both branches can be exercised: a session that hands
 * back a fresh token, and one that cannot.
 */
const work = path.join(root, 'node_modules/.cache/pollauth');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(path.join(work, 'auth'), { recursive: true });
fs.mkdirSync(path.join(work, 'utils/requests'), { recursive: true });
fs.copyFileSync(path.join(root, 'src/utils/requests/pollAuth.ts'), path.join(work, 'utils/requests/pollAuth.ts'));
fs.writeFileSync(path.join(work, 'auth/cognito.ts'),
  `export async function getIdToken(): Promise<string> {
     const v = (globalThis as any).__session;
     if (v === null) throw new Error('No current user');
     return v;
   }
`);
execSync(
  `npx esbuild "${path.join(work, 'utils/requests/pollAuth.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(work, 'bundle.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
globalThis.__session = 'fresh-token';
const { pollAuthToken, isAuthRefusal, AUTH_RETRY_BUDGET } = await import(
  pathToFileURL(path.join(work, 'bundle.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- which refusals a refresh can fix --------------------------------------
check('401 is worth another try', isAuthRefusal(401), true);
check('so is 403', isAuthRefusal(403), true);
// A job id that does not exist does not start existing, and 429 was already
// retried as transient by the branch below this one.
check('404 is not', isAuthRefusal(404), false);
check('400 is not', isAuthRefusal(400), false);
check('429 is not, it is handled as transient', isAuthRefusal(429), false);
check('500 is not', isAuthRefusal(500), false);
check('and neither is a failure with no status at all', isAuthRefusal(undefined), false);

// --- the token for one poll -------------------------------------------------
globalThis.__session = 'fresh-token';
check('a live session supplies the token', await pollAuthToken('stale-token'), 'fresh-token');
// The captured token may still be valid; a `getSession()` that fails is usually
// the network. Refusing to poll there abandons a running job over a blip.
globalThis.__session = null;
check('a failed refresh falls back to the one we had', await pollAuthToken('stale-token'), 'stale-token');
check('and never throws, even with nothing to fall back to', await pollAuthToken(null), '');

check('the budget is small enough that a dead session still says so', AUTH_RETRY_BUDGET <= 5, true);
check('and large enough to cover a wake-up', AUTH_RETRY_BUDGET >= 2, true);

// --- every hook that polls, not only the one that was reported -------------
const HOOKS = ['useGenerate', 'usePlan', 'useModify'];
const src = Object.fromEntries(HOOKS.map((h) => [h, fs.readFileSync(path.join(root, `src/hooks/${h}.ts`), 'utf8')]));
const every = (name, predicate) =>
  check(name, HOOKS.filter((h) => !predicate(src[h])), []);

every('every polling hook reads its token at request time',
  (s) => /pollAuthToken\(/.test(s));
// The defect itself: a captured token used for every poll of a half-hour job.
every('and none of them sends a captured one straight to fetch',
  (s) => !/Authorization: `Bearer \$\{tokenRef\.current/.test(s));
every('every one has a retry budget', (s) => /authRetriesRef = useRef\(0\)/.test(s));
every('spends it on a refusal rather than ending the run',
  (s) => /isAuthRefusal\(.*\) && authRetriesRef\.current < AUTH_RETRY_BUDGET/.test(s));
every('and clears it when a poll answers',
  (s) => /authRetriesRef\.current = 0/.test(s));
// The retry must come before the terminal 4xx branch or it is unreachable.
every('the retry is reached before the branch that gives up',
  (s) => s.indexOf('isAuthRefusal') < s.indexOf('認証エラーが発生しました'));
// And a session that really is gone still says so.
every('a spent budget still ends in a message',
  (s) => /認証エラーが発生しました。再度ログインしてください。/.test(s));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
