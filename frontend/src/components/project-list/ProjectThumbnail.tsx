import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { toThumbnailDoc, needsCompileToRender } from '../../utils/preview/thumbnail';
import { splitHtmlToFiles } from '../../utils/preview/virtualFs';
import { buildReactPreview, enqueueBuild } from '../../utils/preview/reactPreview';
import { fetchPreviewPolitely } from '../../utils/preview/previewFetch';

/**
 * A project card's preview frame.
 *
 * Static HTML mocks can be shown straight away. React projects are only source
 * blocks plus an empty `<div id="root">`, so they have to be compiled before
 * anything exists to paint — which also means their frame needs scripts, unlike
 * the static case.
 *
 * Compilation is deferred until the card is near the viewport and runs one at a
 * time, so opening a long project list does not block the main thread on a burst
 * of Sucrase runs.
 */

/** Compiled documents, keyed by source, so re-entering the list is instant. */
const cache = new Map<string, string | null>();
const MAX_CACHE = 40;

/**
 * Fetched documents, keyed by project, for the same reason — and for one more.
 *
 * The promise is stored rather than its result, so two callers asking at once
 * get one request. StrictMode makes that the ordinary case, not an edge one: it
 * mounts every effect twice in development, which without this is two fetches of
 * an 87KB document per card on every list render.
 *
 * A failed lookup is not kept. Caching `null` would mean a card that missed once
 * — a request cancelled by a navigation, say — never tries again for as long as
 * the tab is open.
 */
const documents = new Map<string, Promise<string | null>>();

function loadDocument(
  projectId: string,
  fetchHtml: (projectId: string) => Promise<string | null>,
): Promise<string | null> {
  const hit = documents.get(projectId);
  if (hit) return hit;

  // Queued and retried — see utils/preview/previewFetch.ts for why a burst of cards failed.
  const pending = fetchPreviewPolitely(() => fetchHtml(projectId)).then(
    (html) => { if (!html) documents.delete(projectId); return html; },
    (e) => { documents.delete(projectId); throw e; },
  );
  if (documents.size >= MAX_CACHE) documents.delete(documents.keys().next().value as string);
  documents.set(projectId, pending);
  return pending;
}

async function compile(html: string): Promise<string | null> {
  const hit = cache.get(html);
  if (hit !== undefined) return hit;

  const files = splitHtmlToFiles(html);
  if (files.length === 0) return null;

  const { html: doc } = await buildReactPreview(files, { diagnostics: false });
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
  cache.set(html, doc);
  return doc;
}

/**
 * Whether the card has come near the viewport, once and for good.
 *
 * Everything a thumbnail costs waits for this: fetching the document, compiling
 * it, and the iframe itself — a frame that runs the generated app's React, so
 * each one is a document to parse and a runtime to start. Measured on
 * 2026-09-27 with 120 cards a tab: switching tabs mounted all 120 frames and
 * held the main thread for about 0.9 s, most of it off screen.
 *
 * A hidden or non-compositing tab never reports an intersection, which once
 * left every React card on 「読み込み中…」 for ever. So a card with no report at
 * all after a short wait counts as near. A card the observer HAS reported as
 * off screen is not forced: that used to start all 120 at once.
 */
function useNearViewport(ref: RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(false);
  // Before the first paint: a card already on screen shows its frame at once
  // instead of flashing 「読み込み中…」 until the observer's first report.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const box = node.getBoundingClientRect();
    if (box.bottom > -300 && box.top < window.innerHeight + 300 && box.width > 0) setNear(true);
  }, [ref]);
  useEffect(() => {
    if (near) return;
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    let reported = false;
    const observer = new IntersectionObserver(
      (entries) => {
        reported = true;
        if (entries.some((e) => e.isIntersecting)) {
          observer.disconnect();
          setNear(true);
        }
      },
      { rootMargin: '300px' }
    );
    observer.observe(node);
    const fallback = setTimeout(() => {
      if (!reported) {
        observer.disconnect();
        setNear(true);
      }
    }, 1500);
    return () => {
      clearTimeout(fallback);
      observer.disconnect();
    };
  }, [near, ref]);
  return near;
}

interface ProjectThumbnailProps {
  /**
   * The document, when the caller happens to have it.
   *
   * The project LIST does not: the row stopped carrying a copy of the document,
   * so a card starts with nothing and asks for one. `html` is still passed
   * wherever it is already in hand — a project just created in this session —
   * because fetching what you are holding is a wasted round trip.
   */
  html?: string | null;
  title: string;
  /** Absent where the caller has the document already — a chat reply's preview. */
  projectId?: string;
  /** Whether there is anything to fetch. False draws the empty mark at once. */
  hasDocument?: boolean;
  /** Must be stable across renders — it is an effect dependency. */
  fetchHtml?: (projectId: string) => Promise<string | null>;
}

export function ProjectThumbnail({
  html, title, projectId, hasDocument, fetchHtml,
}: ProjectThumbnailProps) {
  /*
   * The document as this card currently knows it: what was handed in, or what
   * was fetched. Everything below reads `source`, so the two cases render
   * through exactly one path.
   */
  const [source, setSource] = useState<string | null>(html ?? null);
  useEffect(() => { setSource(html ?? null); }, [html]);

  // True for any project format, not only React: `needsCompileToRender`
  // asks whether the document unpacks into source files at all.
  const isProject = Boolean(source && needsCompileToRender(source));
  const staticDoc = isProject ? null : toThumbnailDoc(source);

  const holderRef = useRef<HTMLDivElement>(null);
  const near = useNearViewport(holderRef);
  const [reactDoc, setReactDoc] = useState<string | null>(() =>
    html && needsCompileToRender(html) ? (cache.get(html) ?? null) : null
  );
  const [failed, setFailed] = useState(false);

  /*
   * Fetching and compiling are one deferred unit, so a card that has to do both
   * still does them once, in order, when it comes near the viewport.
   *
   * The fetch is deliberately outside `enqueueBuild`: that queue exists to keep
   * Sucrase off the main thread in a burst, and putting a network read in it
   * would make one slow response hold up every other card's compile.
   */
  const started = useRef(false);
  /*
   * Cancellation is a ref, not a local, because this effect re-runs the moment
   * the fetch lands — `source` is one of its dependencies. A local flag would be
   * set by the outgoing run's cleanup and throw away the compile that the same
   * run had just started. It is only raised when the card goes away or points at
   * a different project.
   */
  const cancelled = useRef(false);
  useEffect(() => {
    started.current = false;
    cancelled.current = false;
    return () => { cancelled.current = true; };
  }, [projectId, html]);

  const wanted =
    (!source && Boolean(hasDocument) && Boolean(projectId) && Boolean(fetchHtml))
    || (isProject && !reactDoc);

  // Cards below the fold are common; fetching and compiling them on mount would
  // spend the budget on tiles the user may never scroll to. The serial queue
  // still keeps a long list from compiling all at once.
  useEffect(() => {
    if (!wanted || started.current || !near) return;
    const start = () => {
      started.current = true;
      (async () => {
        const doc = source ?? (fetchHtml && projectId ? await loadDocument(projectId, fetchHtml) : null);
        if (cancelled.current) return;
        if (!doc) { setFailed(true); return; }
        setSource(doc);
        if (!needsCompileToRender(doc)) return;
        const built = await enqueueBuild(() => compile(doc));
        if (cancelled.current) return;
        if (built) setReactDoc(built);
        else setFailed(true);
      })().catch(() => {
        if (!cancelled.current) setFailed(true);
      });
    };

    start();
  }, [wanted, near, source, projectId, fetchHtml]);

  if (staticDoc) {
    return (
      <div ref={holderRef} className="project-list__card-frame">
        {near && (
          <iframe
            srcDoc={staticDoc}
            sandbox=""
            title={title}
            className="project-list__card-iframe"
          />
        )}
      </div>
    );
  }

  if (isProject || wanted) {
    return (
      <div ref={holderRef} className="project-list__card-frame">
        {reactDoc && near ? (
          // Scripts are required here: without them a React project has nothing to
          // paint. No same-origin, so the frame still cannot reach the host app.
          <iframe
            srcDoc={reactDoc}
            sandbox="allow-scripts"
            title={title}
            className="project-list__card-iframe"
            tabIndex={-1}
            aria-hidden="true"
          />
        ) : (
          /**
           * A neutral mark, not React's.
           *
           * This drew the React logo — a nucleus with three orbits — on the
           * placeholder for EVERY project format, so a Vue project whose preview
           * would not compile announced itself as React on the card. Reported
           * exactly that way: 「Vueで生成失敗時に一覧画面でReactのアイコンが表示
           * されています」. The card is the one place the user is told what a
           * project is, so getting it wrong there is worse than showing nothing.
           *
           * A window outline says "a screen that could not be drawn", which is
           * what actually happened, and is true of all three frameworks.
           */
          <div className="project-list__card-empty">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
              <rect x="2.5" y="4" width="19" height="16" rx="2" />
              <path d="M2.5 8.5h19" />
              <circle cx="5.6" cy="6.25" r="0.6" fill="currentColor" stroke="none" />
              <circle cx="7.6" cy="6.25" r="0.6" fill="currentColor" stroke="none" />
            </svg>
            <span>{failed ? 'プレビューを表示できませんでした' : '読み込み中…'}</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="project-list__card-empty">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="3" y1="9" x2="21" y2="9" />
      </svg>
    </div>
  );
}
