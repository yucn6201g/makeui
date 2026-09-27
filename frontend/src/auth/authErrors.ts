/**
 * What the sign-in screens say when Cognito refuses.
 *
 * The library hands back Cognito's own English — 「Incorrect username or
 * password.」 — and the form used to show it as it came. Every other failure in
 * MakeUI speaks Japanese in one voice (see utils/requests/request.ts), so these
 * are translated here, by the error's code, keeping the distinctions a person
 * acts on: a wrong password is retyped, a wrong code is re-read from the app, an
 * expired temporary password needs the administrator.
 *
 * An unknown user gets the wrong-password sentence on purpose. Saying which of
 * the two was wrong would tell anyone typing addresses which ones have accounts.
 */
import { PASSWORD_RULE } from '../utils/account/passwordPolicy';
import { requestErrorMessage } from '../utils/requests/request';

export type AuthStepName = 'sign-in' | 'new-password' | 'mfa';

const AGAIN = 'しばらく待ってから、もう一度お試しください。';

const FALLBACK: Record<AuthStepName, string> = {
  'sign-in': 'ログインできませんでした。もう一度お試しください。',
  'new-password': 'パスワードを設定できませんでした。もう一度お試しください。',
  mfa: '認証コードを確認できませんでした。もう一度お試しください。',
};

export function authErrorMessage(err: unknown, step: AuthStepName): string {
  const code = (err as { code?: string; name?: string } | null)?.code ?? (err as { name?: string } | null)?.name ?? '';
  const message = err instanceof Error ? err.message : '';

  switch (code) {
    case 'NotAuthorizedException':
      if (/disabled/i.test(message)) return 'このアカウントは無効になっています。管理者にお問い合わせください。';
      if (/attempts exceeded/i.test(message)) return `ログインの試行回数が上限に達しました。${AGAIN}`;
      if (/temporary password has expired/i.test(message)) return '仮パスワードの有効期限が切れています。管理者に再発行を依頼してください。';
      if (/session/i.test(message)) return 'ログインの手続きの有効期限が切れました。最初からやり直してください。';
      return step === 'sign-in'
        ? 'メールアドレスまたはパスワードが正しくありません。'
        : 'ログインの手続きの有効期限が切れました。最初からやり直してください。';
    case 'UserNotFoundException':
      return 'メールアドレスまたはパスワードが正しくありません。';
    case 'PasswordResetRequiredException':
      return 'パスワードの再設定が必要です。管理者にお問い合わせください。';
    case 'UserNotConfirmedException':
      return 'アカウントの確認が済んでいません。管理者にお問い合わせください。';
    case 'InvalidPasswordException':
      return `パスワードが条件を満たしていません。${PASSWORD_RULE}`;
    case 'CodeMismatchException':
    case 'EnableSoftwareTokenMFAException':
      return '認証コードが正しくありません。認証アプリに表示されている6桁のコードを入力してください。';
    case 'ExpiredCodeException':
      return '認証コードの有効期限が切れています。認証アプリに表示されている新しいコードを入力してください。';
    case 'TooManyRequestsException':
    case 'TooManyFailedAttemptsException':
    case 'LimitExceededException':
      return `試行回数が多すぎます。${AGAIN}`;
    case 'InvalidParameterException':
      return step === 'sign-in' ? 'メールアドレスの形式が正しくありません。' : FALLBACK[step];
    case 'NetworkError':
      return '通信できませんでした。接続を確認して、もう一度お試しください。';
  }
  // Anything else: a network failure is named as one, the rest gets the step's sentence.
  return requestErrorMessage(err instanceof TypeError ? err : null, FALLBACK[step]);
}
