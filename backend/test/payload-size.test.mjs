// Everything large on an async job payload travels through S3.
//
// The worker-Lambda fallback is an async invoke, and that has a 256KB ceiling on
// the whole payload. The document, the pictures and a plan revision's
// specification already went through S3 above a threshold; the approved plan
// handed to /generate did not. It is capped at 120,000 characters, which in
// Japanese is well past 256KB — so a long approved plan failed exactly when the
// Runtime was down and the fallback was the only way left.
//
//   node test/payload-size.test.mjs      (from backend/)
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const handler = read('src/handlers/lambda-handler.ts');
const runner = read('src/handlers/job-runner.ts');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// The premise, in numbers.
const threshold = Number(/const HTML_S3_THRESHOLD = ([\d_]+);/.exec(runner)?.[1].replace(/_/g, ''));
const cap = Number(/approvedPlan\.length > ([\d_]+)/.exec(handler)?.[1].replace(/_/g, ''));
check('the threshold and the cap were found', [threshold > 0, cap > 0], [true, true]);
check('a plan at the cap, in Japanese, is past the async ceiling', Buffer.byteLength('あ'.repeat(cap), 'utf8') > 256 * 1024, true);
check('and past the threshold that sends things to S3', Buffer.byteLength('あ'.repeat(cap), 'utf8') > threshold, true);

// The route: the plan is taken out of the inline spread and put back through the helper.
const generate = handler.slice(handler.indexOf('const jobPayload = {') - 2500, handler.indexOf('const jobPayload = {') + 400);
check('the generate route strips the inline plan', /approvedPlan: _rawPlan, experiment: _experiment, \.\.\.inputWithoutImage/.test(generate), true);
check('and sends it through the upload helper', /planForPayload = await uploadPlanIfNeeded\(jobId, input\.approvedPlan\)/.test(generate), true);
check('which the payload carries', /input: \{ \.\.\.inputWithoutImage, \.\.\.imageForPayload, \.\.\.imagesForPayload, \.\.\.planForPayload(?:, \.\.\.projectOwner)? \}/.test(generate), true);

// The job: whichever way it came.
check('the job reads it from either place', /approvedPlan: await resolveJobPlan\(input\)/.test(runner), true);
check('the helper keys on byte size, like the others', /export async function uploadPlanIfNeeded[\s\S]{0,200}payloadBytes\(plan\) <= HTML_S3_THRESHOLD/.test(runner), true);
check('and the S3 copy is removed once read', /input\.approvedPlanS3Key[\s\S]{0,80}fetchAndDelete\(input\.approvedPlanS3Key\)/.test(runner), true);

// Every large field has the same treatment, so the next one added is checked here too.
for (const [field, helper] of [['html', 'uploadHtmlIfNeeded'], ['image', 'uploadImageIfNeeded'], ['images', 'uploadContentImages'], ['revision spec', 'uploadSpecIfNeeded'], ['approved plan', 'uploadPlanIfNeeded']]) {
  check(`${field} goes through ${helper}`, new RegExp(`${helper}\\(jobId`).test(handler), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
