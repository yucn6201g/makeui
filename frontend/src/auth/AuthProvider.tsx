import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { CognitoUser, CognitoUserSession } from 'amazon-cognito-identity-js';
import {
  getCurrentUser,
  getSession,
  signIn,
  completeNewPassword,
  completeMFASetup,
  sendMFACode,
  signOut as cognitoSignOut,
} from './cognito';
import { membershipOf, canOpenAdminPanel, type Membership } from '../utils/account/membership';

type AuthStep = 'idle' | 'new-password' | 'mfa-setup' | 'mfa-verify';

interface AuthContextType {
  isAuthenticated: boolean;
  userEmail: string | null;
  token: string | null;
  /**
   * Whether the admin panel opens at all. True for a group administrator too —
   * `membership` is what says which of the two, and what the panel may show.
   */
  isAdmin: boolean;
  membership: Membership;
  loading: boolean;
  authStep: AuthStep;
  mfaSecret: string | null;
  mfaEmail: string | null;
  login: (email: string, password: string) => Promise<void>;
  submitNewPassword: (newPassword: string) => Promise<void>;
  submitMFACode: (code: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [membership, setMembership] = useState<Membership>({ role: 'user', group: null });
  const [loading, setLoading] = useState(true);
  const [authStep, setAuthStep] = useState<AuthStep>('idle');
  const [mfaSecret, setMfaSecret] = useState<string | null>(null);
  const cognitoUserRef = useRef<CognitoUser | null>(null);
  const loginEmailRef = useRef<string>('');

  const handleSession = useCallback((session: CognitoUserSession) => {
    const idToken = session.getIdToken();
    setToken(idToken.getJwtToken());
    setUserEmail(idToken.payload['email'] as string);
    const groups = (idToken.payload['cognito:groups'] as string[] | undefined) ?? [];
    const m = membershipOf(groups);
    setMembership(m);
    // `isAdmin` now means "may open the panel", which is a group administrator
    // as well. What each of them may DO inside it is `membership`.
    setIsAdmin(canOpenAdminPanel(m));
    setIsAuthenticated(true);
    setAuthStep('idle');
    setMfaSecret(null);
  }, []);

  useEffect(() => {
    const user = getCurrentUser();
    if (user) {
      getSession()
        .then((session) => {
          handleSession(session);
        })
        .catch(() => {
          setIsAuthenticated(false);
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, [handleSession]);

  /**
   * Keep the ID token fresh.
   *
   * The pool issues ID tokens valid for one hour, and the token was previously
   * captured once at sign-in and never renewed — so any session lasting past the
   * hour started failing every request with 401, and a generation still polling
   * at that point reported an auth error even though the job had succeeded.
   * getSession() silently exchanges the 7-day refresh token when the ID token has
   * expired, so calling it on a timer (and when the tab regains focus, to cover
   * sleep/wake) is enough.
   */
  useEffect(() => {
    if (!isAuthenticated) return;

    let cancelled = false;
    const refresh = () => {
      if (!getCurrentUser()) return;
      getSession()
        .then((session) => {
          if (!cancelled) handleSession(session);
        })
        .catch(() => {
          // Refresh token expired or revoked — force a fresh sign-in.
          if (!cancelled) setIsAuthenticated(false);
        });
    };

    const REFRESH_INTERVAL_MS = 15 * 60 * 1000; // comfortably inside the 1h lifetime
    const timer = setInterval(refresh, REFRESH_INTERVAL_MS);
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);

    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [isAuthenticated, handleSession]);

  const login = useCallback(async (email: string, password: string) => {
    loginEmailRef.current = email;
    return new Promise<void>((resolve, reject) => {
      cognitoUserRef.current = signIn(email, password, {
        onSuccess: (session) => {
          handleSession(session);
          resolve();
        },
        onFailure: (err) => {
          reject(err);
        },
        onNewPasswordRequired: (user) => {
          cognitoUserRef.current = user;
          setAuthStep('new-password');
          resolve();
        },
        onMFASetup: (user, secretCode) => {
          cognitoUserRef.current = user;
          setMfaSecret(secretCode);
          setAuthStep('mfa-setup');
          resolve();
        },
        onTOTPRequired: (user) => {
          cognitoUserRef.current = user;
          setAuthStep('mfa-verify');
          resolve();
        },
      });
    });
  }, [handleSession]);

  const submitNewPassword = useCallback(async (newPassword: string) => {
    const user = cognitoUserRef.current;
    if (!user) throw new Error('No user in context');
    try {
      const session = await completeNewPassword(user, newPassword);
      handleSession(session);
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err) {
        const mfaErr = err as { code: string; user: CognitoUser; secretCode?: string };
        if (mfaErr.code === 'MFA_SETUP_REQUIRED') {
          cognitoUserRef.current = mfaErr.user;
          setMfaSecret(mfaErr.secretCode || null);
          setAuthStep('mfa-setup');
          return;
        }
        if (mfaErr.code === 'TOTP_REQUIRED') {
          cognitoUserRef.current = mfaErr.user;
          setAuthStep('mfa-verify');
          return;
        }
      }
      throw err;
    }
  }, [handleSession]);

  const submitMFACode = useCallback(async (code: string) => {
    const user = cognitoUserRef.current;
    if (!user) throw new Error('No user in context');
    if (authStep === 'mfa-setup') {
      const session = await completeMFASetup(user, code);
      handleSession(session);
    } else {
      const session = await sendMFACode(user, code);
      handleSession(session);
    }
  }, [authStep, handleSession]);

  const logout = useCallback(() => {
    cognitoSignOut();
    setIsAuthenticated(false);
    setUserEmail(null);
    setToken(null);
    setIsAdmin(false);
    setMembership({ role: 'user', group: null });
    setAuthStep('idle');
    setMfaSecret(null);
    cognitoUserRef.current = null;
  }, []);

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated,
        userEmail,
        token,
        isAdmin,
        membership,
        loading,
        authStep,
        mfaSecret,
        mfaEmail: loginEmailRef.current || null,
        login,
        submitNewPassword,
        submitMFACode,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
