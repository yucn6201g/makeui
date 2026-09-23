import type { ScoreParts } from './useGenerate';
import { useCallback, useRef, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';

interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  score?: number;
  toolsUsed?: string[];
  tokenUsage?: { inputTokens: number; outputTokens: number };
  /**
   * Which model and design system produced the reply.
   *
   * Deliberately part of what is stored: the point of recording it is that the
   * thread can still say what built each screen tomorrow. The `html` is not
   * stored — it is the one field big enough to matter against the item ceiling,
   * and the project keeps the current document anyway.
   */
  /**
   * What produced the reply.
   *
   * `effort` and `scoreVerified` were in the message and not in here, so both
   * were dropped on save — and `scoreVerified` does not merely vanish. The score
   * chip reads `=== false` to mark a score as static-only; reading `undefined`
   * after a reload takes that branch away, and an unverified score is then shown
   * with 「ブラウザ実行の計測を含むスコアです」. A missing chip is a gap; this was a
   * wrong claim about a number the user is asked to compare.
   */
  runInfo?: { modelTier: string; preset: string; effort?: string; scoreVerified?: boolean; scoreParts?: ScoreParts };
  /**
   * A plan awaiting approval, with the specification it was derived from.
   *
   * Not stored, so reopening the project removed the 「このプランで作成」 button and
   * the spec behind it: the plan that had been reviewed could no longer be
   * built, and re-running the design phase to get another is the cost this
   * carries the spec to avoid.
   */
  proposal?: { plan: string; spec: string; prompt: string };
  /**
   * The run that produced the reply, step by step.
   *
   * Stored, and the server was already built for it: `saveChatMessages` drops
   * transcripts from the oldest replies first when the item would exceed the
   * DynamoDB ceiling, precisely so a long thread loses its working before it
   * loses its history. That loop could never run — the allow-list below removed
   * `phases` on the way out, so nothing carrying one ever reached the server.
   */
  phases?: unknown[];
  timestamp: number;
}

interface UseChatHistoryReturn {
  loadMessages: (projectId: string) => Promise<StoredMessage[] | null>;
  saveMessages: (projectId: string, messages: StoredMessage[]) => void;
  /** True once a save has failed and been retried without landing. */
  saveFailed: boolean;
}

export function useChatHistory(): UseChatHistoryReturn {
  const { token } = useAuth();
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<{ projectId: string; messages: StoredMessage[] } | null>(null);

  const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:8080';

  /**
   * Whether the last save is known to have failed.
   *
   * Surfaced rather than kept, because the thread is the only copy: a save that
   * does not land means the conversation on screen exists nowhere else, and the
   * moment to say so is before the tab is closed.
   */
  const [saveFailed, setSaveFailed] = useState(false);
  const retryRef = useRef(0);

  const flush = useCallback(() => {
    if (!pendingRef.current || !token) return;
    const { projectId, messages } = pendingRef.current;

    /*
     * An allow-list, so anything new has to be added here on purpose.
     *
     * That is the right default — `html` is a whole document per message and
     * must not be stored — but it is also silent: a field added to the message
     * simply never arrives, and the loss only shows after a reload. `runInfo`
     * was exactly that case, and then `phases` was, for longer: the server had
     * been given its own handling for transcripts — dropping them from the
     * oldest replies before cutting the thread — and never received one.
     *
     * `chat-history-fields.test.mjs` now reads this list against the server's
     * `StoredMessage`, because a comment saying "add it here on purpose" did not
     * stop the second occurrence.
     */
    const stripped = messages.map(({ id, role, content, score, toolsUsed, tokenUsage, runInfo, phases, proposal, timestamp }) => ({
      id, role, content, score, toolsUsed, tokenUsage, runInfo, phases, proposal, timestamp,
    }));

    /*
     * `res.ok` is checked, and the payload is held until it lands.
     *
     * This was `.catch(() => {})` over a fetch whose result nobody read, with
     * `pendingRef` cleared before the request went out. So a rejected request
     * lost the thread with nothing left to retry from — and an HTTP error did
     * not even reach the catch, because a 4xx or 5xx RESOLVES. The rate limiter
     * answers 429 and the ledger guard answers 503; both were silently
     * discarding conversations.
     */
    fetch(`${apiUrl}/projects/${encodeURIComponent(projectId)}/messages`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: stripped }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        pendingRef.current = null;
        retryRef.current = 0;
        setSaveFailed(false);
      })
      .catch((e) => {
        // One retry, then say so. Retrying forever would hide a thread that is
        // never going to save behind a spinner nobody is watching.
        if (retryRef.current < 1) {
          retryRef.current += 1;
          saveTimerRef.current = setTimeout(flushRef.current, 4000);
          return;
        }
        console.warn('チャット履歴を保存できませんでした', e);
        setSaveFailed(true);
      });
  }, [token, apiUrl]);

  // The retry re-enters `flush`, which is redefined on every token change; a
  // direct reference would capture the one that was current when it was queued.
  const flushRef = useRef(flush);
  useEffect(() => { flushRef.current = flush; }, [flush]);

  const saveMessages = useCallback((projectId: string, messages: StoredMessage[]) => {
    pendingRef.current = { projectId, messages };
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(flush, 2000);
  }, [flush]);

  /**
   * The stored thread, or `null` when it could not be read.
   *
   * The distinction is the whole point, and its absence destroyed threads. This
   * returned `[]` for both "this project has no messages" and "the request
   * failed", the caller took that as an empty conversation, and the next message
   * sent saved a thread of one over a thread of forty. Every step was silent:
   * no error, no empty state, just a conversation that had been there a moment
   * ago.
   */
  const loadMessages = useCallback(async (projectId: string): Promise<StoredMessage[] | null> => {
    if (!token) return null;
    try {
      const res = await fetch(`${apiUrl}/projects/${encodeURIComponent(projectId)}/messages`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      const data = await res.json();
      return Array.isArray(data.messages) ? data.messages : [];
    } catch {
      return null;
    }
  }, [token, apiUrl]);

  /*
   * The same shape that cost `useDirectEdit` 257 writes in 24 seconds: a cleanup
   * that ACTS, in an effect whose dependencies can change. Every change runs the
   * cleanup, so every change sends the thread again.
   *
   * Here it is latent rather than live — `flush` depends only on `token` and
   * `apiUrl`, so it re-ran on a token refresh and on StrictMode's second mount,
   * and the log shows at most three chat saves in a session against 257 version
   * saves in one. Fixed the same way regardless, because "the dependency happens
   * to be stable today" is not a property anyone can see from here.
   *
   * `flushRef` already exists for the retry. `pendingRef` is deliberately NOT
   * cleared before the write — unlike the hand-edit flush, this one holds the
   * payload until the request lands so a failure has something to retry from.
   */
  useEffect(() => () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    flushRef.current();
  }, []);

  return { loadMessages, saveMessages, saveFailed };
}
