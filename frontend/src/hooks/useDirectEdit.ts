import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { applyStyleEdit, applyTextEdit, isReactDocument } from '../utils/directEdit';
import { applyFileEdit } from '../utils/sourceEdit';

/**
 * Holds edits the user made by hand, and saves them without a generation.
 *
 * The document is updated in state first and written to the server after a
 * pause. That order is the point: dragging a colour picker produces a change on
 * every frame, and a save per frame would be both a flood of writes and a
 * version history nobody can read. The preview follows the pointer; the record
 * follows the user stopping.
 *
 * `edited` takes precedence over generated output while it exists, and is
 * cleared whenever a new document arrives from anywhere else — a generation, an
 * edit through the chat, a version restored from history. Without that, a hand
 * edit would silently mask the result the user just asked for.
 */

/** How long the user must pause before an edit becomes a version. */
const SAVE_DEBOUNCE_MS = 1200;

export interface UseDirectEditOptions {
  /** The document as it stands, before any hand edits. */
  baseHtml: string | null;
  projectId?: string;
  preset?: string;
  /** Carried onto the saved version; see the note on the server route. */
  score?: number;
  /** Changes to any of these mean a new document arrived and edits no longer apply. */
  resetKey: unknown;
  /**
   * Called once a hand edit has been stored as a version.
   *
   * The write always happened; nothing was told about it. So the version list
   * still ended at the document as it stood before the edit, and 「現在の状態」
   * was the only way back to what was on screen — which made that row look like
   * a different thing from the newest version rather than the same one.
   */
  onSaved?: () => void;
}

export interface UseDirectEditReturn {
  /** The edited document, or null when nothing has been edited. */
  edited: string | null;
  /** Whether text editing is possible for this document at all. */
  canEditText: boolean;
  editStyle: (selector: string, property: string, value: string) => void;
  editText: (selector: string, text: string) => void;
  /** Replaces one source file's contents. Ignored for files that cannot be saved. */
  /** True when the edit was applied; false for a file the document cannot store. */
  editSource: (path: string, content: string) => boolean;
  /** 'saving' while a write is in flight, 'saved' briefly after, null otherwise. */
  status: 'saving' | 'saved' | 'error' | null;
  /**
   * Why the last write failed, in the user's language, or null.
   *
   * Separate from `status` because 「保存に失敗しました」 answers neither of the
   * two questions somebody asks at that moment: whether their work is gone, and
   * whether trying again is worth anything. A throttled table and a rejected
   * document need different answers to the second.
   */
  error: string | null;
  /**
   * Writes the current edit again.
   *
   * The document is still in `edited`, so a retry is the same request with
   * nothing lost — which is the whole reason to offer one rather than a message.
   */
  retry: () => void;
  /** Discards every hand edit and returns to the generated document. */
  revertAll: () => void;
}

export function useDirectEdit(options: UseDirectEditOptions): UseDirectEditReturn {
  const { baseHtml, projectId, preset, score, resetKey, onSaved } = options;
  const { token } = useAuth();
  const [edited, setEdited] = useState<string | null>(null);
  const [status, setStatus] = useState<'saving' | 'saved' | 'error' | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The document the last failed write was carrying, so `retry` has something to send. */
  const unsaved = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<string | null>(null);

  // A new document from anywhere else replaces the edits rather than hiding
  // behind them.
  useEffect(() => {
    setEdited(null);
    setStatus(null);
    setError(null);
    unsaved.current = null;
    pending.current = null;
    if (timer.current) clearTimeout(timer.current);
  }, [resetKey]);

  const save = useCallback(
    async (html: string) => {
      if (!token) return;
      setStatus('saving');
      try {
        const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:8080';
        const res = await fetch(`${apiUrl}/versions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ html, projectId, preset, score, note: '直接編集' }),
        });
        if (!res.ok) throw new Error(String(res.status));
        unsaved.current = null;
        setError(null);
        setStatus('saved');
        onSaved?.();
        // The confirmation is transient on purpose: a permanent "saved" badge
        // stops meaning anything, and the next edit is about to move it anyway.
        setTimeout(() => setStatus((s) => (s === 'saved' ? null : s)), 1600);
      } catch (e) {
        /*
         * What the codes mean here, and why they are told apart.
         *
         * 500 is what a DynamoDB throughput burst arrives as — measured on
         * 2026-09-02, sixty-five of them inside one minute, every one a hand
         * edit that was not stored. It clears on its own, so "try again" is
         * true advice. 413 is the document being too large for the row, which
         * will be just as large next time. Anything else is unclassified and
         * says so rather than guessing.
         */
        const code = Number((e as Error).message);
        unsaved.current = html;
        setError(
          code === 413
            ? 'この文書は保存できる大きさを超えています。編集は画面に残っていますが、保存されていません。'
            : code >= 500 || code === 429
              ? '保存が混み合って失敗しました。編集は画面に残っています。もう一度お試しください。'
              : '保存に失敗しました。編集は画面に残っていますが、保存されていません。'
        );
        setStatus('error');
      }
    },
    [token, projectId, preset, score, onSaved]
  );

  /*
   * Not the debounced path. A retry is a person pressing a button, and putting
   * it through the 1200ms pause would make the button look broken for a second
   * and then work.
   */
  const retry = useCallback(() => {
    const html = unsaved.current;
    if (html) save(html);
  }, [save]);

  const schedule = useCallback(
    (html: string) => {
      pending.current = html;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const next = pending.current;
        pending.current = null;
        if (next) void save(next);
      }, SAVE_DEBOUNCE_MS);
    },
    [save]
  );

  /*
   * An edit still in the debounce window when the component goes away would be
   * lost silently. Flush it instead — on unmount, and only on unmount.
   *
   * This effect depended on `save`. `save` depends on `onSaved`, which the
   * workspace passes as an inline arrow, so its identity changed on every
   * render — and an effect whose dependencies change runs its CLEANUP. The
   * cleanup saved `pending.current` and never cleared it, so the next render
   * saved the same document again, and `save` renders (a status change, and
   * `onSaved` refetching the version list), so each save caused the next.
   *
   * It also cancelled the debounce timer on every render without re-arming it,
   * which removed the one thing that would have cleared `pending.current` and
   * stopped the loop.
   *
   * Measured on 2026-09-02: 257 saves of a 105KB document in 24 seconds, 26MB
   * written, of which 65 came back throttled — 「Throughput exceeds the current
   * capacity of your table」 on POST /versions, one hot partition key. Those 65
   * are the hand edits the save-failure bar was later built to report; this is
   * why there were sixty-five of them.
   *
   * `saveRef` keeps the flush current without making it a dependency, and
   * `pending` is cleared before the write so a second flush has nothing to send.
   */
  const saveRef = useRef(save);
  useEffect(() => { saveRef.current = save; }, [save]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    const last = pending.current;
    pending.current = null;
    if (last) void saveRef.current(last);
  }, []);

  const current = edited ?? baseHtml;

  const editStyle = useCallback(
    (selector: string, property: string, value: string) => {
      if (!current) return;
      const next = applyStyleEdit(current, { selector, property, value });
      if (next === current) return;
      setEdited(next);
      schedule(next);
    },
    [current, schedule]
  );

  const editText = useCallback(
    (selector: string, text: string) => {
      if (!current) return;
      const result = applyTextEdit(current, selector, text);
      if (!result.applied) return;
      setEdited(result.html);
      schedule(result.html);
    },
    [current, schedule]
  );

  /**
   * A whole file, replaced.
   *
   * Same layer and the same debounced save as the inspector's edits, so a colour
   * changed by clicking and a colour changed by typing are one history rather
   * than two that overwrite each other. `applyFileEdit` returns null for a file
   * the document cannot store, and that is dropped here rather than silently
   * appearing to work.
   */
  const editSource = useCallback(
    (path: string, content: string): boolean => {
      if (!current) return false;
      const next = applyFileEdit(current, path, content);
      /*
       * Whether the edit landed, reported rather than assumed.
       *
       * This returned nothing, and the structural controls above it took that
       * as success — so a file the document cannot store made the button do
       * nothing and say nothing, which is the failure this panel's own notes
       * exist to prevent. `applyFileEdit` already refuses on purpose; the
       * refusal just had nowhere to go.
       */
      if (next === null || next === current) return false;
      setEdited(next);
      schedule(next);
      return true;
    },
    [current, schedule]
  );

  const revertAll = useCallback(() => {
    if (!baseHtml) return;
    setEdited(null);
    schedule(baseHtml);
  }, [baseHtml, schedule]);

  return {
    edited,
    canEditText: Boolean(current) && !isReactDocument(current ?? ''),
    editStyle,
    editText,
    editSource,
    status,
    error,
    retry,
    revertAll,
  };
}
