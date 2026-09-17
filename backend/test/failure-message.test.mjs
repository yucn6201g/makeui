// What a failed job says to the person who asked for it.
//
// The inputs below are not invented. They are the distinct `error` values from
// every terminal job failure in thirty days of production logs, copied verbatim,
// with their counts:
//
//     34  ThrottlingException: Too many tokens per day, …
//      4  MaxTokensError: … requires intervention.
//      1  ModelError: Stream ended without completing a message
//      1  InternalServerException: …
//      1  ValidationException: Item size to update has exceeded …
//      1  NoSuchBucket: The specified bucket does not exist
//
// Each of those reached the chat verbatim, in an error bubble. The call site's
// comment said the orchestrators raise messages written for the user and that
// those pass through — they do, and none of them had arrived here in a month.
// The handling covered the case that does not happen.
//
// Two assertions carry most of the weight, and neither is about wording:
//
//   - the two ThrottlingException messages must NOT get the same advice. They
//     share an exception name and need opposite remedies: a daily token quota
//     does not clear by waiting a minute, and a burst does not clear by waiting
//     a day. This is the 34-of-42 case, so getting it generically right and
//     specifically wrong would be the worst outcome available.
//
//   - the infrastructure bucket must not invite a retry. A missing bucket or a
//     denied role is identical on the second attempt, so "try again" turns one
//     failure into several while the user waits for something that cannot work.
//
//   node test/failure-message.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/utils/failure-message.ts')}" --bundle --platform=node ` +
    `--format=esm --outfile="${path.join(root, 'dist/fm.test.mjs')}" --external:@aws-sdk/*`,
  { stdio: 'pipe', cwd: root }
);
const { describeFailure } = await import(pathToFileURL(path.join(root, 'dist/fm.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok && detail !== undefined) console.log(`      ${detail}`);
  ok ? pass++ : fail++;
};

const JAPANESE = /[぀-ヿ㐀-鿿]/;
const ASCII_EXCEPTION = /[A-Za-z]{4,}(Exception|Error)/;

// --- the measured production failures --------------------------------------
const PRODUCTION = [
  'ThrottlingException: Too many tokens per day, please wait before trying again.',
  'ThrottlingException: Too many requests, please wait before trying again. You have sent too many requests.  Wait before trying again.',
  'MaxTokensError: Model reached maximum token limit. This is an unrecoverable state that requires intervention.',
  'ModelError: Stream ended without completing a message',
  'InternalServerException: The system encountered an unexpected error during processing. Try your request again.',
  'ValidationException: Item size to update has exceeded the maximum allowed size',
  'NoSuchBucket: The specified bucket does not exist',
];

for (const raw of PRODUCTION) {
  const out = describeFailure(new Error(raw));
  const name = raw.split(':')[0];
  check(`${name} is rewritten for a reader`,
    JAPANESE.test(out) && !ASCII_EXCEPTION.test(out) && !out.includes(raw), out);
}

// --- the case that is 34 of 42 ---------------------------------------------
const daily = describeFailure(new Error(PRODUCTION[0]));
const burst = describeFailure(new Error(PRODUCTION[1]));
check('the two throttling failures get different advice', daily !== burst,
  `both said: ${daily}`);
check('a daily quota is not answered with "wait a minute"', !/1分/.test(daily), daily);
check('a burst is not answered with "wait until tomorrow"', !/日付/.test(burst), burst);

// --- the case the user cannot act on ---------------------------------------
const infra = describeFailure(new Error('NoSuchBucket: The specified bucket does not exist'));
check('an infrastructure fault does not invite a retry',
  !/もう一度|再度|お試し/.test(infra), infra);
check('an infrastructure fault says it was recorded', /記録/.test(infra), infra);

// --- messages that were written for a reader --------------------------------
//
// A message written for a reader passes through untouched, because it names the
// actual problem and nothing here could reconstruct it.
//
// Nothing in the backend currently throws one. The two below came from
// `figma-import.ts`, which went with the Figma integration, and a scan finds no
// deliberate Japanese throw left anywhere. The branch stays regardless: the rule
// is about what to do WHEN such a message arrives, and dropping it because
// nothing raises one today would mean the next one written gets replaced by a
// generic sentence — the failure this whole file exists to prevent, arrived at
// from the other side.
for (const written of [
  '指定されたノードが見つかりませんでした',
  'このファイルの最初のページに、画面として読める大きさのフレームがありませんでした',
]) {
  check(`a deliberate message passes through: ${written.slice(0, 20)}…`,
    describeFailure(new Error(written)) === written, describeFailure(new Error(written)));
}

// --- the raw exception never survives ---------------------------------------
//
// The point of the fallback is that an unrecognised name is exactly the case
// where the text means least to whoever is reading it — so an unknown exception
// must be replaced, not passed through as the least-bad option.
const unknown = describeFailure(new Error('QuantumFluxException: the flux capacitor is misaligned'));
check('an unrecognised exception is replaced rather than shown',
  !unknown.includes('QuantumFlux') && !unknown.includes('flux capacitor'), unknown);
check('an unrecognised exception still says what to do', JAPANESE.test(unknown), unknown);

// --- shapes that are not Errors ---------------------------------------------
check('a thrown string is classified too',
  describeFailure('ThrottlingException: Too many requests') === burst,
  describeFailure('ThrottlingException: Too many requests'));
check('an empty message yields the fallback', JAPANESE.test(describeFailure(new Error(''))));
check('undefined yields the fallback', JAPANESE.test(describeFailure(undefined)));

// --- the exception name is often only on the object -------------------------
//
// AWS SDK errors carry the name on `.name` and a bare sentence in `.message`,
// so matching the message alone misses them.
const named = new Error('Rate exceeded');
named.name = 'ThrottlingException';
check('an exception named only on the object is still matched',
  describeFailure(named) === burst, describeFailure(named));

// --- a caller that is not a generation --------------------------------------
//
// 「生成に失敗しました」 is wrong for a route that was not generating anything, in
// the way that sends someone looking at the wrong screen.
const SUBJECT = 'デザインシステムを取り込めませんでした';
const other = describeFailure(new Error('fetch failed'), SUBJECT);
check('an unrecognised failure uses the caller’s own subject', other === SUBJECT, other);
check('a recognised failure is still classified regardless of the fallback',
  describeFailure(new Error(PRODUCTION[0]), SUBJECT) === daily);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
