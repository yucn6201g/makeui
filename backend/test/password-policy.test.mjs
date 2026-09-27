// The password rule, as the user pool enforces it and as the screens state it.
//
// The admin form's placeholder used to read 「Temp@1234」 — nine characters, for a
// pool that requires twelve — so the example the form offered was one the pool
// refused. The rule is now written once for people
// (frontend/src/utils/account/passwordPolicy.ts) and once in the API's refusal;
// both are held here to infrastructure/template.yaml.
//
//   node test/password-policy.test.mjs      (from backend/)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const template = read('infrastructure/template.yaml');
const policy = /PasswordPolicy:\n((?:\s{10}\w+: \S+\n)+)/.exec(template)?.[1] ?? '';
const field = (name) => new RegExp(`${name}: (\\S+)`).exec(policy)?.[1];
check('the pool requires 12 characters', field('MinimumLength'), '12');
check('and each of the four kinds', ['RequireUppercase', 'RequireLowercase', 'RequireNumbers', 'RequireSymbols'].map(field), ['true', 'true', 'true', 'true']);

const out = path.join(root, 'backend/dist/password-policy.test.mjs');
await esbuild.build({ entryPoints: [path.join(root, 'frontend/src/utils/account/passwordPolicy.ts')], bundle: true, platform: 'node', format: 'esm', outfile: out });
const { PASSWORD_MIN_LENGTH, PASSWORD_RULE, PASSWORD_HINT, passwordProblem } = await import(`file://${out.replace(/\\/g, '/')}`);
check('the screens state the same length', PASSWORD_MIN_LENGTH, Number(field('MinimumLength')));
check('in the sentence and in the placeholder', [PASSWORD_RULE, PASSWORD_HINT].every((t) => t.includes(`${PASSWORD_MIN_LENGTH}文字以上`)), true);
check('a password meeting the rule passes', passwordProblem('Makeui-Sample-2026'), null);
check('the old placeholder would not', passwordProblem('Temp@1234') !== null, true);
check('and the refusal says what is missing',
  passwordProblem('makeui-sample'), 'パスワードが条件を満たしていません。大文字・数字を含めてください。');
check('including the length, with the count',
  passwordProblem('Ab1!'), 'パスワードが条件を満たしていません。12文字以上にしてください（今は4文字です）。');

// No example password anywhere in the admin form: an example is what gets typed.
const usersTab = read('frontend/src/components/admin/UsersTab.tsx');
check('the create form shows the rule, not a sample password', /placeholder=\{PASSWORD_HINT\}/.test(usersTab) && !/placeholder="[^"]*\d[^"]*"/.test(usersTab), true);

const handler = read('backend/src/handlers/lambda-handler.ts');
check('the API\'s refusal states the same rule', handler.includes(`${PASSWORD_MIN_LENGTH}文字以上で、大文字・小文字・数字・記号をそれぞれ1文字以上含めてください。`), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
