import { useState, useCallback, useRef } from 'react';
import { useAuth } from '../auth/AuthProvider';

export interface Refinement {
  /** The rewritten brief, ready to replace what is in the composer. */
  prompt: string;
  /** What the rewrite added or made explicit, one short line each. */
  notes: string[];
}

interface UseRefinePromptReturn {
  refinement: Refinement | null;
  refining: boolean;
  /** Set when the call failed, or when there was nothing to suggest. */
  message: string | null;
  refine: (prompt: string) => Promise<void>;
  /** Drop the suggestion — after accepting it, or on dismissal. */
  clear: () => void;
}

/**
 * Asks the server to rewrite the brief in the composer.
 *
 * The suggestion is held here rather than applied: the composer shows it, and
 * the user chooses. A rewrite that replaced the text in the box would be a UI
 * arriving with screens nobody asked for and no way to see where they came from.
 *
 * 204 is the "already specific enough" answer and is not an error. It is worth
 * saying out loud — a button that appears to do nothing is one people press
 * twice and then stop pressing.
 */
export function useRefinePrompt(): UseRefinePromptReturn {
  const { token } = useAuth();
  const [refinement, setRefinement] = useState<Refinement | null>(null);
  const [refining, setRefining] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const clear = useCallback(() => {
    setRefinement(null);
    setMessage(null);
  }, []);

  const refine = useCallback(async (prompt: string) => {
    if (!token || !prompt.trim()) return;
    // A second press while the first is in flight replaces it rather than
    // racing it — the later text is the one the user means.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setRefining(true);
    setRefinement(null);
    setMessage(null);
    const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:8080';
    try {
      const res = await fetch(`${apiUrl}/refine-prompt`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
        signal: controller.signal,
      });
      if (res.status === 204) {
        setMessage('この依頼文は既に具体的です。補える点は見つかりませんでした。');
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (typeof data.prompt === 'string' && data.prompt.trim()) {
        setRefinement({ prompt: data.prompt, notes: Array.isArray(data.notes) ? data.notes : [] });
      } else {
        setMessage('添削結果を受け取れませんでした。');
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setMessage((e as Error).message || '添削に失敗しました');
    } finally {
      if (!controller.signal.aborted) setRefining(false);
    }
  }, [token]);

  return { refinement, refining, message, refine, clear };
}
