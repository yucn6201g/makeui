import { useState, useCallback } from 'react';
import { requestErrorMessage } from '../utils/requests/request';
import { useAuth } from '../auth/AuthProvider';
import { TransientPreviewError } from '../utils/preview/previewFetch';

export interface Project {
  projectId: string;
  userId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /**
   * The document, when the server sent one.
   *
   * The list does not: `GET /projects` answers `hasDocument` instead, and the
   * card fetches its own when it comes near the viewport. Present on a project
   * opened through `getProject`, and on one just generated in this session.
   */
  lastHtml?: string;
  /** Whether a document exists to fetch. The list's answer in place of one. */
  hasDocument?: boolean;
  preset?: string;
  model?: string;
  /** Set by the job that produced the project's latest document. */
  /** 'html' only on projects predating the project formats; nothing emits it now. */
  outputKind?: 'html' | 'react' | 'vue';
  /** Cumulative across every generation and edit run against this project. */
  totalTokens?: number;
  requestCount?: number;
  /** When the project was archived; absent means it is not. */
  archivedAt?: string;
  /** When the project was favourited; absent means it is not. */
  favouritedAt?: string;
  /** While the project has any share, when the first was made. Puts it on the 共有 tab. */
  sharedAt?: string;
  /**
   * This account's relation to the project, from the server's list.
   *
   * `owner` for its own; for one shared with it, the role it was given and who
   * owns it. Absent on a project created in this session before the list is
   * refetched, which is always the caller's own.
   */
  access?: ProjectAccess;
}

export type ProjectRole = 'owner' | 'full' | 'edit' | 'view';
export interface ProjectAccess {
  role: ProjectRole;
  ownerId: string;
  ownerName: string;
  /** 'group' when the project reached this account through its user group. */
  via?: 'user' | 'group';
}

export function useProjects() {
  const { token } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:8080';

  const fetchProjects = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiUrl}/projects`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed to fetch projects');
      const data = await res.json();
      setProjects(data.projects ?? []);
    } catch (e) {
      setError(requestErrorMessage(e, 'プロジェクトを読み込めませんでした。'));
    } finally {
      setLoading(false);
    }
  }, [apiUrl, token]);

  const createProject = useCallback(async (name: string): Promise<Project | null> => {
    if (!token) {
      setError('認証トークンが取得できません。ページを再読み込みしてください。');
      return null;
    }
    setError(null);
    try {
      const res = await fetch(`${apiUrl}/projects`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `プロジェクト作成失敗 (HTTP ${res.status})`);
      }
      const project: Project = await res.json();
      if (!project.projectId) {
        throw new Error('サーバーから不正なレスポンスが返されました');
      }
      setProjects((prev) => [project, ...prev]);
      return project;
    } catch (e) {
      const msg = requestErrorMessage(e, 'プロジェクトを作成できませんでした。');
      console.error('createProject failed:', msg);
      setError(msg);
      return null;
    }
  }, [apiUrl, token]);

  const updateProject = useCallback(async (projectId: string, updates: { name?: string; lastHtml?: string; preset?: string; model?: string }) => {
    if (!token) return;
    try {
      const res = await fetch(`${apiUrl}/projects/${projectId}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `プロジェクト更新失敗 (HTTP ${res.status})`);
      }
      setProjects((prev) =>
        prev.map((p) => (p.projectId === projectId ? { ...p, ...updates, updatedAt: new Date().toISOString() } : p))
      );
    } catch (e) {
      setError(requestErrorMessage(e, 'プロジェクトの更新に失敗しました'));
    }
  }, [apiUrl, token]);

  /**
   * Last-resort preview lookup for a project with no stored `lastHtml`.
   *
   * That field is only written while the browser is watching a run, so a job
   * that finished after the user navigated away leaves the project looking
   * empty. The document the job wrote to version history is authoritative.
   *
   * It answers with the document, `null` when there is none,
   * or a thrown `TransientPreviewError` when asking again may work.
   *
   * These used to be one answer. Every failure came back as `null`, which the
   * card reads as "nothing to draw" and settles on 「プレビューを生成できません
   * でした」 for good. Measured over a week: every 5xx the API returned was a
   * Lambda throttle (2, 3, 2, 0, 3, 19 a day, matching Throttles exactly) — the
   * account runs ten concurrent executions, and a list of cards asks at once.
   * A reload worked because the second burst was smaller.
   */
  const fetchProjectPreview = useCallback(async (projectId: string): Promise<string | null> => {
    if (!token) return null;
    let res: Response;
    try {
      res = await fetch(`${apiUrl}/projects/${projectId}/preview`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      throw new TransientPreviewError('network');
    }
    if (res.status === 429 || res.status >= 500) throw new TransientPreviewError(String(res.status));
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return data && typeof data.html === 'string' && data.html ? data.html : null;
  }, [apiUrl, token]);

  /**
   * Move a project into the archive, or bring it back.
   *
   * Optimistic, like the delete below it, because the list is the only thing
   * that changes and a failed request puts it back by refetching. The archive
   * is the step that makes deletion deliberate, so it has to feel free.
   */
  const archiveProject = useCallback(async (projectId: string, archived: boolean) => {
    if (!token) return;
    const at = new Date().toISOString();
    setProjects((prev) =>
      prev.map((p) =>
        p.projectId === projectId
          // The star goes with it, the way the server clears it: an archived
          // favourite would be a project marked as wanted and put away.
          ? { ...p, archivedAt: archived ? at : undefined, favouritedAt: archived ? undefined : p.favouritedAt }
          : p
      )
    );
    try {
      const res = await fetch(`${apiUrl}/projects/${projectId}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived }),
      });
      if (!res.ok) {
        setError(archived ? 'アーカイブに失敗しました' : '復元に失敗しました');
        fetchProjects();
      }
    } catch {
      setError(archived ? 'アーカイブに失敗しました' : '復元に失敗しました');
      fetchProjects();
    }
  }, [apiUrl, token, fetchProjects]);

  /** Star a project, or take the star off. Archived projects cannot be starred. */
  const favouriteProject = useCallback(async (projectId: string, favourite: boolean) => {
    if (!token) return;
    const at = new Date().toISOString();
    setProjects((prev) =>
      prev.map((p) => (p.projectId === projectId ? { ...p, favouritedAt: favourite ? at : undefined } : p))
    );
    try {
      const res = await fetch(`${apiUrl}/projects/${projectId}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ favourite }),
      });
      if (!res.ok) {
        setError('お気に入りの更新に失敗しました');
        fetchProjects();
      }
    } catch {
      setError('お気に入りの更新に失敗しました');
      fetchProjects();
    }
  }, [apiUrl, token, fetchProjects]);

  const deleteProject = useCallback(async (projectId: string) => {
    if (!token) return;
    setProjects((prev) => prev.filter((p) => p.projectId !== projectId));
    try {
      const res = await fetch(`${apiUrl}/projects/${projectId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        // 409 is the server refusing to destroy a project that was never
        // archived. Saying so is better than a silent reappearance.
        setError(res.status === 409 ? 'アーカイブしてから削除してください' : '削除に失敗しました');
        fetchProjects();
      }
    } catch {
      setError('削除に失敗しました');
      fetchProjects();
    }
  }, [apiUrl, token, fetchProjects]);

  /**
   * The same operations on several projects at once.
   *
   * Over the per-project routes rather than a new bulk endpoint, on purpose. The
   * server's rules live on those routes — a DELETE is refused with 409 unless the
   * project was archived first, and deleting takes the stored document and the
   * chat thread with it — and a second endpoint would be a second copy of them
   * to keep in step.
   *
   * Bounded, because the unbounded version of this has already happened here:
   * 257 writes in 24 seconds on one user's partition key throttled DynamoDB on
   * 2026-09-02 and produced sixty 500s. A user selecting all of fifty projects
   * would fire fifty requests at that same partition. Four at a time finishes a
   * normal selection in well under a second and cannot burst.
   *
   * Optimistic for all of them, then reconciled: a failure anywhere refetches, so
   * the list shows what the server holds rather than what was hoped for, and the
   * error says how many did not go through rather than that "something" failed.
   */
  const runBounded = useCallback(async (ids: string[], one: (id: string) => Promise<boolean>) => {
    const CONCURRENCY = 4;
    let failed = 0;
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const id = ids[next++];
        try {
          if (!(await one(id))) failed += 1;
        } catch {
          failed += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
    return failed;
  }, []);

  const archiveProjects = useCallback(async (projectIds: string[], archived: boolean) => {
    if (!token || projectIds.length === 0) return 0;
    const ids = new Set(projectIds);
    const at = new Date().toISOString();
    setProjects((prev) =>
      prev.map((p) =>
        ids.has(p.projectId)
          ? { ...p, archivedAt: archived ? at : undefined, favouritedAt: archived ? undefined : p.favouritedAt }
          : p
      )
    );
    const failed = await runBounded(projectIds, async (id) => {
      const res = await fetch(`${apiUrl}/projects/${id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived }),
      });
      return res.ok;
    });
    if (failed > 0) {
      setError(`${projectIds.length}件のうち${failed}件を${archived ? 'アーカイブ' : '復元'}できませんでした`);
      fetchProjects();
    }
    return failed;
  }, [apiUrl, token, fetchProjects, runBounded]);

  const deleteProjects = useCallback(async (projectIds: string[]) => {
    if (!token || projectIds.length === 0) return 0;
    const ids = new Set(projectIds);
    setProjects((prev) => prev.filter((p) => !ids.has(p.projectId)));
    let refused = 0;
    const failed = await runBounded(projectIds, async (id) => {
      const res = await fetch(`${apiUrl}/projects/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      // 409 is the server refusing a project that was never archived — counted
      // apart, because it names a different thing for the person to do.
      if (res.status === 409) refused += 1;
      return res.ok;
    });
    if (failed > 0) {
      setError(
        refused > 0
          ? `${refused}件はアーカイブされていないため削除できませんでした`
          : `${projectIds.length}件のうち${failed}件を削除できませんでした`
      );
      fetchProjects();
    }
    return failed;
  }, [apiUrl, token, fetchProjects, runBounded]);

  return { projects, loading, error, fetchProjects, createProject, updateProject, archiveProject, archiveProjects, favouriteProject, deleteProject, deleteProjects, fetchProjectPreview };
}
