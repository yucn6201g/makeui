/**
 * The small rules the sign-in form, the admin panel and the account forms stand
 * on, run as code rather than read as source (2026-09-30): who may open the
 * admin panel, what a password must be, and what a full-width keyboard does to
 * an email address or an authenticator code. None of these had a test that ran
 * them; each decides whether somebody can get in.
 *
 *   node test/account-and-input-rules.test.mjs      (from frontend/)
 */
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'dist-test/account-and-input-rules.entry.ts');
fs.mkdirSync(path.dirname(entry), { recursive: true });
fs.writeFileSync(entry, [
  "export * from '../src/utils/account/membership';",
  "export * from '../src/utils/account/passwordPolicy';",
  "export * from '../src/utils/requests/halfWidth';",
].join('\n'));
const out = path.join(root, 'dist-test/account-and-input-rules.test.mjs');
execSync(`npx esbuild "${entry}" --bundle --platform=node --format=esm --outfile="${out}"`, { stdio: 'pipe', cwd: root });
const m = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- who an account is, from its Cognito groups ---------------------------------------
{
  const { membershipOf, canOpenAdminPanel, isSuperAdmin } = m;
  check('no groups: an ordinary user in no group', membershipOf([]), { role: 'user', group: null });
  check('undefined groups are no groups', membershipOf(undefined), { role: 'user', group: null });
  check('a member of a group', membershipOf(['grp:design']), { role: 'user', group: 'design' });
  check('the administrator of a group', membershipOf(['grp:design', 'grpadm:design']).role, 'group-admin');
  check('and of that group', membershipOf(['grpadm:design']).group, 'design');
  check('the account administrator outranks a group role', membershipOf(['grpadm:design', 'admin']).role, 'super-admin');
  check('the panel opens for both kinds of administrator',
    [membershipOf(['admin']), membershipOf(['grpadm:design']), membershipOf(['grp:design'])].map(canOpenAdminPanel), [true, true, false]);
  check('only the account administrator is super',
    [membershipOf(['admin']), membershipOf(['grpadm:design'])].map(isSuperAdmin), [true, false]);
  check('a group named like the super group is not super', membershipOf(['grp:admin']).role, 'user');
}

// --- what a password must be -------------------------------------------------------------
{
  const { passwordProblem, PASSWORD_MIN_LENGTH } = m;
  const good = 'Makeui-Test-2026';
  check('a password that meets every rule has no problem', passwordProblem(good), null);
  check('the length is twelve', PASSWORD_MIN_LENGTH, 12);
  check('eleven characters is short', typeof passwordProblem('Aa1-Aa1-Aa1'), 'string');
  check('twelve is enough', passwordProblem('Aa1-Aa1-Aa1-'), null);
  for (const [name, pw] of [['no upper case', 'makeui-test-2026'], ['no lower case', 'MAKEUI-TEST-2026'], ['no digit', 'Makeui-Test-abcd'], ['no symbol', 'MakeuiTest2026x']]) {
    check(`${name} is refused`, typeof passwordProblem(pw), 'string');
  }
  check('the message names the field it is about', passwordProblem('short', '仮パスワード')?.startsWith('仮パスワード'), true);
  check('and ends the way every message does', passwordProblem('short')?.endsWith('。'), true);
  check('an empty password is a problem, not a crash', typeof passwordProblem(''), 'string');
}

// --- a Japanese keyboard in a credential field ---------------------------------------------
{
  const { toHalfWidth, toDigits } = m;
  check('full-width letters, digits and @ become ASCII', toHalfWidth('ｔａｒｏ＠ｅｘａｍｐｌｅ．ｃｏｍ'), 'taro@example.com');
  check('the ideographic space is a space', toHalfWidth('a　b'), 'a b');
  check('kana, kanji and emoji are dropped', toHalfWidth('taroたろう太郎😀'), 'taro');
  check('ASCII passes untouched', toHalfWidth('Aa1-!~'), 'Aa1-!~');
  check('an authenticator code is six half-width digits', toDigits('１２３ ４５６'), '123456');
  check('and no more, however it arrived', toDigits('1234567890'), '123456');
  check('with the letters taken out', toDigits('12a34b56'), '123456');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
