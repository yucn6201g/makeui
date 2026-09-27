/**
 * The user pool's password rule, as a person reads it and as the forms check it.
 *
 * The pool (infrastructure/template.yaml, PasswordPolicy) asks for 12 characters
 * and at least one each of upper case, lower case, digit and symbol. The forms
 * that take a new password — the first sign-in and an administrator creating an
 * account — check it before sending, so the refusal arrives as a sentence that
 * says what is missing rather than as Cognito's English after a round trip.
 * backend/test/password-policy.test.mjs holds the numbers here to the template's.
 */
export const PASSWORD_MIN_LENGTH = 12;

export const PASSWORD_RULE = '12文字以上で、大文字・小文字・数字・記号をそれぞれ1文字以上含めてください。';

/** Short enough for a placeholder. */
export const PASSWORD_HINT = '12文字以上・大文字・小文字・数字・記号を含む';

/** What the password lacks, as one sentence, or null when it meets the rule. `label` names the field. */
export function passwordProblem(password: string, label = 'パスワード'): string | null {
  const missing: string[] = [];
  if (!/[A-Z]/.test(password)) missing.push('大文字');
  if (!/[a-z]/.test(password)) missing.push('小文字');
  if (!/[0-9]/.test(password)) missing.push('数字');
  if (!/[^A-Za-z0-9]/.test(password)) missing.push('記号');
  const short = password.length < PASSWORD_MIN_LENGTH;
  if (!short && missing.length === 0) return null;
  const parts = [
    ...(short ? [`${PASSWORD_MIN_LENGTH}文字以上にしてください（今は${password.length}文字です）`] : []),
    ...(missing.length ? [`${missing.join('・')}を含めてください`] : []),
  ];
  return `${label}が条件を満たしていません。${parts.join('。')}。`;
}
