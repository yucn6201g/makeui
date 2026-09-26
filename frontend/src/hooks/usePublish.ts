import { useState, useCallback, useRef, useEffect } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { requestErrorMessage } from '../utils/requests/request';

interface UsePublishReturn {
  url: string | null;
  isPublishing: boolean;
  error: string | null;
  /**
   * Publishes, and hands back the URL.
   *
   * It used to only set state. The one caller now copies the link to the
   * clipboard the moment it exists, and reading the URL out of a state update
   * means copying from an effect rather than from the click — outside the user
   * gesture the clipboard API wants, and one render after the value it needs.
   */
  publish: (html: string) => Promise<string | null>;
  reset: () => void;
}

/**
 * One document, one link.
 *
 * This carried a `pages` array, a `publishedPages` list and a separate
 * `siteUrl` for a navigation index. None of it was reachable: the caller
 * wrapped the single document as `[{ id: 'index', … }]` and always had, so the
 * index was never generated and the panel branch that listed per-page URLs
 * never rendered. Deleted rather than wired — wiring it needs a decision nobody
 * has made about what a "page" is, now that a project is a routed app rather
 * than a set of documents.
 */
export function usePublish(): UsePublishReturn {
  const { token } = useAuth();
  const [url, setUrl] = useState<string | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    setUrl(null);
    setError(null);
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const publish = useCallback(async (html: string): Promise<string | null> => {
    if (!token) {
      setError('ログインの有効期限が切れています。再度ログインしてください。');
      return null;
    }

    if (abortRef.current) abortRef.current.abort();
    setIsPublishing(true);
    setError(null);
    setUrl(null);

    const controller = new AbortController();
    abortRef.current = controller;
    const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:8080';

    return fetch(`${apiUrl}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      /*
       * The title is not sent. `shareDocument` has already written the project
       * name into the document as its tab title, and the server declared
       * `title?: string` and never read it — so it travelled the wire on every
       * publish to be dropped on arrival. A legacy static mock keeps whatever
       * title it was written with; that path does not go through the builder
       * and never got the name either way.
       */
      body: JSON.stringify({ html }),
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        const published: string | null = data.url ?? null;
        setUrl(published);
        return published;
      })
      .catch((err) => {
        if (err.name !== 'AbortError') setError(requestErrorMessage(err, '公開に失敗しました。もう一度お試しください。'));
        return null;
      })
      .finally(() => setIsPublishing(false));
  }, [token]);

  useEffect(() => {
    return () => { if (abortRef.current) abortRef.current.abort(); };
  }, []);

  return { url, isPublishing, error, publish, reset };
}
