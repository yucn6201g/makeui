import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useAuth } from '../auth/AuthProvider';

/**
 * A model a user may be permitted, each one independently.
 * `auto` is a member because it picks a model, and what it picks can be Opus.
 */
export type ModelId = 'haiku' | 'sonnet' | 'opus' | 'auto';

export interface UserUsageSummary {
  userId: string;
  email: string;
  month: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  /** Billed and not part of `totalTokens` — the server records them separately. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** `totalTokens` priced. Equal to it while no price table is configured. */
  weightedTokens?: number;
  /**
   * The month's cost in the operator's currency, or null when no price table is
   * configured. Null rather than 0, which would read as a free month.
   */
  cost?: number | null;
  /** The period these figures cover, as the server computed it. */
  period?: { from: string; to: string };
  /**
   * Whether `cost` is a sum or an estimate.
   *
   * True only for a month that straddles the deploy which began recording which
   * model each request went to: those earlier requests added to the totals and
   * to nothing else, so their share of the money is inferred from what the
   * recorded ones cost. Drawn with a 「約」 so an administrator reading the
   * column can tell the two apart.
   */
  estimated?: boolean;
  /** Where the money went, one entry per model the month used. */
  byModel?: { model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; requestCount: number; cost: number | null }[];
  requestCount: number;
  monthlyLimit: number;
  /** The group this account belongs to, or null. */
  group: string | null;
  /** Which models this user may pick. Absent on records written before the setting existed. */
  allowedModels?: ModelId[];
  /** The name this account is shown by, derived from the email where unset. */
  displayName: string;
  /**
   * How many projects this account holds, over all time — not over the period.
   *
   * Optional because a response written before the server counted them has no
   * such field, and 0 would read as "this person has nothing" on a screen whose
   * whole job is to find their work.
   */
  projectCount?: number;
  lastUpdated: string;
}

/**
 * What the deployment is configured to run, as the server reports it.
 *
 * Mirrors backend/src/services/model-inventory.ts. Every field is a fact read
 * from Parameter Store or derived from a model id — nothing here is a setting
 * this screen can change.
 */
export interface ModelTierInfo {
  id: string;
  label: string;
  /**
   * What Bedrock is actually called with, exactly as Parameter Store holds it.
   *
   * Named for the thing rather than for its format: today every value is a full
   * inference-profile ARN, but the same field accepts a bare profile id and both
   * have been in here.
   */
  profile: string;
  /** The inference profile's region scope: `jp`, `global`. Null for a bare id. */
  scope: string | null;
  vendor: string | null;
  version: string | null;
  withdrawn: boolean;
  isDefault: boolean;
  /** Per 1,000,000 tokens, or null when the price table does not cover the tier. */
  prices: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
}

/**
 * One month of the whole account.
 *
 * The same three fields a per-user row carries, which is why the join that
 * builds the model table takes either. `cost` is null when the price table does
 * not cover the month — not 0, which would report it as free.
 */
export interface MonthSeries {
  /** `2026-09`. */
  month: string;
  totalTokens: number;
  requestCount: number;
  cost: number | null;
  byModel?: { model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; requestCount: number; cost: number | null }[];
  /** How much of the month has a model recorded against it. */
  attributed: { tokens: number; requests: number };
  /**
   * Whether `cost` is a sum or an inference.
   *
   * A month straddling the deploy that began recording the model prices its
   * uncounted requests at the counted ones' average. On a chart of money that
   * has to be visible: a bar drawn from three requests standing for eight is a
   * different claim from a bar drawn from eight.
   */
  estimated: boolean;
}

export interface ModelInventory {
  provider: string;
  region: string;
  tiers: ModelTierInfo[];
  withdrawn: string[];
  pricing: { currency: string; enforced: boolean } | null;
  /** The period the series covers, as the server read it. */
  period: { from: string; to: string };
  /** One entry per month in the period, including the months nobody ran in. */
  series: MonthSeries[];
}

/**
 * A user's project as the admin list shows it.
 *
 * `hasDocument` rather than the document: the list endpoint drops `lastHtml`,
 * which is inline in the stored record and would make a forty-project response
 * megabytes of markup this screen does not render.
 */
export interface AdminProject {
  projectId: string;
  userId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  preset?: string;
  model?: string;
  outputKind?: 'html' | 'react' | 'vue' | 'svelte';
  /** Tokens this project has consumed across every run. Absent on records written before it was counted. */
  totalTokens?: number;
  requestCount?: number;
  archivedAt?: string;
  favouritedAt?: string;
  hasDocument: boolean;
}

/** One generation or edit: what was asked for, and what it scored. */
export interface AdminVersion {
  versionId: string;
  projectId?: string;
  prompt: string;
  score: number;
  /**
   * Whether the score includes what a browser measured. An edit is scored
   * without one, and the two are not on the same scale — so a list showing both
   * has to say which is which.
   */
  scoreVerified?: boolean;
  /** Which scale `score` is on — see utils/scoreScale.ts. Absent on older rows. */
  scoreRubric?: number;
  /** Checkable requirements met, of those checked, and findings shipped with. Absent on older rows. */
  requirementsMet?: number;
  requirementsChecked?: number;
  openFindings?: number;
  preset: string;
  model: string;
  /**
   * What this one run cost. Absent on rows written before it was recorded, and
   * that has to stay distinguishable from zero — a generation that cost nothing
   * is not a thing, so a column of honest zeros would be a column of lies.
   */
  tokens?: { input: number; output: number };
  createdAt: string;
  /** Only on the single-version fetch. The list deliberately omits it. */
  html?: string;
}

/** A tenant grouping: its members, and the one account that administers them. */
export interface UserGroup {
  name: string;
  /** The administrator's username, or null while the group has none. */
  admin: string | null;
  memberCount: number;
  /**
   * The whole group's monthly budget, in millionths of a unit of currency.
   * -1 is unlimited; null means it could not be read, which must not be drawn
   * as either a figure or as unlimited.
   */
  monthlyLimit?: number | null;
  /** What the group has spent this month, across every member. */
  usedTokens?: number | null;
  usedWeighted?: number | null;
  requestCount?: number | null;
  cost?: number | null;
}

export interface CognitoUser {
  /** Cognito's own username, which for this pool is the email address. */
  username: string;
  /** The group this account belongs to, or null. */
  group: string | null;
  /** Whether it is that group's administrator. */
  isGroupAdmin: boolean;
  email: string;
  /**
   * The name the account is shown by. Never blank — the server derives one from
   * the email local part when nothing is stored.
   */
  displayName: string;
  /**
   * Whether that name was actually chosen, as opposed to derived. Nothing
   * behaves differently; it lets a column of names say which ones anybody set.
   */
  displayNameSet: boolean;
  status: string;
  enabled: boolean;
  createdAt: string;
}

interface UseAdminReturn {
  users: UserUsageSummary[];
  loading: boolean;
  error: string | null;
  isAdmin: boolean;
  /**
   * `from`/`to` are `YYYY-MM`, which is the granularity the store keeps — one
   * row per account per month. Omitted, the server answers for this month.
   */
  fetchUsers: (period?: { from: string; to: string }) => void;
  setUserLimit: (userId: string, limit: number) => Promise<void>;
  setUserAllowedModels: (userId: string, models: ModelId[]) => Promise<void>;
  cognitoUsers: CognitoUser[];
  cognitoLoading: boolean;
  cognitoError: string | null;
  fetchCognitoUsers: () => void;
  createUser: (displayName: string, email: string, temporaryPassword: string) => Promise<void>;
  /** Admin-only, like every other write here — there is no self-service route. */
  renameUser: (username: string, displayName: string) => Promise<void>;
  deleteUser: (username: string) => Promise<void>;
  toggleUserEnabled: (username: string, enable: boolean) => Promise<void>;
  fetchProjects: (userId: string) => Promise<AdminProject[]>;
  fetchProjectVersions: (userId: string, projectId: string) => Promise<AdminVersion[]>;
  fetchVersion: (userId: string, versionId: string) => Promise<AdminVersion>;
  groups: UserGroup[];
  fetchGroups: () => Promise<void>;
  fetchModelInventory: (period?: { from: string; to: string }) => Promise<ModelInventory>;
  createGroup: (name: string, description?: string) => Promise<void>;
  deleteGroup: (name: string) => Promise<void>;
  setMembership: (username: string, group: string | null) => Promise<void>;
  setGroupAdmin: (group: string, username: string | null) => Promise<void>;
  /** Account-administrator only; the server refuses anybody else. */
  setGroupLimit: (group: string, limit: number) => Promise<void>;
}

export function useAdmin(): UseAdminReturn {
  const { token } = useAuth();
  const [users, setUsers] = useState<UserUsageSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const [cognitoUsers, setCognitoUsers] = useState<CognitoUser[]>([]);
  const [cognitoLoading, setCognitoLoading] = useState(false);
  const [cognitoError, setCognitoError] = useState<string | null>(null);
  const cognitoAbortRef = useRef<AbortController | null>(null);

  const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:8080';

  const fetchUsers = useCallback((period?: { from: string; to: string }) => {
    if (!token) return;

    if (abortRef.current) {
      abortRef.current.abort();
    }

    setLoading(true);
    setError(null);

    const controller = new AbortController();
    abortRef.current = controller;

    const query = period ? `?from=${period.from}&to=${period.to}` : '';
    fetch(`${apiUrl}/admin/usage${query}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
      .then(async (res) => {
        if (res.status === 403) {
          setIsAdmin(false);
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setUsers(data.users);
        setIsAdmin(true);
      })
      .catch((err) => {
        if (err.name !== 'AbortError') {
          setError(err.message);
        }
      })
      .finally(() => {
        setLoading(false);
      });
  }, [token, apiUrl]);

  const setUserLimit = useCallback(async (userId: string, limit: number) => {
    if (!token) return;

    const res = await fetch(`${apiUrl}/admin/usage/limit`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId, limit }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    setUsers((prev) =>
      prev.map((u) => (u.userId === userId ? { ...u, monthlyLimit: limit } : u))
    );
  }, [token, apiUrl]);

  const setUserAllowedModels = useCallback(async (userId: string, models: ModelId[]) => {
    if (!token) return;

    const res = await fetch(`${apiUrl}/admin/usage/model-allowance`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId, models }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    setUsers((prev) =>
      prev.map((u) => (u.userId === userId ? { ...u, allowedModels: models } : u))
    );
  }, [token, apiUrl]);

  const fetchCognitoUsers = useCallback(() => {
    if (!token) return;

    if (cognitoAbortRef.current) {
      cognitoAbortRef.current.abort();
    }

    setCognitoLoading(true);
    setCognitoError(null);

    const controller = new AbortController();
    cognitoAbortRef.current = controller;

    fetch(`${apiUrl}/admin/users`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        setCognitoUsers(data.users);
      })
      .catch((err) => {
        if (err.name !== 'AbortError') {
          setCognitoError(err.message);
        }
      })
      .finally(() => {
        setCognitoLoading(false);
      });
  }, [token, apiUrl]);

  const createUser = useCallback(async (displayName: string, email: string, temporaryPassword: string) => {
    if (!token) return;

    const res = await fetch(`${apiUrl}/admin/users`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ displayName, email, temporaryPassword }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    const data = await res.json();
    if (data.user) {
      setCognitoUsers((prev) => [data.user as CognitoUser, ...prev]);
    }
  }, [token, apiUrl]);

  const deleteUser = useCallback(async (username: string) => {
    if (!token) return;

    const res = await fetch(`${apiUrl}/admin/users/${encodeURIComponent(username)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    setCognitoUsers((prev) => prev.filter((u) => u.username !== username));
  }, [token, apiUrl]);

  const toggleUserEnabled = useCallback(async (username: string, enable: boolean) => {
    if (!token) return;

    const res = await fetch(`${apiUrl}/admin/users/${encodeURIComponent(username)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: enable }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    setCognitoUsers((prev) => prev.map((u) => u.username === username ? { ...u, enabled: enable } : u));
  }, [token, apiUrl]);

  const renameUser = useCallback(async (username: string, displayName: string) => {
    if (!token) return;

    const res = await fetch(`${apiUrl}/admin/users/${encodeURIComponent(username)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      // `displayName` alone. The server refuses a body carrying both this and
      // `enabled`, because there is no transaction across the two Cognito calls
      // and a half-applied request would have no defined meaning.
      body: JSON.stringify({ displayName }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    setCognitoUsers((prev) => prev.map((u) =>
      u.username === username ? { ...u, displayName, displayNameSet: true } : u));
  }, [token, apiUrl]);

  useEffect(() => {
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
      if (cognitoAbortRef.current) {
        cognitoAbortRef.current.abort();
      }
    };
  }, []);

  /*
   * Fetch-and-return rather than fetch-into-state, unlike the two lists above.
   *
   * These are drilled into — a user, then one of their projects, then one of its
   * versions — and the caller is the only thing that knows which of those is on
   * screen. Holding them here would mean a second copy of that navigation state
   * in a hook that cannot see the panel.
   */
  /*
   * Each URL is written out at its own `fetch`, rather than passed as a string
   * into one helper.
   *
   * A helper reads better and is invisible to api-routes.test.mjs, which finds
   * calls by looking for a template literal starting at `fetch(`. Routing these
   * three through `getJSON(path)` made all three unverified in one move and the
   * test said so — the client call it could see was a bare PARAM with no path in
   * it. Three routes nothing checks is a worse trade than three repeated lines,
   * because the thing that goes wrong here is a path that no longer exists on
   * the server, and nothing else in the build would notice.
   */
  const authed = useCallback(async (res: Response) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }, []);
  const head = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const [groups, setGroups] = useState<UserGroup[]>([]);

  /**
   * What this deployment is configured to run, and where each value is set.
   *
   * Fetched on demand rather than with the usage rows: it is one screen's worth
   * of infrastructure, it does not change while somebody is reading it, and
   * asking for it costs a Parameter Store listing that the other three tabs have
   * no use for.
   */
  const fetchModelInventory = useCallback(async (period?: { from: string; to: string }): Promise<ModelInventory> => {
    if (!token) throw new Error('ログインが必要です');
    const query = period ? `?from=${period.from}&to=${period.to}` : '';
    const res = await fetch(`${apiUrl}/admin/models${query}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return res.json();
  }, [token, apiUrl]);

  const fetchGroups = useCallback(async () => {
    if (!token) return;
    const res = await fetch(`${apiUrl}/admin/groups`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    setGroups(Array.isArray(data.groups) ? data.groups : []);
  }, [token, apiUrl]);

  /*
   * Every write refetches rather than patching local state. A membership change
   * moves one account and can unseat a group's administrator at the same time —
   * two rows from one action — and reconstructing that here would be a second
   * implementation of a rule the server already holds.
   */
  const threw = useCallback(async (res: Response) => {
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
  }, []);

  const createGroup = useCallback(async (name: string, description?: string) => {
    if (!token) return;
    const res = await fetch(`${apiUrl}/admin/groups`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    await fetchGroups();
  }, [token, apiUrl, fetchGroups]);

  const deleteGroup = useCallback(async (name: string) => {
    if (!token) return;
    const res = await fetch(`${apiUrl}/admin/groups/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    await fetchGroups();
  }, [token, apiUrl, fetchGroups]);

  const setMembership = useCallback(async (username: string, group: string | null) => {
    // The URL is written out here rather than passed into a helper.
    // api-routes.test.mjs finds client calls by the literal after `fetch(`, and
    // a helper taking a path makes every route through it invisible to the only
    // check that the client and the server agree. It caught this one.
    await threw(await fetch(`${apiUrl}/admin/groups/membership`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, group }),
    }));
    await fetchGroups();
    await fetchCognitoUsers();
  }, [threw, token, apiUrl, fetchGroups, fetchCognitoUsers]);

  const setGroupAdmin = useCallback(async (group: string, username: string | null) => {
    await threw(await fetch(`${apiUrl}/admin/groups/admin`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ group, username }),
    }));
    await fetchGroups();
    await fetchCognitoUsers();
  }, [threw, token, apiUrl, fetchGroups, fetchCognitoUsers]);

  const fetchProjects = useCallback(async (userId: string): Promise<AdminProject[]> => {
    const data = await authed(
      await fetch(`${apiUrl}/admin/projects/${encodeURIComponent(userId)}`, { headers: head })
    );
    return data.projects ?? [];
  }, [apiUrl, head, authed]);

  const fetchProjectVersions = useCallback(async (userId: string, projectId: string): Promise<AdminVersion[]> => {
    const data = await authed(
      await fetch(
        `${apiUrl}/admin/projects/${encodeURIComponent(userId)}/${encodeURIComponent(projectId)}/versions`,
        { headers: head }
      )
    );
    return data.versions ?? [];
  }, [apiUrl, head, authed]);

  const fetchVersion = useCallback(async (userId: string, versionId: string): Promise<AdminVersion> =>
    authed(
      await fetch(`${apiUrl}/admin/versions/${encodeURIComponent(userId)}/${encodeURIComponent(versionId)}`, {
        headers: head,
      })
    ),
  [apiUrl, head, authed]);

  const setGroupLimit = useCallback(async (group: string, limit: number) => {
    if (!token) return;
    const res = await fetch(`${apiUrl}/admin/groups/limit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ group, limit }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    setGroups((prev) => prev.map((g) => (g.name === group ? { ...g, monthlyLimit: limit } : g)));
  }, [token, apiUrl]);

  return { fetchModelInventory, users, loading, error, isAdmin, fetchUsers, setUserLimit, setUserAllowedModels, setGroupLimit, cognitoUsers, cognitoLoading, cognitoError, fetchCognitoUsers, createUser, renameUser, deleteUser, toggleUserEnabled, fetchProjects, fetchProjectVersions, fetchVersion, groups, fetchGroups, createGroup, deleteGroup, setMembership, setGroupAdmin };
}
