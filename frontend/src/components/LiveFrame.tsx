import { useEffect, useRef, useState } from 'react';
import { needsCompileToRender } from '../utils/thumbnail';
import { splitHtmlToFiles } from '../utils/virtualFs';
import { buildReactPreview, enqueueBuild } from '../utils/reactPreview';
import { PREVIEW_GUARD_SCRIPT } from '../utils/previewGuard';

/**
 * A running copy of a document, which can be clicked through.
 *
 * `ProjectThumbnail` renders the same documents and is deliberately not this: it
 * is `aria-hidden`, `tabIndex={-1}` and `pointer-events: none`, because a card
 * in a list is a picture of a project rather than the project. Comparing two
 * versions screen by screen needs the opposite — a list looks identical across
 * versions until you open the detail view that changed.
 *
 * Interactive at 1:1 rather than scaled down. A thumbnail halves the document to
 * fit more page in the tile; here the point is reading and clicking, and half of
 * a 13px label is not clickable in any useful sense.
 */

/**
 * Reports where this frame navigated, and follows where it is told to go.
 *
 * Hash routing is the contract generated projects are built to — the assembler
 * prompt requires `#/list`-style routes and a `hashchange` subscription — so the
 * screen a frame is showing is readable and settable without reaching inside it.
 * That matters: the frame is sandboxed with `allow-scripts` and NOT
 * `allow-same-origin`, so its document is unreachable from here by design, and
 * `postMessage` is the whole of the channel.
 *
 * `applying` breaks the loop. Setting the hash raises `hashchange` in the frame,
 * which would report back, which would be applied to the other side, and so on.
 */
const SYNC_SCRIPT = `<script>
(function () {
  var applying = false;
  addEventListener('hashchange', function () {
    if (applying) { applying = false; return; }
    parent.postMessage({ type: 'vc-nav', hash: location.hash }, '*');
  });
  addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.type !== 'vc-goto') return;
    if ((d.hash || '') === location.hash) return;
    applying = true;
    location.hash = d.hash || '';
  });
})();
</script>`;

/*
 * The editing preview's navigation guard, which this frame did not have.
 *
 * The frame's document is about:srcdoc, but its BASE url is the host page's, so
 * a generated `<a href="#/">` resolves to https://<MakeUI's host>/#/ — a
 * different document — and the click navigates the whole frame out of the
 * comparison. Reported 2026-09-25 twice over: the link to the booking system's
 * first screen showed 「（MakeUI のドメイン）で接続が拒否されました」,
 * and 「画面を連動」 did nothing, because every screen change that went through a
 * link replaced the document together with the sync script inside it. The
 * guard performs a fragment link as `location.hash = …`, which stays in the
 * document and raises `hashchange` for the app and for SYNC_SCRIPT alike.
 */
const FRAME_SCRIPTS = PREVIEW_GUARD_SCRIPT + SYNC_SCRIPT;

/** Puts the scripts where the document will run them, whatever shape it arrived in. */
function withSync(doc: string): string {
  const head = doc.match(/<head(\s[^>]*)?>/i);
  if (head) return doc.replace(head[0], head[0] + FRAME_SCRIPTS);
  const body = doc.match(/<body(\s[^>]*)?>/i);
  if (body) return doc.replace(body[0], body[0] + FRAME_SCRIPTS);
  return FRAME_SCRIPTS + doc;
}

interface LiveFrameProps {
  html: string | null;
  title: string;
  /** The hash to follow, when following is on. */
  hash?: string | null;
  /** Called with the hash this frame moved to. */
  onNavigate?: (hash: string) => void;
}

export function LiveFrame({ html, title, hash, onNavigate }: LiveFrameProps) {
  const [doc, setDoc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setError(null);
    if (!html) return;

    if (!needsCompileToRender(html)) {
      setDoc(withSync(html));
      return;
    }
    // Queued, not called directly: two of these mount together and two
    // concurrent builds do not both finish.
    enqueueBuild(() => buildReactPreview(splitHtmlToFiles(html), { diagnostics: false }))
      .then((r) => {
        if (cancelled) return;
        if (r.html) setDoc(withSync(r.html));
        else setError(r.error ?? 'このバージョンを表示できませんでした。');
      })
      .catch(() => { if (!cancelled) setError('このバージョンを表示できませんでした。'); });
    return () => { cancelled = true; };
  }, [html]);

  // Only messages from this frame's own window count. Two of these are mounted
  // side by side and both are listening.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow) return;
      const d = e.data as { type?: string; hash?: string } | null;
      if (d?.type === 'vc-nav') onNavigate?.(d.hash ?? '');
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onNavigate]);

  useEffect(() => {
    if (hash === null || hash === undefined) return;
    ref.current?.contentWindow?.postMessage({ type: 'vc-goto', hash }, '*');
  }, [hash, doc]);

  if (error) return <p className="live-frame__error">{error}</p>;
  /*
   * Nothing to show and still loading are different, and saying 「読み込み中…」
   * for both means a side that will never arrive looks like one that is about
   * to. Measured: a version selected without being fetched sat on that word
   * indefinitely, with nothing anywhere to say so.
   */
  if (!html) return <p className="live-frame__loading">表示するバージョンがありません。</p>;
  if (!doc) return <p className="live-frame__loading">読み込み中…</p>;

  return (
    <iframe
      ref={ref}
      className="live-frame"
      srcDoc={doc}
      title={title}
      sandbox="allow-scripts"
    />
  );
}
