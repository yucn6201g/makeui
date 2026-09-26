import { splitHtmlToFiles } from './virtualFs';
import { detectKind } from './frameworkKind';

/**
 * Build a static, script-free document for a project thumbnail.
 *
 * The card iframe runs with `sandbox=""`, which disables scripts — deliberately,
 * since the list renders many of them at once. That leaves two cases the raw
 * stored HTML cannot satisfy:
 *
 *  - React output is only source blocks plus an empty <div id="root">, so nothing
 *    exists to paint without compiling it. Those get no preview.
 *  - Interactive HTML mocks hide every screen behind `.screen{display:none}` and
 *    let the router reveal one, so with scripts off the page paints blank. Those
 *    are recoverable by forcing the first screen visible.
 */

/**
 * True when the document only becomes a page after JS compiles it.
 *
 * Asked of the files the document unpacks into, not of the markup around them.
 * This used to test for `<script type="text/jsx">`, which is the OLD transport
 * and nothing else — so once projects moved to the line fence, every one of them
 * answered "no" and was treated as a finished web page.
 *
 * That single wrong answer produced both of the symptoms reported: the card
 * painted the project's own source as text, because a fenced document rendered
 * as HTML is just its own listing; and the list badge, which shares this
 * function, labelled React, Vue and Svelte projects alike as HTML.
 */
export function needsCompileToRender(html: string): boolean {
  return detectKind(splitHtmlToFiles(html)) !== null;
}

/**
 * CSS appended to the thumbnail so a JS-driven multi-screen mock still shows its
 * first screen. Uses :first-of-type rather than a class because the generated
 * markup names the active screen differently across outputs.
 */
const STATIC_REVEAL = `
<style>
  .screen, .spa-page, .spa-view, [data-screen] { display: block !important; }
  .screen ~ .screen,
  .spa-page ~ .spa-page,
  .spa-view ~ .spa-view,
  [data-screen] ~ [data-screen] { display: none !important; }
  /* Overlays would cover the shot; they are opened by script anyway. */
  dialog:not([open]), .modal, .drawer, .toast { display: none !important; }
  html, body { overflow: hidden !important; }
</style>`;

/** Returns a thumbnail-safe document, or null when there is nothing to show. */
export function toThumbnailDoc(html: string | undefined | null): string | null {
  if (!html || !html.trim()) return null;
  if (needsCompileToRender(html)) return null;

  const closeHead = html.search(/<\/head>/i);
  if (closeHead !== -1) {
    return html.slice(0, closeHead) + STATIC_REVEAL + html.slice(closeHead);
  }
  const openBody = html.search(/<body[^>]*>/i);
  if (openBody !== -1) {
    const after = html.indexOf('>', openBody) + 1;
    return html.slice(0, after) + STATIC_REVEAL + html.slice(after);
  }
  return STATIC_REVEAL + html;
}
