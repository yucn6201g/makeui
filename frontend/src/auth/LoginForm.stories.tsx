import type { Meta, StoryObj } from '@storybook/react-vite';
import { LoginForm } from './LoginForm';
import { withAuth } from '../../.storybook/mocks';

/** Each step of signing in. The pool's MFA is required, so every sign-in ends at a code. */
const meta = {
  title: 'Sign-in/LoginForm',
  component: LoginForm,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof LoginForm>;

export default meta;
type Story = StoryObj<typeof meta>;

const signedOut = { isAuthenticated: false, token: null, userEmail: null };

export const SignIn: Story = { decorators: [withAuth('user', { ...signedOut, authStep: 'idle' })] };

/** A first sign-in: the temporary password is replaced. The rule is shown under the field. */
export const NewPassword: Story = { decorators: [withAuth('user', { ...signedOut, authStep: 'new-password' })] };

/** Registering an authenticator: a QR code, and the secret for apps that cannot scan. */
export const MfaSetup: Story = {
  decorators: [withAuth('user', { ...signedOut, authStep: 'mfa-setup', mfaSecret: 'STORYBOOKSECRETAAAAAAAAAAAAAAAAA', mfaEmail: 'storybook@example.invalid' })],
};

export const MfaCode: Story = { decorators: [withAuth('user', { ...signedOut, authStep: 'mfa-verify' })] };
