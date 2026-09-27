import { useState, type ReactNode } from 'react';
import type { Decorator } from '@storybook/react-vite';
import { AuthContext, type AuthContextType } from '../src/auth/AuthProvider';
import { MockApi } from '../e2e/fixtures/api';
import { mockAdmin } from '../e2e/fixtures/admin';

/**
 * What a story needs from outside the component: a signed-in user and an API.
 *
 * The API is the E2E suite's mock (e2e/fixtures/api.ts) answering in the
 * browser instead of through Playwright — the same data, held to the backend by
 * test/e2e-contract.test.mjs, so a screen in Storybook sees the answers the
 * real one would.
 */

type Role = 'user' | 'super-admin';

export function authValue(role: Role = 'user', overrides: Partial<AuthContextType> = {}): AuthContextType {
  const admin = role === 'super-admin';
  return {
    isAuthenticated: true,
    userEmail: 'storybook@example.invalid',
    token: 'storybook-token',
    isAdmin: admin,
    membership: admin ? { role: 'super-admin', group: null } : { role: 'user', group: null },
    loading: false,
    authStep: 'idle',
    mfaSecret: null,
    mfaEmail: null,
    login: async () => {},
    submitNewPassword: async () => {},
    submitMFACode: async () => {},
    logout: () => {},
    ...overrides,
  };
}

/** Wraps a story in a signed-in session. */
export const withAuth = (role: Role = 'user', overrides: Partial<AuthContextType> = {}): Decorator => (Story) => (
  <AuthContext.Provider value={authValue(role, overrides)}>
    <Story />
  </AuthContext.Provider>
);

/**
 * Answers the story's API requests from a fresh MockApi, set up by `seed`.
 *
 * `fetch` is replaced while the story is on screen: a request to another origin
 * is answered by the mock (by path, whatever the host), anything same-origin —
 * Storybook's own files — goes through.
 */
export const withApi = (seed?: (api: MockApi) => void, options: { admin?: boolean } = {}): Decorator => (Story) => (
  <ApiScope seed={seed} admin={options.admin}>
    <Story />
  </ApiScope>
);

function ApiScope({ seed, admin, children }: { seed?: (api: MockApi) => void; admin?: boolean; children: ReactNode }) {
  // Installed during the first render, before any child effect can fetch.
  useState(() => {
    const api = new MockApi();
    if (admin) mockAdmin(api);
    seed?.(api);
    const original = (window as { __storybookFetch?: typeof fetch }).__storybookFetch ?? window.fetch.bind(window);
    (window as { __storybookFetch?: typeof fetch }).__storybookFetch = original;
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.origin === location.origin) return original(input, init);
      let body: unknown = null;
      if (typeof init?.body === 'string') {
        try { body = JSON.parse(init.body); } catch { body = init.body; }
      }
      const reply = await api.respond({
        method: (init?.method ?? 'GET').toUpperCase(),
        path: url.pathname,
        query: url.searchParams,
        body,
        headers: {},
      });
      // A little latency, so loading states are seen the way people see them.
      await new Promise((r) => setTimeout(r, 120));
      return new Response(JSON.stringify(reply.body ?? {}), {
        status: reply.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    return api;
  });
  return <>{children}</>;
}
