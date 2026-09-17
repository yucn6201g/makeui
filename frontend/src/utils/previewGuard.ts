/**
 * The script injected into every preview frame.
 *
 * Extracted from Preview.tsx so it can be exercised on its own: it is a string
 * of JavaScript that runs inside a sandboxed, opaque-origin iframe, which is the
 * one place the app cannot look into. Whether it actually stops a navigation is
 * therefore not something reading it can settle — it has to be run.
 *
 * It blocks real page-away navigation and leaves every in-page interaction
 * alone. What it cannot block is covered by the watchdog in Preview.tsx: see
 * the note there on why prevention alone is not enough.
 */
/** What the guard should do with a clicked link. */
export type HrefVerdict = 'ignore' | 'hash' | 'external' | 'internal';

/**
 * The decision the guard makes about an href, as a plain function.
 *
 * Extracted so it can be tested, and stringified into the guard below so the
 * tested code is the shipped code — a second copy inside the script would only
 * prove the two agreed on the day it was written. Everything around it (toasts,
 * scrolling, setting the hash) needs a DOM and a real frame, and is measured in
 * the browser instead.
 *
 *   ignore   — leave the default alone; the page meant nothing by it
 *   hash     — a fragment; the guard must perform it, never let it through
 *   external — another origin; refuse and say so
 *   internal — a path in this app; try to resolve it in-page, else say so
 */
export function classifyHref(href: string): HrefVerdict {
  if (!href || href === 'javascript:void(0)' || href === 'javascript:;') return 'ignore';
  if (href.charAt(0) === '#') return 'hash';
  if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('//')) return 'external';
  // Anything else with a scheme is somebody else's problem: mailto:, tel:, data:.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return 'external';
  return 'internal';
}

export const PREVIEW_GUARD_SCRIPT = `
<meta name="makeui-nav-block" content="true">
<script data-makeui-nav-block>
/**
 * Bound to an explicit name, never to the function's own.
 *
 * A minifier renames the declaration but not the string that calls it, so
 * emitting the bare \`function classifyHref\` gave a production bundle holding
 * \`function ww(e){…}\` next to a call to \`classifyHref(href)\` — every click in
 * every preview would have thrown ReferenceError. It works in dev, where
 * nothing is renamed, so only the built artifact shows it.
 */
var classifyHref = ${classifyHref.toString()};
(function() {

  // ── localStorage / sessionStorage polyfill (sandbox may block access) ────
  (function() {
    var _stores = { localStorage: {}, sessionStorage: {} };
    ['localStorage', 'sessionStorage'].forEach(function(key) {
      try { window[key].getItem('__test__'); } catch(e) {
        var store = _stores[key];
        var api = {
          getItem: function(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
          setItem: function(k, v) { store[k] = String(v); },
          removeItem: function(k) { delete store[k]; },
          clear: function() { _stores[key] = store = {}; },
          key: function(i) { return Object.keys(store)[i] || null; },
          get length() { return Object.keys(store).length; }
        };
        try { Object.defineProperty(window, key, { get: function() { return api; }, configurable: true }); } catch(e2) {}
      }
    });
  })();

  // ── Helpers ──────────────────────────────────────────────────────────────

  function mkToast(msg, color) {
    var t = document.createElement('div');
    t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:'+(color||'rgba(0,0,0,0.82)')+';color:#fff;padding:9px 20px;border-radius:100px;font-size:13px;font-family:system-ui,sans-serif;z-index:2147483647;opacity:0;transition:opacity .18s;pointer-events:none;white-space:nowrap;box-shadow:0 4px 16px rgba(0,0,0,.18);';
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(function(){ t.style.opacity='1'; });
    setTimeout(function(){ t.style.opacity='0'; setTimeout(function(){ t.remove(); },300); }, 2500);
  }

  // ── Block only absolute external navigation ───────────────────────────────

  // Intercept link clicks — only prevent href from causing page-away load.
  // Do NOT stopImmediatePropagation so onclick handlers still run normally.
  document.addEventListener('click', function(e) {
    var el = e.target;
    while (el && el.tagName !== 'A' && el.tagName !== 'AREA') el = el.parentElement;
    if (!el) return;
    var href = el.getAttribute('href') || '';
    var verdict = classifyHref(href);
    if (verdict === 'ignore') return;

    /**
     * A fragment link has to be performed here, not allowed through.
     *
     * This is the whole bug behind 「接続が拒否されました」. The frame's document
     * URL is about:srcdoc, but its BASE url is inherited from the host page — so
     * the browser resolves href="#/cart" against the host, decides that
     * https://<host>/#/cart is a different document from about:srcdoc, and does
     * a full navigation out of the preview. Measured: beforeunload fires, a load
     * event fires, and the frame stops answering. Every generated app routes on
     * the hash, so every screen transition did this.
     *
     * Setting location.hash instead operates on the document's own URL, which
     * really is about:srcdoc, so it stays a same-document fragment change and
     * hashchange fires normally for the app's router.
     */
    if (verdict === 'hash') {
      e.preventDefault();
      var frag = href.slice(1);
      // A bare "#" is a placeholder, not a destination. Following it would
      // navigate to the host page for nothing.
      if (frag && frag !== location.hash.slice(1)) location.hash = frag;
      return;
    }
    if (verdict === 'external') {
      e.preventDefault();
      // No emoji here either: this toast is injected into every generated page,
      // so it is the one glyph guaranteed to appear in output we tell the model
      // must contain none.
      mkToast('外部リンクはデモ環境では開きません', 'rgba(100,116,139,0.9)');
      return;
    }
    // Internal relative path — try smart in-page navigation, then prevent default
    e.preventDefault();
    var slug = href.replace(/^\\/+/, '').split('/').pop().replace(/\\.html?$/, '').replace(/[^a-z0-9_-]/gi, '') || href.replace(/^\\/+/, '').split('/')[0].replace(/[^a-z0-9_-]/gi, '');
    if (slug) {
      // 1. Anchor / section scroll
      var anchor = document.getElementById(slug) || document.querySelector('[name="' + slug + '"]') || document.querySelector('section[id*="' + slug + '"]');
      if (anchor) { anchor.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    }
    /**
     * Nothing to go to. Say so.
     *
     * This used to end here, silently: the click was cancelled and the page did
     * not move, which from the outside is identical to a broken button. The link
     * pointing at a screen the generation did not produce is exactly the case
     * being reported, so it is the one that most needs a sentence.
     */
    mkToast('この画面はまだ作られていません', 'rgba(100,116,139,0.9)');
  }, true);

  // Block form submit (show feedback instead of real submit)
  document.addEventListener('submit', function(e) {
    e.preventDefault();
    mkToast('送信しました（デモ）', 'rgba(22,163,74,0.95)');
  }, false);

  // Block window.open (popups). This one does take — measured.
  window.open = function() { return null; };

  /**
   * location.href / assign / replace cannot be blocked from in here.
   *
   * There used to be code that looked like it did: it redefined
   * Location.prototype.href and overwrote assign/replace/reload, all inside
   * try/catch. None of it took. Those are [LegacyUnforgeable] own properties of
   * the location object, so the descriptor lookup on the prototype returns
   * undefined and the assignments fail silently — the catch swallowed the
   * evidence, and the result was protection that read as present and was not.
   * Measured: all four of href=, assign(), replace() and a protocol-relative
   * href escaped the frame.
   *
   * So this is not defended here. It is caught by the watchdog in Preview.tsx,
   * which notices that the frame stopped being ours and puts the document back.
   * Prevention that cannot be verified is worse than a backstop that can.
   *
   * history.pushState / replaceState are deliberately left alone: they update
   * the URL without navigating, which is how JS routers work.
   */

  /**
   * Answers "are you still the document I wrote?".
   *
   * The host cannot look into an opaque-origin frame, so it cannot read the
   * frame's location and settle this itself. It asks, and only this script
   * replies — a page the frame navigated to has no such listener, so silence is
   * the answer.
   *
   * A reply, not an announcement. The first version of this posted once on
   * startup and had the host clear a flag on the load event, which is a race it
   * loses: the script runs during parsing and the load event fires after it, so
   * the answer arrived before the question and was thrown away. Measured — the
   * watchdog spent its whole retry budget on healthy loads before a user could
   * click anything. Asking makes the order irrelevant.
   */
  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'makeui-preview-ping') {
      try { parent.postMessage({ type: 'makeui-preview', kind: 'pong', nonce: e.data.nonce }, '*'); } catch (err) {}
    }
  });

  // ── Interactive feedback ──────────────────────────────────────────────────

  // Ripple on all interactive elements
  var rs = document.createElement('style');
  rs.textContent = '@keyframes _mkR{0%{transform:scale(0);opacity:.45}100%{transform:scale(2.5);opacity:0}}';
  (document.head || document.documentElement).appendChild(rs);

  function mkRipple(el, x, y) {
    var rect = el.getBoundingClientRect();
    var d = Math.max(el.offsetWidth, el.offsetHeight);
    var r = document.createElement('span');
    r.style.cssText = 'position:absolute;border-radius:50%;pointer-events:none;width:'+d+'px;height:'+d+'px;left:'+(x-rect.left-d/2)+'px;top:'+(y-rect.top-d/2)+'px;background:rgba(0,0,0,0.08);animation:_mkR 0.4s ease-out forwards;';
    var pos = getComputedStyle(el).position;
    if (pos === 'static') el.style.position = 'relative';
    el.style.overflow = 'hidden';
    el.appendChild(r);
    setTimeout(function() { r.remove(); }, 450);
  }
  document.addEventListener('click', function(e) {
    var el = e.target.closest('button,a,[role="button"],[type="submit"],[type="button"],[type="reset"],.btn,[class*="btn"],[class*="button"]');
    if (el) mkRipple(el, e.clientX, e.clientY);
  }, true);

})();
</script>
`;
