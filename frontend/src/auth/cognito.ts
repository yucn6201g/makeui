import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
  CognitoUserSession,
} from 'amazon-cognito-identity-js';

const userPool = new CognitoUserPool({
  UserPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID,
  ClientId: import.meta.env.VITE_COGNITO_CLIENT_ID,
});

interface SignInCallbacks {
  onSuccess: (session: CognitoUserSession) => void;
  onFailure: (err: Error) => void;
  onNewPasswordRequired: (user: CognitoUser, userAttributes: Record<string, string>) => void;
  onMFASetup: (user: CognitoUser, secretCode: string) => void;
  onTOTPRequired: (user: CognitoUser) => void;
}

export function getCurrentUser(): CognitoUser | null {
  return userPool.getCurrentUser();
}

export function getSession(): Promise<CognitoUserSession> {
  return new Promise((resolve, reject) => {
    const user = getCurrentUser();
    if (!user) {
      reject(new Error('No current user'));
      return;
    }
    user.getSession((err: Error | null, session: CognitoUserSession | null) => {
      if (err || !session) {
        reject(err || new Error('No session'));
        return;
      }
      resolve(session);
    });
  });
}

export async function getIdToken(): Promise<string> {
  const session = await getSession();
  return session.getIdToken().getJwtToken();
}

export function signIn(email: string, password: string, callbacks: SignInCallbacks): CognitoUser {
  const user = new CognitoUser({
    Username: email,
    Pool: userPool,
  });

  const authDetails = new AuthenticationDetails({
    Username: email,
    Password: password,
  });

  user.authenticateUser(authDetails, {
    onSuccess: (session) => {
      callbacks.onSuccess(session);
    },
    onFailure: (err) => {
      callbacks.onFailure(err);
    },
    newPasswordRequired: (userAttributes) => {
      delete userAttributes.email_verified;
      delete userAttributes.email;
      callbacks.onNewPasswordRequired(user, userAttributes);
    },
    mfaSetup: () => {
      user.associateSoftwareToken({
        associateSecretCode: (secretCode: string) => {
          callbacks.onMFASetup(user, secretCode);
        },
        onFailure: (err: Error) => {
          callbacks.onFailure(err);
        },
      });
    },
    totpRequired: () => {
      callbacks.onTOTPRequired(user);
    },
  });

  return user;
}

export function completeMFASetup(user: CognitoUser, totpCode: string): Promise<CognitoUserSession> {
  return new Promise((resolve, reject) => {
    user.verifySoftwareToken(totpCode, 'TOTP Device', {
      onSuccess: (session: CognitoUserSession) => {
        resolve(session);
      },
      onFailure: (err: Error) => {
        reject(err);
      },
    });
  });
}

export function sendMFACode(user: CognitoUser, code: string): Promise<CognitoUserSession> {
  return new Promise((resolve, reject) => {
    user.sendMFACode(code, {
      onSuccess: (session) => {
        resolve(session);
      },
      onFailure: (err) => {
        reject(err);
      },
    }, 'SOFTWARE_TOKEN_MFA');
  });
}

export function completeNewPassword(user: CognitoUser, newPassword: string): Promise<CognitoUserSession> {
  return new Promise((resolve, reject) => {
    user.completeNewPasswordChallenge(newPassword, {}, {
      onSuccess: (session) => {
        resolve(session);
      },
      onFailure: (err) => {
        reject(err);
      },
      mfaSetup: () => {
        user.associateSoftwareToken({
          associateSecretCode: (secretCode: string) => {
            reject({ code: 'MFA_SETUP_REQUIRED', user, secretCode });
          },
          onFailure: (err: Error) => {
            reject(err);
          },
        });
      },
      totpRequired: () => {
        reject({ code: 'TOTP_REQUIRED', user });
      },
    });
  });
}

export function signOut(): void {
  const user = getCurrentUser();
  if (user) {
    user.signOut();
  }
}
