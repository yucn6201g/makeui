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

/** The `type` of the message a live thumbnail frame sends with its drawn page. */
export const SNAPSHOT_MESSAGE = 'makeui-thumbnail-snapshot';

/**
 * Put in a live (React/Vue) thumbnail document: once the app has drawn and
 * settled, send the page back as HTML, scripts removed and canvases turned into
 * images, so the card can show that next time in a frame with no scripts.
 *
 * Why (2026-09-27): every time a card came back on screen — a tab, a filter, a
 * scroll — its frame started the generated app from nothing, 10–25 ms of the
 * host's main thread per card, four times that on a slower machine. The page it
 * drew is the same each time; a static copy costs a parse and a layout.
 */
const SNAPSHOT_SCRIPT = `<script>(function(){
  function send(){try{
    var live=[].slice.call(document.querySelectorAll('canvas'));
    var copy=document.documentElement.cloneNode(true);
    var copies=copy.querySelectorAll('canvas');
    live.forEach(function(c,i){try{var r=c.getBoundingClientRect();var img=document.createElement('img');img.src=c.toDataURL();img.className=c.className;img.style.cssText=c.style.cssText;img.style.width=r.width+'px';img.style.height=r.height+'px';copies[i].replaceWith(img);}catch(e){}});
    [].forEach.call(copy.querySelectorAll('script'),function(s){s.remove();});
    parent.postMessage({type:'${SNAPSHOT_MESSAGE}',html:'<!DOCTYPE html>'+copy.outerHTML},'*');
  }catch(e){}}
  addEventListener('load',function(){setTimeout(function(){requestAnimationFrame(function(){requestAnimationFrame(send);});},800);});
})();</script>`;

/** A compiled thumbnail document that reports its drawn page — see SNAPSHOT_SCRIPT. */
export function withSnapshot(doc: string): string {
  const at = doc.search(/<\/body>/i);
  return at === -1 ? doc + SNAPSHOT_SCRIPT : doc.slice(0, at) + SNAPSHOT_SCRIPT + doc.slice(at);
}

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
