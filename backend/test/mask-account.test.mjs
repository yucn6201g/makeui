/**
 * The AWS account id does not leave the server.
 *
 * Every model is stored as a full inference-profile ARN and was sent to the
 * browser as stored. `/admin/models` is where it was seen; `/models`, which
 * answers every signed-in user, was sending it too, in a field nothing reads.
 *
 * The properties pinned here are the ones a looser mask would get wrong: the
 * account field is the one masked and nothing else is, and a model id that
 * happens to contain a long number is not mistaken for an account.
 *
 *   node test/mask-account.test.mjs      (from backend/)
 */
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/utils/mask-account.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/ma.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const { maskAccountId } = await import(pathToFileURL(path.join(root, 'dist/ma.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// The value as it is actually stored — read from /makeui/models/haiku.
const ARN = 'arn:aws:bedrock:ap-northeast-1:123456789012:inference-profile/jp.anthropic.claude-haiku-4-5-20251001-v1:0';
const masked = maskAccountId(ARN);

check('the account id is gone', masked.includes('123456789012'), false);
check('and replaced, not deleted, so the ARN keeps its shape',
  masked, 'arn:aws:bedrock:ap-northeast-1:************:inference-profile/jp.anthropic.claude-haiku-4-5-20251001-v1:0');
/*
 * The profile id is untouched. `describeModelId` reads scope, vendor and version
 * off the segment after the last slash, and the panel shows it — masking that
 * would hide which model a tier calls, which is the column's whole purpose.
 */
check('the profile id is untouched', masked.split('/').pop(), 'jp.anthropic.claude-haiku-4-5-20251001-v1:0');
// The snapshot date is eight digits inside the profile id and is not an account.
check('a date in the profile id is not mistaken for an account', masked.includes('20251001'), true);

// --- values that are not ARNs pass through --------------------------------------
check('a bare profile id is left alone',
  maskAccountId('jp.anthropic.claude-sonnet-4-6'), 'jp.anthropic.claude-sonnet-4-6');
check('an empty value is left alone', maskAccountId(''), '');
check('twelve digits outside the account field are left alone',
  maskAccountId('model-123456789012-v1'), 'model-123456789012-v1');

// --- and both routes use it --------------------------------------------------------
/*
 * Two routes sent the ARN. Pinned by name, because the fix that looks complete
 * is the one applied only where it was noticed.
 */
const inventory = fs.readFileSync(path.join(root, 'src/services/model-inventory.ts'), 'utf8');
const handler = fs.readFileSync(path.join(root, 'src/handlers/lambda-handler.ts'), 'utf8');
check('/admin/models masks the profile', /profile: maskAccountId\(profile\)/.test(inventory), true);
for (const tier of ['haikuId', 'sonnetId', 'opusId']) {
  check(`/models masks ${tier}`, new RegExp(`modelId: maskAccountId\\(cfg\\.${tier}\\)`).test(handler), true);
}
check('and /models no longer sends an unmasked id',
  /modelId: cfg\.(haiku|sonnet|opus)Id\b/.test(handler), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
