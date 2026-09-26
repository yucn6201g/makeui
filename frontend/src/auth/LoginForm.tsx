/**
 * Sign-in: email and password, the first-login password change, and TOTP set-up and entry.
 */
import { useState, useEffect, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { useAuth } from './AuthProvider';
import { toHalfWidth, toDigits } from '../utils/requests/halfWidth';

export function LoginForm() {
  const { authStep, mfaSecret, mfaEmail, login, submitNewPassword, submitMFACode } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (authStep === 'mfa-setup' && mfaSecret) {
      const account = encodeURIComponent(mfaEmail || email || 'user');
      const uri = `otpauth://totp/MakeUI:${account}?secret=${mfaSecret}&issuer=MakeUI`;
      QRCode.toDataURL(uri, { width: 200, margin: 2 })
        .then(setQrDataUrl)
        .catch(() => setQrDataUrl(null));
    }
  }, [authStep, mfaSecret, mfaEmail, email]);

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);
    try {
      await login(email, password);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'ログインに失敗しました');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleNewPassword = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);
    try {
      await submitNewPassword(newPassword);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'パスワード変更に失敗しました');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleMFACode = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);
    try {
      await submitMFACode(mfaCode);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'MFA認証に失敗しました');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (authStep === 'new-password') {
    return (
      <main className="login">
        <div className="login__card">
          <h1 className="login__title">MakeUI</h1>
          <p className="login__subtitle">新しいパスワードを設定してください</p>
          <form onSubmit={handleNewPassword} className="login__form">
            <div className="login__field">
              <label htmlFor="new-password">新しいパスワード</label>
              <input
                id="new-password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(toHalfWidth(e.target.value))}
                placeholder="12文字以上で入力"
                inputMode="text"
                required
                autoFocus
                aria-describedby={error ? 'login-error' : undefined}
              />
            </div>
            {error && <p className="login__error" id="login-error" role="alert">{error}</p>}
            <button type="submit" className="login__button" disabled={isSubmitting}>
              {isSubmitting ? '設定中...' : 'パスワードを設定'}
            </button>
          </form>
        </div>
      </main>
    );
  }

  if (authStep === 'mfa-setup') {
    return (
      <main className="login">
        <div className="login__card">
          <h1 className="login__title">MakeUI</h1>
          <p className="login__subtitle">多要素認証の設定</p>
          <div className="login__mfa-info">
            <p>Google Authenticator などの認証アプリでQRコードをスキャンしてください：</p>
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt="MFA設定用QRコード"
                className="login__mfa-qr"
                width={200}
                height={200}
              />
            ) : (
              <code className="login__mfa-secret" aria-label="MFAシークレットキー">{mfaSecret}</code>
            )}
          </div>
          <form onSubmit={handleMFACode} className="login__form">
            <div className="login__field">
              <label htmlFor="mfa-code">認証コード</label>
              <input
                id="mfa-code"
                type="text"
                inputMode="numeric"
                value={mfaCode}
                onChange={(e) => setMfaCode(toDigits(e.target.value))}
                maxLength={6}
                placeholder="6桁のコードを入力"
                required
                autoComplete="one-time-code"
                autoFocus
                aria-describedby={error ? 'login-error' : undefined}
              />
            </div>
            {error && <p className="login__error" id="login-error" role="alert">{error}</p>}
            <button type="submit" className="login__button" disabled={isSubmitting}>
              {isSubmitting ? '確認中...' : '確認して設定完了'}
            </button>
          </form>
        </div>
      </main>
    );
  }

  if (authStep === 'mfa-verify') {
    return (
      <main className="login">
        <div className="login__card">
          <h1 className="login__title">MakeUI</h1>
          <p className="login__subtitle">認証コードを入力してください</p>
          <form onSubmit={handleMFACode} className="login__form">
            <div className="login__field">
              <label htmlFor="mfa-code">認証コード</label>
              <input
                id="mfa-code"
                type="text"
                inputMode="numeric"
                value={mfaCode}
                onChange={(e) => setMfaCode(toDigits(e.target.value))}
                maxLength={6}
                placeholder="6桁のコードを入力"
                required
                autoComplete="one-time-code"
                autoFocus
                aria-describedby={error ? 'login-error' : undefined}
              />
            </div>
            {error && <p className="login__error" id="login-error" role="alert">{error}</p>}
            <button type="submit" className="login__button" disabled={isSubmitting}>
              {isSubmitting ? '確認中...' : '確認'}
            </button>
          </form>
        </div>
      </main>
    );
  }

  return (
    <main className="login">
      <div className="login__card">
        <h1 className="login__title">MakeUI</h1>
        <p className="login__subtitle">AIによるUIデザイン生成</p>
        <form onSubmit={handleLogin} className="login__form">
          <div className="login__field">
            <label htmlFor="email">メールアドレス</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(toHalfWidth(e.target.value))}
              placeholder="you@example.com"
              inputMode="email"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              required
              autoFocus
              aria-describedby={error ? 'login-error' : undefined}
            />
          </div>
          <div className="login__field">
            <label htmlFor="password">パスワード</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(toHalfWidth(e.target.value))}
              placeholder="パスワードを入力"
              required
              aria-describedby={error ? 'login-error' : undefined}
            />
          </div>
          {error && <p className="login__error" id="login-error" role="alert">{error}</p>}
          <button type="submit" className="login__button" disabled={isSubmitting}>
            {isSubmitting ? 'ログイン中...' : 'ログイン'}
          </button>
        </form>
      </div>
    </main>
  );
}

