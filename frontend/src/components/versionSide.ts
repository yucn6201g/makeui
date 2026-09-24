import { useCallback, useEffect, useRef, useState } from 'react';
import { requestErrorMessage } from '../utils/request';

/**
 * One half of the comparison: which version it is showing, and its document.
 *
 * Both halves used to be different things — the left was a stored version fetched
 * on demand, the right was always the live document — so only one of them could
 * be chosen. Comparing two stored versions, which is what you want the moment a
 * regression is a few runs old, was not expressible at all.
 *
 * They are the same thing now, and this is that thing. `''` is no longer a
 * choice — the live document is the newest version, and the menu lists it under
 * that name — so it means only "nothing picked yet", which lasts from the first
 * render to the effect that picks. `liveHtml` is what fills that gap, and it
 * fills it correctly for the same reason: it IS the newest version.
 */
export interface VersionSide {
  /** A stored version's id, or `''` in the moment before either side has picked. */
  versionId: string;
  html: string | null;
  loading: boolean;
  error: string | null;
}

/**
 * There is no initial version, only a selection.
 *
 * This took an `initialVersionId`, which set the id without the request that
 * fills it — so a side could open naming a version it had never fetched, with a
 * null document, and the caller's own effect to fetch it was guarded by the id
 * already being set. It never ran. Choosing is the only way in now, which is
 * what makes the id and the document impossible to disagree.
 */
export function useVersionSide(
  apiUrl: string,
  token: string,
  liveHtml: string | null,
  /** The project the versions belong to — a shared project's are in its owner's partition. */
  projectId?: string
): { side: VersionSide; select: (versionId: string) => void } {
  const [versionId, setVersionId] = useState('');
  const [fetched, setFetched] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const select = useCallback(async (id: string) => {
    setVersionId(id);
    setError(null);
    abortRef.current?.abort();

    if (!id) {
      // The live document needs no request; it is already here.
      setFetched(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    try {
      const res = await fetch(`${apiUrl}/versions/${encodeURIComponent(id)}${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setFetched(data.html ?? null);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(requestErrorMessage(err, '読み込みに失敗しました'));
      setFetched(null);
    } finally {
      if (abortRef.current === controller) setLoading(false);
    }
  }, [apiUrl, token, projectId]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return {
    side: {
      versionId,
      html: versionId ? fetched : liveHtml,
      loading,
      error,
    },
    select: (id: string) => { void select(id); },
  };
}
