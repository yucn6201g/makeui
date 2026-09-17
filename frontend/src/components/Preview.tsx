import { useState, useEffect, useRef, useCallback } from 'react';
import { splitHtmlToFiles, toProjectFiles } from '../utils/virtualFs';
import { buildReactPreview, isCompilableProject } from '../utils/reactPreview';
import { PREVIEW_GUARD_SCRIPT } from '../utils/previewGuard';
import { GeneratingCanvas } from './GeneratingCanvas';
import type { PhaseEntry } from '../utils/phaseTranscript';

/**
 * Which device the preview is dressed as.
 *
 * Not just a width: a narrowed desktop window told the user nothing about how the
 * page reads on a phone, because the thing being judged is partly the frame — the
 * rounded corners, the reachable area, the proportion of screen the content fills.
 */
export type DeviceKind = 'desktop' | 'tablet' | 'mobile';

interface PreviewProps {
  html: string | null;
  score: number | null;
  device?: DeviceKind;
  /**
   * A click in the frame. The anchor is `<path>:<line>` when the element came
   * from a source file the compile could mark, and null otherwise — a mock, a
   * framework wrapper, or a build that was not asked for anchors.
   */
  onElementSelected?: (selector: string, anchor: string | null) => void;
  /**
   * A run is in flight. Only changes what is shown when there is nothing to show
   * yet — a modify run keeps the current document on screen, because taking a
   * working preview away to display a placeholder of one is a downgrade.
   */
  isGenerating?: boolean;
  /** The run's own step labels, so the caption can say what it is doing. */
  phases?: PhaseEntry[];
  generatingMode?: 'generate' | 'modify';
  /** The project's name, shown on the tab the way a browser shows a title. */
  title?: string;
  /**
   * Send the runtime error below back as an edit.
   *
   * This frame is the only thing in the product that sees a build fail to
   * start: the checked pipeline renders in AgentCore Browser and repairs what
   * it finds, and 下書き renders nowhere at all. The message was already being
   * caught and shown; what was missing was anything to do about it.
   */
  onRepairRuntimeError?: (detail: string) => void;
}



const SELECTOR_SCRIPT = `
<script>
(function() {
  let lastHighlighted = null;
  const HIGHLIGHT_STYLE = '2px solid #0017C1';
  const originalOutlines = new WeakMap();

  function getSelector(el) {
    if (el.id) return '#' + el.id;
    let path = [];
    while (el && el.nodeType === 1) {
      let selector = el.tagName.toLowerCase();
      if (el.id) {
        path.unshift('#' + el.id);
        break;
      }
      if (el.className && typeof el.className === 'string') {
        const classes = el.className.trim().split(/\\s+/).slice(0, 2).join('.');
        if (classes) selector += '.' + classes;
      }
      const parent = el.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(el) + 1;
          selector += ':nth-of-type(' + idx + ')';
        }
      }
      path.unshift(selector);
      el = el.parentElement;
    }
    return path.join(' > ');
  }

  document.addEventListener('mouseover', function(e) {
    if (lastHighlighted && lastHighlighted !== e.target) {
      lastHighlighted.style.outline = originalOutlines.get(lastHighlighted) || '';
    }
    lastHighlighted = e.target;
    originalOutlines.set(e.target, e.target.style.outline);
    e.target.style.outline = HIGHLIGHT_STYLE;
  });

  document.addEventListener('mouseout', function(e) {
    e.target.style.outline = originalOutlines.get(e.target) || '';
  });

  document.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    const selector = getSelector(e.target);
    /*
      The nearest ancestor that carries a source anchor, which is not always the
      node under the cursor: a click lands on whatever the mouse is over, and a
      component's own root, or a wrapper the framework inserted, has no anchor of
      its own. Walking up finds the closest element that a source line actually
      wrote.
    */
    var anchored = e.target;
    while (anchored && !anchored.getAttribute?.('data-mkui-src')) anchored = anchored.parentElement;
    window.parent.postMessage({
      type: 'element-selected',
      selector: selector,
      anchor: anchored ? anchored.getAttribute('data-mkui-src') : null,
    }, '*');
  }, true);
})();
</script>
`;

const LAYOUT_OVERLAY_CSS = `
<style data-layout-overlay>
* { outline: 1px solid rgba(0,23,193,0.1) !important; }
[style*="flex"], .flex, [class*="flex"] { outline: 2px dashed rgba(0,23,193,0.4) !important; }
[style*="grid"], .grid, [class*="grid"] { outline: 2px dashed rgba(37,157,99,0.4) !important; }
header, nav, main, section, aside, footer { outline: 2px solid rgba(0,23,193,0.3) !important; }
</style>
`;

/**
 * The strip of system UI a real device always shows above the app.
 *
 * The frame already had the bezel, the island and the home indicator, and
 * without this the screen still did not read as a phone: a design starting at
 * the very top pixel is the one thing no iOS app ever looks like. It also makes
 * the safe area visible, which is the practical point — a header that would sit
 * under the clock is a layout problem the flat preview hides.
 *
 * Live time rather than the 9:41 of Apple's own mockups. This is a preview of
 * the user's work, not a press image, and a clock that matches theirs reads as
 * their screen rather than a stock frame.
 */
function StatusBar({ device }: { device: 'tablet' | 'mobile' }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // Aligned to the next minute, then every minute: a 1s interval would re-render
    // sixty times for one visible change.
    const toNextMinute = 60_000 - (Date.now() % 60_000);
    let interval: ReturnType<typeof setInterval> | undefined;
    const timeout = setTimeout(() => {
      setNow(new Date());
      interval = setInterval(() => setNow(new Date()), 60_000);
    }, toNextMinute);
    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, []);

  const time = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;

  return (
    <div className={`preview__statusbar preview__statusbar--${device}`} aria-hidden="true">
      <span className="preview__statusbar-time">{time}</span>
      <span className="preview__statusbar-right">
        {device === 'mobile' && (
          /* Cellular bars: four steps, tallest last, as iOS draws them. */
          <svg className="preview__statusbar-icon" viewBox="0 0 18 12" width="17" height="11">
            {[0, 1, 2, 3].map((i) => (
              <rect key={i} x={i * 4.6} y={9 - i * 2.6} width="3" height={3 + i * 2.6} rx="1" fill="currentColor" />
            ))}
          </svg>
        )}
        <svg className="preview__statusbar-icon" viewBox="0 0 16 12" width="16" height="12">
          <path
            d="M8 10.4 6.2 8.6a2.6 2.6 0 0 1 3.6 0zM3.4 5.8a6.6 6.6 0 0 1 9.2 0l-1.3 1.3a4.8 4.8 0 0 0-6.6 0zM.6 3a10.6 10.6 0 0 1 14.8 0l-1.3 1.3a8.8 8.8 0 0 0-12.2 0z"
            fill="currentColor"
          />
        </svg>
        <span className="preview__statusbar-battery">
          <span className="preview__statusbar-battery-fill" />
        </span>
      </span>
    </div>
  );
}

export function Preview({ html, score, device = 'desktop', onElementSelected,
  isGenerating = false, phases = [], generatingMode = 'generate', title,
  onRepairRuntimeError }: PreviewProps) {
  const [selectorMode, setSelectorMode] = useState(false);
  const [layoutOverlay, setLayoutOverlay] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  /**
   * The exact document we last wrote into the frame.
   *
   * Replaces a boolean that tried to count load events. See handleIframeLoad.
   */
  const lastWrittenRef = useRef<string | null>(null);
  /** Set when the frame answers the current ping. See handleIframeLoad. */
  const aliveRef = useRef(false);
  /** Ties an answer to the question that asked for it. */
  const pingNonceRef = useRef(0);
  /** Whether the document we last wrote carries the guard, and so can report in. */
  const guardedRef = useRef(false);
  // React output has to be compiled before it can run; plain HTML passes straight through.
  const [reactDoc, setReactDoc] = useState<string | null>(null);
  const [reactError, setReactError] = useState<string | null>(null);
  const [reactRuntimeError, setReactRuntimeError] = useState<string | null>(null);
  // Non-fatal compile notices (unresolved imports, JSX in a .ts file). These were
  // being computed and thrown away, hiding the cause of a blank or broken preview.
  const [reactWarnings, setReactWarnings] = useState<string[]>([]);
  const [compiling, setCompiling] = useState(false);

  /**
   * Fit the device to the pane by scaling it, never by shrinking it.
   *
   * The frame used to carry `max-width: 100%`, so in a pane narrower than the
   * device — which is the normal case, the preview shares the window with the
   * chat — the shell shrank and took the iframe with it. The page then rendered
   * at whatever width happened to be left, so "tablet" meant 640px on one screen
   * and 780px on another, and a `max-width: 768px` breakpoint fired or did not
   * depending on how wide the user's browser was. That is the broken tablet and
   * mobile layout: the viewport was never the device's.
   *
   * The shell now keeps its real logical size and a transform scales the whole
   * thing. A transform does not change layout, so the iframe still reports 393 or
   * 820 CSS pixels to the page inside it, and the breakpoints are the ones the
   * device would really trigger.
   */
  /**
   * A state-backed ref, not `useRef`, because the stage mounts later than the
   * effect that has to measure it.
   *
   * The stage only exists while there is a document to show. With `useRef` the
   * effect ran once on device change, found `null` — no document yet — and
   * returned; when the generation finished and the stage appeared, nothing
   * re-ran it. The frame then sat at its initial scale of 1, drawn at full 415
   * or 852 pixels and overflowing the pane, until an unrelated resize happened
   * to fix it. A callback ref re-renders when the node arrives, so the effect
   * depends on the node itself and cannot miss it.
   */
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const [deviceScale, setDeviceScale] = useState(1);

  useEffect(() => {
    if (device === 'desktop' || !stage) return;

    const OUTER: Record<Exclude<DeviceKind, 'desktop'>, { w: number; h: number }> = {
      tablet: { w: 852, h: 1212 },
      mobile: { w: 415, h: 874 },
    };
    const { w, h } = OUTER[device];

    const fit = () => {
      const box = stage.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return;
      // Never scale up: a phone shown larger than life reads as a mockup, not a phone.
      setDeviceScale(Math.min(1, box.width / w, box.height / h));
    };

    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [device, stage]);

  useEffect(() => {
    let cancelled = false;
    setReactDoc(null);
    setReactError(null);
    setReactRuntimeError(null);
    setReactWarnings([]);
    // Cleared up front: a previous run may have left this set, and while it is true
    // the frame renders blank. Every early return below must leave it false.
    setCompiling(false);
    if (!html) return;

    const files = toProjectFiles(splitHtmlToFiles(html));
    if (!isCompilableProject(files)) return;

    setCompiling(true);
    // The one build that is clicked into, so the one that carries anchors.
    buildReactPreview(files, { anchors: true })
      .then((result) => {
        if (cancelled) return;
        setReactDoc(result.html);
        setReactError(result.error);
        /**
         * Only warnings the user can act on.
         *
         * "JSX を含むため .tsx にすべきファイルです" was reaching users on top of a
         * preview that had rendered perfectly — a naming rule they did not write,
         * about a file they cannot edit here, already worked around by the retry
         * that produced the very page they were looking at. Generation now
         * renames those files, so this only appears for projects made before that;
         * either way it is a note for the log, not a banner over the design.
         */
        setReactWarnings(result.warnings.filter((w) => !/\.tsx にすべき/.test(w)));
        for (const w of result.warnings) console.info(`[preview] ${w}`);
      })
      .catch((e) => {
        if (!cancelled) setReactError(String(e));
      })
      .finally(() => {
        if (!cancelled) setCompiling(false);
      });

    return () => {
      cancelled = true;
      // The .finally above is skipped once cancelled, so release the flag here —
      // otherwise swapping html mid-compile leaves the preview blank for good.
      setCompiling(false);
    };
  }, [html]);

  const getScoreLabel = (s: number): string => {
    if (s >= 90) return '高品質';
    if (s >= 70) return '標準';
    return '要改善';
  };

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.data?.type === 'element-selected' && onElementSelected) {
        onElementSelected(event.data.selector, event.data.anchor ?? null);
        setSelectorMode(false);
      }
      // Runtime failures inside the sandboxed React frame are only visible via
      // postMessage; surface them next to the preview instead of losing them.
      if (event.data?.type === 'react-preview' && event.data.kind === 'error') {
        setReactRuntimeError(String(event.data.detail));
      }
      if (event.data?.type === 'react-preview' && event.data.kind === 'ready') {
        setReactRuntimeError(null);
      }
      // The frame answering that it is still the document we wrote. The nonce
      // ties the answer to the question, so a late reply to a previous load
      // cannot vouch for the page that replaced it. See handleIframeLoad.
      if (
        event.data?.type === 'makeui-preview' &&
        event.data.kind === 'pong' &&
        event.data.nonce === pingNonceRef.current
      ) {
        aliveRef.current = true;
      }
    },
    [onElementSelected]
  );

  useEffect(() => {
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [handleMessage]);



  const getIframeSrcDoc = useCallback(() => {
    if (!html) return undefined;
    if (reactError) {
      return `<!DOCTYPE html><meta charset="utf-8"><body style="margin:0;padding:24px;background:#1b1b1f;color:#ffb4b4;font:13px/1.6 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap"><b style="color:#fff;display:block;margin-bottom:8px">ビルドエラー</b>${reactError.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</body>`;
    }
    // A React project only becomes runnable after compilation; until then there is
    // nothing meaningful to show, so hold the frame blank rather than rendering the
    // uncompiled source document.
    if (compiling) return '<!DOCTYPE html><meta charset="utf-8"><body></body>';
    let doc = reactDoc ?? html;

    const extraScripts = selectorMode ? PREVIEW_GUARD_SCRIPT + SELECTOR_SCRIPT : PREVIEW_GUARD_SCRIPT;
    // Case-insensitive injection into head/body
    const headMatch = doc.match(/<head(\s[^>]*)?>/i);
    const bodyMatch = doc.match(/<body(\s[^>]*)?>/i);
    if (headMatch) {
      doc = doc.replace(headMatch[0], headMatch[0] + extraScripts);
    } else if (bodyMatch) {
      doc = doc.replace(bodyMatch[0], bodyMatch[0] + extraScripts);
    } else {
      doc = extraScripts + doc;
    }

    if (layoutOverlay) {
      const headEndMatch = doc.match(/<\/head>/i);
      const bodyEndMatch = doc.match(/<\/body>/i);
      if (headEndMatch) {
        doc = doc.replace(headEndMatch[0], LAYOUT_OVERLAY_CSS + headEndMatch[0]);
      } else if (bodyEndMatch) {
        doc = doc.replace(bodyEndMatch[0], LAYOUT_OVERLAY_CSS + bodyEndMatch[0]);
      } else {
        doc = doc + LAYOUT_OVERLAY_CSS;
      }
    }
    return doc;
  }, [html, selectorMode, layoutOverlay, reactDoc, reactError, compiling]);

  /**
   * The iframe navigated somewhere we did not send it — put the document back.
   *
   * This used to compare the srcdoc attribute against what we last wrote, and it
   * could never fire: **navigating a frame does not change its srcdoc
   * attribute.** The attribute still held our document while the frame was
   * showing the host site, so the guard clause returned every time and the
   * recovery it guarded never ran once. That is the second half of the
   * 「接続が拒否されました」 report — the first half is why the frame left, the
   * second is why it never came back.
   *
   * The frame is sandboxed to an opaque origin, so `contentWindow.location` is
   * unreadable and there is nothing on this side to compare. So it is asked:
   * every load, send a ping and see whether the guard answers. A page the frame
   * navigated to has no such listener, and silence is the answer.
   *
   * It asks rather than listens, and that distinction is the whole of the second
   * bug found here. The first version had the guard announce itself once and had
   * this clear a flag on the load event — but the guard runs while the document
   * is parsing and `load` fires after that, so the announcement arrived before
   * the flag was cleared and was discarded. Measured: every healthy load looked
   * like a navigation, and the retry budget was gone before the user could click
   * anything. A question carries its own ordering; a flag does not.
   */
  const restoreAttemptsRef = useRef(0);
  const handleIframeLoad = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe || !html) return;
    // Documents we write without the guard — the blank held during compilation,
    // the build-error page — cannot answer, and asking them to would restore
    // them forever.
    if (!guardedRef.current) return;
    const nonce = pingNonceRef.current + 1;
    pingNonceRef.current = nonce;
    aliveRef.current = false;
    iframe.contentWindow?.postMessage({ type: 'makeui-preview-ping', nonce }, '*');
    window.setTimeout(() => {
      if (pingNonceRef.current !== nonce) return; // a newer load is in charge
      if (aliveRef.current) {
        restoreAttemptsRef.current = 0;
        return;
      }
      // Bounded: if putting the document back does not produce a live frame,
      // rewriting it again will not either, and a loop would be worse than a
      // blank pane.
      if (restoreAttemptsRef.current >= 3) return;
      restoreAttemptsRef.current += 1;
      const doc = getIframeSrcDoc();
      if (doc === undefined) return;
      lastWrittenRef.current = doc;
      iframe.setAttribute('srcdoc', doc);
    }, 400);
  }, [html, getIframeSrcDoc]);

  /**
   * The only thing that writes the document into the frame.
   *
   * It used to be one of three: React wrote `srcDoc` as a prop, this effect
   * wrote the attribute, and the load handler wrote `iframe.srcdoc`. React
   * decides whether to touch an attribute by comparing against *its own record*
   * of the last prop it wrote, so an imperative write leaves that record stale —
   * and the next time the computed document happens to equal the stale record,
   * React concludes nothing changed and leaves whatever the other writer put
   * there. If that was the blank held during compilation, the preview stays
   * blank.
   *
   * So the prop is gone and this is the single writer. `device` is a dependency
   * because the desktop and device-frame branches are two different <iframe>
   * elements: swapping between them mounts a fresh one with no srcdoc, and
   * nothing else here would notice.
   */
  useEffect(() => {
    const iframe = iframeRef.current;
    const doc = getIframeSrcDoc();
    if (!iframe || doc === undefined) return;
    // Recorded from the document itself rather than from the branch that built
    // it, so a new early-return in getIframeSrcDoc cannot quietly leave the
    // watchdog waiting for a report that will never come.
    guardedRef.current = doc.includes('makeui-nav-block');
    restoreAttemptsRef.current = 0;
    if (iframe.getAttribute('srcdoc') === doc) {
      lastWrittenRef.current = doc;
      return;
    }
    lastWrittenRef.current = doc;
    iframe.setAttribute('srcdoc', doc);
  }, [getIframeSrcDoc, device]);

  /**
   * Reloading the frame, for real.
   *
   * A browser chrome with a decorative reload button would be a dead control in
   * a product whose own audit reports dead controls, so this one works: the
   * srcdoc is cleared and written back, which tears the old document down and
   * boots a fresh one — state reset, effects re-run, exactly what pressing
   * reload means.
   *
   * The writer effect above documents itself as the single writer, and that
   * invariant holds: this rewrites the SAME document it last wrote, so
   * `lastWrittenRef` and the attribute still agree afterwards and the effect's
   * equality check reaches the same conclusion it would have before.
   */
  const reloadFrame = useCallback(() => {
    const iframe = iframeRef.current;
    const doc = lastWrittenRef.current;
    if (!iframe || !doc) return;
    iframe.setAttribute('srcdoc', '');
    // A frame given the same srcdoc in one tick may not re-parse; letting the
    // browser paint the empty document first makes the reload real.
    requestAnimationFrame(() => iframe.setAttribute('srcdoc', doc));
  }, []);

  /**
   * Blob URL backing the full-screen link.
   *
   * A blob gives the standalone tab a real document URL, so hash routing and the
   * browser's own back/forward behave as they would in the shipped app. It is
   * exposed through an anchor rather than window.open because popup blockers
   * routinely veto scripted opens but allow a genuine link click. React output is
   * served compiled; plain HTML as-is. The preview's nav-block wrapper is
   * deliberately left off so the standalone view behaves like the real thing.
   */
  const [fullscreenUrl, setFullscreenUrl] = useState<string | null>(null);

  useEffect(() => {
    const doc = reactDoc ?? html;
    if (!doc) {
      setFullscreenUrl(null);
      return;
    }
    const url = URL.createObjectURL(new Blob([doc], { type: 'text/html' }));
    setFullscreenUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [reactDoc, html]);

  /*
   * The action buttons, defined once and drawn by whichever bar is on screen.
   * Two copies of this markup would be two places to forget when a control is
   * added, and the device-bar copy is the one nobody would look at.
   */
  const actionButtons = (
    <>
          {html && onElementSelected && (
            <button
              className={`preview__chrome-btn${selectorMode ? ' preview__chrome-btn--active' : ''}`}
              onClick={() => setSelectorMode(!selectorMode)}
              aria-pressed={selectorMode}
              title="要素を選択して修正対象を指定"
              type="button"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/>
                <path d="M13 13l6 6"/>
              </svg>
              Select
            </button>
          )}
          {html && (
            <button
              className={`preview__chrome-btn${layoutOverlay ? ' preview__chrome-btn--active' : ''}`}
              onClick={() => setLayoutOverlay(!layoutOverlay)}
              aria-pressed={layoutOverlay}
              title="レイアウトオーバーレイ"
              type="button"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
                <line x1="3" y1="9" x2="21" y2="9"/>
                <line x1="9" y1="21" x2="9" y2="9"/>
              </svg>
              Layout
            </button>
          )}
          {html && fullscreenUrl && !compiling && (
            <a
              className="preview__chrome-btn"
              href={fullscreenUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="別タブで全画面表示"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 3h6v6" />
                <path d="M10 14L21 3" />
                <path d="M21 14v5a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h5" />
              </svg>
              全画面
            </a>
          )}
          {score !== null && (
            <span
              className={`preview__score-badge preview__score-badge--${
                score >= 90 ? 'high' : score >= 70 ? 'medium' : 'low'
              }`}
              aria-label={`品質スコア: ${score}点（${getScoreLabel(score)}）`}
            >
              {score}
            </span>
          )}
    </>
  )

  return (
    <section className="preview" aria-label="プレビュー">
      {/*
        Chrome's own shape, as closely as an embedded pane can hold it: a tab
        strip above a toolbar, back / forward / reload on the left, a pill
        omnibox in the middle, actions on the right.
        The two navigation arrows are rendered DISABLED rather than omitted.
        That is not decoration — a srcdoc frame is an opaque origin, so its
        history genuinely cannot be driven from here, and Chrome greys these
        exact buttons for exactly that reason when there is nowhere to go. The
        reload beside them does work.
      */}
      {/*
        The browser chrome is a desktop conceit, and on a phone or a tablet it is
        a desktop browser drawn around a phone. It goes, on the operator's
        instruction, and the 72px it held — a 34px tab strip and a 38px toolbar —
        goes to the device: the shell is fitted to its stage by a transform, so a
        taller stage is a larger scale with nothing else to change.

        The action buttons are not part of the frame and stay, in a slim bar.
        `Select` is how an element is chosen for the next edit, and dropping a
        control nobody asked about would be a regression smuggled in beside a
        layout change.
      */}
      {device !== 'desktop' ? (
        <div className="preview__device-bar">
          <span className="preview__device-bar-label">
            {device === 'tablet' ? 'iPad · 820 × 1180' : 'iPhone · 393 × 852'}
          </span>
          <div className="preview__actions">{actionButtons}</div>
        </div>
      ) : (
      <div className="preview__browser-chrome">
        <div className="preview__tabstrip">
          <div className="preview__tab">
            <span className="preview__tab-favicon" aria-hidden="true" />
            <span className="preview__tab-title">{title?.trim() || 'プレビュー'}</span>
          </div>
        </div>

        <div className="preview__toolbar">
          <div className="preview__nav">
            <button className="preview__nav-btn" type="button" disabled aria-label="戻る（プレビューでは利用できません）" title="プレビューでは履歴を戻れません">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5" /><polyline points="12 19 5 12 12 5" /></svg>
            </button>
            <button className="preview__nav-btn" type="button" disabled aria-label="進む（プレビューでは利用できません）" title="プレビューでは履歴を進めません">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><polyline points="12 5 19 12 12 19" /></svg>
            </button>
            <button
              className="preview__nav-btn"
              type="button"
              onClick={reloadFrame}
              disabled={!html || compiling}
              aria-label="再読み込み"
              title="再読み込み"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" /></svg>
            </button>
          </div>

          <div className="preview__omnibox">
            {/*
              The circled `i`, which is what Chrome shows for localhost — a
              padlock would be claiming a TLS connection that is not there.
            */}
            <svg className="preview__omnibox-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="12" cy="12" r="9" /><line x1="12" y1="11" x2="12" y2="16" /><circle cx="12" cy="8" r="0.6" fill="currentColor" />
            </svg>
            <span className="preview__omnibox-url">
              localhost:5173
              {device !== 'desktop' && (
                <span className="preview__omnibox-device">
                  {device === 'tablet' ? ' — iPad · 820 × 1180' : ' — iPhone · 393 × 852'}
                </span>
              )}
            </span>
          </div>

          <div className="preview__actions">{actionButtons}</div>
        </div>
      </div>
      )}
      <div className={`preview__frame-container preview__frame-container--${device}`}>
        {reactRuntimeError && (
          <div className="preview__runtime-error" role="alert" data-testid="react-runtime-error">
            <span className="preview__runtime-error-text">{reactRuntimeError}</span>
            {onRepairRuntimeError && (
              <button
                type="button"
                className="preview__runtime-fix"
                onClick={() => onRepairRuntimeError(reactRuntimeError)}
                disabled={isGenerating}
                title="このエラーを直すよう依頼します"
              >
                修復する
              </button>
            )}
          </div>
        )}
        {!reactRuntimeError && reactWarnings.length > 0 && (
          <div className="preview__runtime-warn" role="status" data-testid="react-warnings">
            {reactWarnings.join('\n')}
          </div>
        )}
        {/*
          The shell is drawn whether or not there is a document.
          An empty tablet used to fall through to the bare placeholder, and the
          container it landed in is `flex-direction: column` — inherited from the
          base rule — while its `align-items: flex-start` was written for a row.
          So the message sat hard against the left edge: measured 16px of gap on
          the left against 786px on the right, in a 1005px pane. Putting the
          empty state inside the bezel is the answer to both halves of that: it
          is centred because the stage centres it, and 「タブレット表示」 with
          nothing in it now looks like a tablet with nothing in it.
        */}
        {(() => {
          const body = html ? (
            <iframe
              ref={iframeRef}
              className="preview__iframe"
              sandbox="allow-scripts"
              onLoad={handleIframeLoad}
              title="生成されたUIのプレビュー"
            />
          ) : isGenerating ? (
            <GeneratingCanvas phases={phases} mode={generatingMode} />
          ) : (
            <div className="preview__placeholder">
              <div className="preview__placeholder-icon">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="3" width="20" height="14" rx="2"/>
                  <line x1="8" y1="21" x2="16" y2="21"/>
                  <line x1="12" y1="17" x2="12" y2="21"/>
                </svg>
              </div>
              <p>プレビューがここに表示されます</p>
              <p className="preview__placeholder-hint">左のチャットからUIを生成してください</p>
            </div>
          );

          if (device === 'desktop') return body;

          /*
            The bezel is not decoration. Judging a phone layout needs the frame:
            how much of the screen the content fills, whether anything collides
            with the home indicator, whether the corner radius clips a control.
          */
          return (
            <div className="preview__device-stage" ref={setStage}>
              <div
                className={`preview__device preview__device--${device}`}
                aria-hidden={false}
                style={{ transform: `scale(${deviceScale})` }}
              >
                {device === 'mobile' && (
                  <>
                    <span className="preview__device-btn preview__device-btn--silent" aria-hidden="true" />
                    <span className="preview__device-btn preview__device-btn--volup" aria-hidden="true" />
                    <span className="preview__device-btn preview__device-btn--voldown" aria-hidden="true" />
                    <span className="preview__device-btn preview__device-btn--power" aria-hidden="true" />
                  </>
                )}
                {device === 'tablet' && (
                  <>
                    <span className="preview__device-btn preview__device-btn--ipad-power" aria-hidden="true" />
                    <span className="preview__device-camera" aria-hidden="true" />
                  </>
                )}
                <div className="preview__device-screen">
                  <StatusBar device={device} />
                  {device === 'mobile' && <span className="preview__device-island" aria-hidden="true" />}
                  {body}
                  <span className="preview__device-indicator" aria-hidden="true" />
                </div>
              </div>
            </div>
          );
        })()}
      </div>
    </section>
  );
}
