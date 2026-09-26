import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import type { ProjectRole } from './useProjects';
import type { ShareRole } from '../utils/projects/shareRoles';
import { requestErrorMessage } from '../utils/requests/request';

/** One grant on a project, as `GET /projects/:id/shares` returns it. */
export interface ShareGrant {
  type: 'user' | 'group';
  id: string;
  label: string;
  email?: string;
  role: ShareRole;
  grantedByName: string;
  grantedAt: string;
}

export interface ShareCandidate {
  type: 'user' | 'group';
  id: string;
  label: string;
  /** A user's email, or a group's member count as text. */
  detail: string;
}

interface SharesState {
  role: ProjectRole | null;
  self: string | null;
  owner: { userId: string; name: string } | null;
  shares: ShareGrant[];
}

/**
 * A project's members: who it is shared with, finding more, and changing either.
 *
 * Loaded when the share panel opens, not with the project — most visits never
 * open it. Every change answers with the whole list, which replaces what is
 * shown, so the panel never shows a state the server did not.
 */
export function useShares(projectId: string | undefined, open: boolean) {
  const { token } = useAuth();
  const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:8080';
  const [state, setState] = useState<SharesState>({ role: null, self: null, owner: null, shares: [] });
  const [groups, setGroups] = useState<{ name: string; memberCount: number }[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * Each request is written out with its path, rather than through one helper
   * taking a path: api-routes.test.mjs reads the client's `fetch(` literals to
   * prove every path it calls is served, and a variable path is invisible to it.
   */
  const headers = useCallback(() => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }), [token]);
  const answer = async (res: Response) => {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
    return body;
  };

  const refresh = useCallback(async () => {
    if (!projectId || !token) return;
    setLoading(true);
    setError(null);
    try {
      const [data, g] = await Promise.all([
        fetch(`${apiUrl}/projects/${encodeURIComponent(projectId)}/shares`, { headers: headers() }).then(answer),
        fetch(`${apiUrl}/share-groups`, { headers: headers() }).then(answer).catch(() => ({ groups: [] })),
      ]);
      setState({ role: data.role ?? null, self: data.self ?? null, owner: data.owner ?? null, shares: data.shares ?? [] });
      setGroups(g.groups ?? []);
    } catch (e) {
      setError(requestErrorMessage(e, '共有の情報を読み込めませんでした'));
    } finally {
      setLoading(false);
    }
  }, [projectId, token, apiUrl, headers]);

  useEffect(() => { if (open) void refresh(); }, [open, refresh]);

  const grant = useCallback(async (target: Pick<ShareCandidate, 'type' | 'id'>, role: ShareRole): Promise<boolean> => {
    if (!projectId) return false;
    setBusy(true);
    setError(null);
    try {
      const data = await fetch(`${apiUrl}/projects/${encodeURIComponent(projectId)}/shares`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify({ type: target.type, id: target.id, role }),
      }).then(answer);
      setState((s) => ({ ...s, shares: data.shares ?? s.shares }));
      return true;
    } catch (e) {
      setError(requestErrorMessage(e, '共有できませんでした'));
      return false;
    } finally {
      setBusy(false);
    }
  }, [projectId, apiUrl, headers]);

  const revoke = useCallback(async (target: Pick<ShareGrant, 'type' | 'id'>): Promise<boolean> => {
    if (!projectId) return false;
    setBusy(true);
    setError(null);
    try {
      const data = await fetch(
        `${apiUrl}/projects/${encodeURIComponent(projectId)}/shares/${target.type}/${encodeURIComponent(target.id)}`,
        { method: 'DELETE', headers: headers() }
      ).then(answer);
      setState((s) => ({ ...s, shares: data.shares ?? s.shares }));
      return true;
    } catch (e) {
      setError(requestErrorMessage(e, '共有を解除できませんでした'));
      return false;
    } finally {
      setBusy(false);
    }
  }, [projectId, apiUrl, headers]);

  /*
   * Searching: users from the directory by name or email, groups from the list
   * already loaded. Debounced, and a stale answer never replaces a newer one.
   */
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<ShareCandidate[]>([]);
  const seq = useRef(0);
  useEffect(() => {
    const q = query.trim();
    const mine = ++seq.current;
    if (q.length < 2) { setCandidates([]); return; }
    const lower = q.toLowerCase();
    const groupHits: ShareCandidate[] = groups
      .filter((g) => g.name.toLowerCase().includes(lower))
      .map((g) => ({ type: 'group', id: g.name, label: g.name, detail: `グループ・${g.memberCount}人` }));
    const timer = setTimeout(async () => {
      try {
        const search = `?q=${encodeURIComponent(q)}`;
        const data = await fetch(`${apiUrl}/users/search${search}`, { headers: headers() }).then(answer);
        if (mine !== seq.current) return;
        const users: ShareCandidate[] = (data.users ?? []).map((u: { userId: string; name: string; email: string }) => ({
          type: 'user', id: u.userId, label: u.name, detail: u.email,
        }));
        setCandidates([...groupHits, ...users]);
      } catch {
        if (mine === seq.current) setCandidates(groupHits);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query, groups, apiUrl, headers]);

  return { ...state, groups, loading, busy, error, refresh, grant, revoke, query, setQuery, candidates };
}
