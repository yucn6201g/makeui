// What the sign-in screens say when Cognito refuses (src/auth/authErrors.ts).
//
// The form used to show Cognito's English as it came — 「Incorrect username or
// password.」 beside screens that speak Japanese everywhere else. Each code is
// translated, and the distinctions a person acts on are kept.
//
//   node test/auth-errors.test.mjs      (from frontend/)
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist-test/auth-errors.test.mjs');
fs.mkdirSync(path.dirname(out), { recursive: true });
await esbuild.build({ entryPoints: [path.join(root, 'src/auth/authErrors.ts')], bundle: true, platform: 'node', format: 'esm', outfile: out });
const { authErrorMessage } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};
/** An error as amazon-cognito-identity-js builds it: code and name from `__type`. */
const cognito = (code, message) => Object.assign(new Error(message), { code, name: code });

check('a wrong password',
  authErrorMessage(cognito('NotAuthorizedException', 'Incorrect username or password.'), 'sign-in'),
  'メールアドレスまたはパスワードが正しくありません。');
check('an unknown user gets the same sentence, so addresses cannot be probed',
  authErrorMessage(cognito('UserNotFoundException', 'User does not exist.'), 'sign-in'),
  'メールアドレスまたはパスワードが正しくありません。');
check('a disabled account says who can help',
  authErrorMessage(cognito('NotAuthorizedException', 'User is disabled.'), 'sign-in'),
  'このアカウントは無効になっています。管理者にお問い合わせください。');
check('an expired temporary password names the fix',
  authErrorMessage(cognito('NotAuthorizedException', 'Temporary password has expired and must be reset by an administrator.'), 'sign-in'),
  '仮パスワードの有効期限が切れています。管理者に再発行を依頼してください。');
check('too many attempts says to wait',
  authErrorMessage(cognito('NotAuthorizedException', 'Password attempts exceeded'), 'sign-in'),
  'ログインの試行回数が上限に達しました。しばらく待ってから、もう一度お試しください。');
check('a weak new password states the rule',
  authErrorMessage(cognito('InvalidPasswordException', 'Password did not conform with policy'), 'new-password'),
  'パスワードが条件を満たしていません。12文字以上で、大文字・小文字・数字・記号をそれぞれ1文字以上含めてください。');
check('a wrong code points at the app',
  authErrorMessage(cognito('CodeMismatchException', 'Invalid code received for user'), 'mfa'),
  '認証コードが正しくありません。認証アプリに表示されている6桁のコードを入力してください。');
check('so does a wrong code while setting MFA up',
  authErrorMessage(cognito('EnableSoftwareTokenMFAException', 'Code mismatch'), 'mfa'),
  '認証コードが正しくありません。認証アプリに表示されている6桁のコードを入力してください。');
check('an expired session during MFA starts over',
  authErrorMessage(cognito('NotAuthorizedException', 'Invalid session for the user, session is expired.'), 'mfa'),
  'ログインの手続きの有効期限が切れました。最初からやり直してください。');
check('a dropped connection is named as one',
  authErrorMessage(new TypeError('Failed to fetch'), 'sign-in'),
  '通信できませんでした。接続を確認して、もう一度お試しください。');
check('and the library\'s own network code too',
  authErrorMessage(cognito('NetworkError', 'Network error'), 'sign-in'),
  '通信できませんでした。接続を確認して、もう一度お試しください。');
check('anything unknown gets the step\'s own sentence, not its English',
  authErrorMessage(cognito('InternalErrorException', 'Something broke'), 'new-password'),
  'パスワードを設定できませんでした。もう一度お試しください。');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
