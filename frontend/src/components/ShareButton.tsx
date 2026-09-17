import { useEffect, useRef, useState } from 'react';
import { usePublish } from '../hooks/usePublish';
import { shareDocument } from '../utils/shareDocument';
import { buildReactPreview } from '../utils/reactPreview';

/**
 * One click: build, publish, and put the link on the clipboard.
 *
 * This was a panel — a button that revealed a second button that produced a URL
 * in a field with a third button to copy it. Three clicks and a popover for an
 * action with exactly one outcome. Nobody opens a share panel to read a URL;
 * they open it to send one somewhere else, and the clipboard is where it has to
 * be for that.
 *
 * The copy is attempted after two awaits, so it can land outside the click's
 * transient activation and be refused. That is why the URL is kept: a refused
 * copy falls back to showing it rather than losing a link that was published
 * either way, and publishing again would spend another upload for the same
 * document.
 */
export function ShareButton({ html, title }: { html: string | null; title?: string }) {
  const { isPublishing, error, publish } = usePublish();
  const [phase, setPhase] = useState<'idle' | 'working' | 'copied' | 'failed'>('idle');
  /** Set only when the clipboard refused, so the link can still be taken by hand. */
  const [manualUrl, setManualUrl] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  /* Selected on arrival: the fallback exists to be copied by hand, and the hand
     part should be one keystroke rather than a drag across a long URL. */
  useEffect(() => {
    if (manualUrl) inputRef.current?.select();
  }, [manualUrl]);

  const settle = (next: 'copied' | 'failed') => {
    setPhase(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setPhase('idle'), 2500);
  };

  const handleClick = async () => {
    if (!html || phase === 'working') return;
    setPhase('working');
    setManualUrl(null);
    setProblem(null);

    // Diagnostics off: the overlay is a development aid, and a red panel of
    // Japanese stack trace over a link someone has already sent is not one.
    const doc = await shareDocument(html, (files) => buildReactPreview(files, { diagnostics: false }), title);
    if (doc.error || !doc.html) {
      setProblem(doc.error ?? '公開用ドキュメントを生成できませんでした。');
      settle('failed');
      return;
    }

    const url = await publish(doc.html);
    if (!url) {
      // The hook's own message, which distinguishes an expired session from a
      // network failure. `error` has been set by the time this renders.
      settle('failed');
      return;
    }

    try {
      await navigator.clipboard.writeText(url);
      settle('copied');
    } catch {
      setManualUrl(url);
      setPhase('idle');
    }
  };

  const label =
    phase === 'working' || isPublishing ? '生成中…'
      : phase === 'copied' ? 'リンクをコピーしました'
      : phase === 'failed' ? '失敗しました'
      : '共有';

  return (
    <div className="app__share">
      <button
        className="app__header-btn"
        onClick={() => { void handleClick(); }}
        disabled={!html || phase === 'working'}
        type="button"
        title={problem ?? error ?? '公開リンクを作ってコピーします（30日間有効）'}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
          <polyline points="16 6 12 2 8 6" />
          <line x1="12" y1="2" x2="12" y2="15" />
        </svg>
        {label}
      </button>

      {manualUrl && (
        <div className="app__share-pop" role="dialog" aria-label="公開リンク">
          <p className="app__share-note">クリップボードに書き込めませんでした。以下をコピーしてください。</p>
          <input ref={inputRef} className="app__share-url" type="text" value={manualUrl} readOnly aria-label="公開URL" />
          <button className="app__share-close" onClick={() => setManualUrl(null)} type="button">閉じる</button>
        </div>
      )}
    </div>
  );
}
