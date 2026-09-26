import {
  BedrockAgentCoreClient,
  StartBrowserSessionCommand,
  StopBrowserSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore'
import { SignatureV4 } from '@smithy/signature-v4'
import { createHash, createHmac } from 'node:crypto'
import type { AwsCredentialIdentityProvider } from '@smithy/types'
import { logger } from '../../utils/logger.js'
import { decodeReactErrors } from '../../utils/react-error.js'
import { toRunnableDocument } from '../project/react-bundle.js'

/**
 * Runs a generated document in a real browser and reports what actually happens.
 *
 * Every other check in this pipeline is a regular expression over the source. That
 * catches a missing route table; it cannot catch a page that renders two thirds
 * empty, a chart container with nothing drawn in it, or a nav item that is wired
 * to a handler which throws. Measured on a real run: a document scoring 92 with
 * zero detected defects had a dashboard whose content stopped a third of the way
 * down, and an edit that reported success added a Gantt screen whose chart was an
 * empty box. Both are invisible to static analysis and obvious in a screenshot.
 *
 * The document is pushed into the page with Page.setDocumentContent rather than
 * being published somewhere and navigated to. The user's generated work never
 * leaves AWS, and there is no temporary public URL to leak or clean up.
 */

const REGION = process.env.AWS_REGION || 'ap-northeast-1'
const BROWSER_ID = process.env.AGENTCORE_BROWSER_ID || ''
const VIEWPORT = { width: 1440, height: 900 }

/** Smithy wants a ChecksumConstructor. Node's crypto is one in everything but shape. */
class NodeSha256 {
  private h: ReturnType<typeof createHash> | ReturnType<typeof createHmac>
  constructor(secret?: unknown) {
    this.h = secret ? createHmac('sha256', secret as Buffer) : createHash('sha256')
  }
  update(chunk: any): void {
    this.h.update(chunk)
  }
  async digest(): Promise<Uint8Array> {
    return new Uint8Array(this.h.digest())
  }
  reset(): void {
    this.h = createHash('sha256')
  }
}

/** A box that rendered with nothing in it, described well enough to fill. */
export interface EmptyBox {
  area: number
  label: string
  /** Element id, when it has one. The most reliable way back to the source. */
  id: string
  /** The element's opening tag verbatim, for locating it in the document. */
  openTag: string
  width: number
  height: number
}

/** One element measured painting outside the box that holds it. */
export interface BrokenBox {
  /** `spill` — wider than its parent. `clipped` — its own content is cut off. */
  kind: 'spill' | 'clipped'
  /** How far, in pixels. */
  px: number
  /** The element, as tag plus its first class or two. */
  el: string
  parent: string
}

export interface ScreenFact {
  id: string
  /** How far down the viewport this screen's content reaches, 0-1. */
  fill: number
  /** Visible boxes bigger than 200x150 that contain no text and no visible children. */
  emptyBoxes: EmptyBox[]
  /** True when some control made this screen visible. */
  reachable: boolean
  /** Elements measured painting outside the box that holds them. */
  broken?: BrokenBox[]
  /**
   * Set when the screen's content region shows nothing while the shell around it
   * does: what hid it (`div.screen { display: none }`), or 'empty'. Its fill is 0.
   */
  hiddenBy?: string
}

/** A piece of text the page renders below the contrast floor. */
export interface ContrastFault {
  /** The text itself, enough of it to find. */
  text: string
  /** Foreground and the background actually painted behind it. */
  fg: string
  bg: string
  /** Measured ratio, 1..21. */
  ratio: number
  /** The floor this text had to clear: 3 for large text, 4.5 otherwise. */
  required: number
  /**
   * The text sits over a picture or a gradient, so `ratio` means nothing.
   *
   * Reported instead of a number, because the backdrop walk can only resolve
   * background COLOURS: a gradient scrim and a photograph are both invisible to
   * it, and it would otherwise measure the text against whatever opaque colour
   * happens to be further up the tree. Measured on a real hero — white heading
   * over a 30%-black gradient over a stock photo — and the answer it gave was
   * the page background.
   */
  overImage?: boolean
}

/** What the page does when the viewport is a phone. */
export interface MobileFact {
  /** Elements wider than the viewport — the cause of sideways scrolling. */
  overflow: string[]
  /** How far the document scrolls past the viewport width, in pixels. */
  overflowBy: number
  /** Content height over viewport height on the landing screen, 0-1. */
  fill: number
  /**
   * The width the page laid itself out at, on a 390px device.
   *
   * Not always 390. A document with no `<meta name="viewport">` gets the 980px
   * fallback layout viewport — on a real phone that is the page rendered
   * zoomed out to a third of its size, with unreadable text. It is a worse
   * defect than any overflow and it does not show up as one, because at 980px
   * the layout has all the room it wants.
   */
  layoutWidth: number
}

/** One form control that came out too small to use, as the page rendered it. */
export interface SmallField {
  /** Which screen it is on, so the repair knows where to look. */
  screen: string
  /** Its accessible name, placeholder or id — whatever it had. */
  label: string
  tag: string
  /** Rendered height in CSS pixels. */
  height: number
  /** Rendered font size in CSS pixels. */
  fontSize: number
}

export interface RuntimeFacts {
  screens: ScreenFact[]
  /** Nav controls that were clicked but changed nothing. */
  deadNav: string[]
  /** Buttons inside a screen that were clicked and did nothing at all. */
  deadActions: string[]
  /**
   * Controls that raised an exception when pressed, with what they raised.
   *
   * A different finding from a dead control, and a worse one: a dead button
   * does nothing, a throwing button takes the screen down.
   */
  throwing: { label: string; error: string }[]
  consoleErrors: string[]
  /** PNG of the first screen, base64. Empty when the capture failed. */
  screenshot: string
  /** Screens declared in the markup that no control could reach. */
  unreachable: string[]
  /**
   * Text failing WCAG AA, measured on the rendered page.
   *
   * The prompts have always asked for 4.5:1 and nothing has ever checked it —
   * the ratio appears once in this codebase, inside an instruction to a model.
   * For a product whose claim is machine-checked conformance to a public-sector
   * design system, that is the check that most needed to exist.
   */
  contrast: ContrastFault[]
  /** Form controls measured too small to comfortably use, across all screens. */
  smallFields: SmallField[]
  /** Null when the mobile pass could not run. */
  mobile: MobileFact | null
  /**
   * The walk stopped at its own deadline before it had finished.
   *
   * It is bounded at twenty seconds so a slow app cannot run the CDP transport
   * past its timeout, and hitting that bound is not a fact about the app. A
   * truncated walk under-reports in one direction only: screens it never opened
   * read as unreachable, and reach reads as low.
   *
   * This was logged and then dropped, so the score went on charging for it —
   * up to forty-five points for reach below half, plus five a screen. That is
   * the same shape as `stubbedComponents` before this morning: scored, and
   * recorded nowhere.
   */
  truncated: boolean
  /** Navigation lists rendered with browser bullets, by the element holding them. */
  unstyledNav?: string[]
  /** Icons drawn on a small grid (viewBox up to 48) rendered past 96px. */
  oversizedIcons?: string[]
  /** The shell as laid out, merged across screens. See preset-composition.ts. */
  layout?: LayoutFact
}

export interface LayoutFact {
  /** A full-width banner at the top, when there is one. Luminance 0-1, null when transparent. */
  header: { height: number; luminance: number | null } | null
  /** The widest nav or aside docked full-height at the left, px; 0 when none. */
  sideNavWidth: number
  /** A navigation bar across the foot of the viewport. */
  bottomNav: boolean
  /** A horizontal navigation or tab row near the top. */
  topNav: boolean
  /** A floating action button in the bottom-right corner. */
  fab: boolean
  breadcrumb: boolean
  table: boolean
  /** Destinations in the largest navigation region, breadcrumbs excluded. */
  navItems?: number
}

/**
 * Walks the app and measures every screen it can open.
 *
 * The first version probed once on arrival and once after the walk, then took
 * the union. On a five-screen app that measured two: the landing screen, and
 * whichever screen the walk happened to finish on. Everything in between — on a
 * real run, including the Gantt screen this check exists to catch — was never
 * looked at.
 *
 * Now the measurement happens inside the walk, right after each click, so every
 * screen a control opens is measured on the screen it opened.
 *
 * Rows and cards are walked as well as nav items, because that is how detail
 * screens are reached. Without them `project-detail` was reported as
 * unreachable on a document where clicking a table row opens it perfectly well —
 * a false positive that would have sent a correct page into a repair pass.
 */
/**
 * Exported so it can be run against a fixture in a real browser.
 *
 * Everything this expression decides — what counts as a screen, whether a click
 * did anything — is only true of an actual DOM, so a unit test in Node would be
 * testing a reimplementation rather than this.
 */
/**
 * How long the walk may take, as a promise the page keeps rather than a hope.
 *
 * The soft deadline below (20s) is checked between clicks, and it held for 551
 * of 552 walks over thirty days. The one it did not hold for was a user's
 * 在庫管理 run on 2026-09-20: `Runtime.evaluate` was still running when the
 * transport gave up at 45s, verification returned nothing, and the reply told
 * the user 「ブラウザ実行による検証は行っていません（このモードでは省略されます）」
 * about a 仕上げ run — a mode that had asked for it. Everything already measured
 * went with it: the screens it had reached, the console errors, the screenshot
 * taken before the walk began, and so the visual critic as well.
 *
 * A check between clicks bounds the walk only while every click comes back. A
 * step that does not — a handler whose promise never settles, a render that
 * takes the page with it for a while — runs straight through it. So the whole
 * walk now races a timer the page owns, and the timer answers with whatever the
 * walk has recorded so far, marked truncated. 32s: clear of the soft deadline,
 * and clear enough of the transport's 45s for the answer to be serialised and
 * sent.
 *
 * This bounds everything except a page whose main thread is blocked outright;
 * no timer on that page can fire, and nothing inside it can answer. That case
 * still reaches the transport timeout, and the pipeline says so honestly — see
 * `describeOutcome`.
 */
export const WALK_HARD_DEADLINE_MS = 32_000

/**
 * The prefix on the walk's announcement of each press. Distinctive so that no
 * app's own console.debug is read as one.
 */
export const WALK_MARK = '[makeui-walk] '

export const walkExpression = (
  declared: string[],
  // A test needs the cut-off in seconds rather than half a minute; nothing else
  // should pass this.
  hardDeadlineMs: number = WALK_HARD_DEADLINE_MS
) => `(() => {
  /*
   * Replaced as soon as the walk's state exists, which is before its first
   * await — so by the time the timer below can fire, this reads real state.
   */
  let partial = () => JSON.stringify({ screens: [], clicked: [], truncated: true, nav: [], hashIds: [], declared: [], cutOff: true });
  const body = (async () => {
  const DECLARED = ${JSON.stringify(declared)};
  const vh = window.innerHeight;
  /**
   * Every click is followed by a pause, and the walk is asynchronous for that
   * reason alone.
   *
   * An HTML mock's click handler swaps the screen synchronously, so reading the
   * DOM on the next line was correct there. React does not: createRoot schedules
   * the render, and a synchronous read after a nav click sees the screen you were
   * already on. Every React nav item would be measured as changing nothing, which
   * reads as an app whose whole navigation is dead.
   */
  const settle = () => new Promise((r) => setTimeout(r, 140));
  /**
   * The walk stops on its own before the transport gives up on it.
   *
   * Every CDP call shares one flat timeout, and this evaluate carries the whole
   * walk. When the walk widened — shell controls in the nav set, then a route
   * visit for every screen clicking never opened — a six-screen project ran
   * past it, Runtime.evaluate timed out, and the run lost EVERY fact rather
   * than the last few: no screens, no console errors, and a score reported
   * without any of it. Measured at v177 on a 40-file Vue project.
   *
   * Being thorough is worth having; being thorough at the price of returning
   * nothing is not. So the walk gives up its remaining clicks and returns what
   * it has, and says that it did.
   */
  const DEADLINE = Date.now() + 20000;
  const outOfTime = () => Date.now() > DEADLINE;
  let truncated = false;
  const visible = (e) => e.offsetParent !== null || getComputedStyle(e).position === 'fixed';

  /**
   * The screens currently on show, as {el, id} pairs.
   *
   * HTML mocks label them: every screen is a [data-screen] element and the
   * attribute is its id. A compiled React app has no such marker — the screen
   * lives in routes.ts, and the DOM only ever holds the one that is mounted. So
   * when nothing is labelled, the mounted tree IS the screen and the hash names
   * it. Without this fallback the probe finds zero elements, measures nothing,
   * and reports a working five-screen app as "画面 0件" — which is what it did.
   */
  /**
   * A fresh frame has no hash, so the landing screen has no name of its own.
   * Naming it 'home' recorded it as a screen the app does not have, and then
   * recorded it a second time under its real name once the walk navigated back
   * to it — one screen, counted twice, one of them under an invented id. The
   * declared list is the app's own vocabulary, and its first entry is the route
   * a generated router is required to default to.
   */
  /*
   * The screen name, without whatever is hanging off it.
   *
   * This took the first path segment and stopped, so a route carrying its
   * parameter in a query string became its own screen: v195 Vue reported
   * "reservation-detail?id=res1" alongside "reservation-detail" and measured
   * seven screens against six declared. The count was wrong in the flattering
   * direction, which is the worse one.
   */
  const hashId = () => (location.hash.replace(/^#\\/?/, '').split(/[/?#&]/)[0] || DECLARED[0] || 'home');
  /**
   * The element the app's output actually lives in.
   *
   * Vue and Svelte mount to '#app' by convention, so the preview shell nests a
   * container of that name inside #root. It is not app output, and counting it
   * would make an empty render measure as a rendered screen — so when it is the
   * only child, it is what we descend into.
   */
  const outputHost = () => {
    const root = document.getElementById('root');
    if (!root) return null;
    const alias = document.getElementById('app');
    return alias && alias.parentNode === root && root.children.length === 1 ? alias : root;
  };
  const shown = () => {
    const marked = [...document.querySelectorAll('[data-screen]')].filter(visible);
    if (marked.length) return marked.map((el) => ({ el, id: el.getAttribute('data-screen') }));
    const root = outputHost();
    return root && root.children.length > 0 ? [{ el: root, id: hashId() }] : [];
  };

  const measure = ({ el: s, id }) => {
    let bottom = 0;
    const empties = [];
    for (const el of s.querySelectorAll('*')) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      bottom = Math.max(bottom, r.bottom + window.scrollY);
      if (r.width <= 200 || r.height <= 150) continue;
      // An input is SUPPOSED to be empty. Measured: the fill pass wrote 586
      // characters of markdown documentation into a <textarea> that already had
      // a good placeholder, so the editor arrived pre-filled with a wall of
      // help text and the placeholder could never show. Filling it did not
      // repair a defect, it created one.
      if (/^(TEXTAREA|INPUT|SELECT|CANVAS|IFRAME|SVG|IMG|VIDEO|AUDIO|OBJECT|EMBED)$/.test(el.tagName)) continue;
      /*
       * Nothing inside a drawing is an empty container.
       *
       * A chart is made of rects, paths and groups, and none of them has text
       * children — that is what drawing is. A bar 300px wide reads here as a
       * box someone forgot to fill, and the repair cannot act on it: there is
       * nothing to put inside a <rect>. Measured on the v199 round, a sales
       * dashboard brief: React reported five and Vue six, twelve points each,
       * named chart-line, chart-segment, rect and segment.
       *
       * The list above cannot catch these. tagName is uppercase for HTML and
       * as-authored for SVG, so /^SVG$/ never matched even the <svg> root —
       * the namespace is the thing that actually distinguishes them.
       */
      if (el.namespaceURI === 'http://www.w3.org/2000/svg') continue;
      if (el.isContentEditable) continue;
      const text = (el.textContent || '').trim();
      const kids = [...el.children].filter(visible);
      const painted = el.querySelector('svg,img,canvas,table,input,select,textarea,button');
      if (!text && kids.length === 0 && !painted) {
        // The opening tag is carried out because it is what makes the box
        // findable in the source. A class name alone locates nothing: several
        // cards share one, and the repair needs to write into exactly this
        // element and no other.
        const openTag = el.outerHTML.slice(0, el.outerHTML.indexOf('>') + 1);
        empties.push({
          area: Math.round(r.width * r.height),
          // el.className is an SVGAnimatedString on an SVG element, not a
          // string, and it is truthy — so String(...) produced the literal
          // text "[object SVGAnimatedString]". That is what the v197 run
          // reported as the name of an empty container, which names nothing and
          // leaves the repair with a finding it cannot act on. The attribute is
          // a string on every element, which is why describe above reads it.
          label: (el.getAttribute('class') || el.tagName).slice(0, 40),
          id: el.id || '',
          openTag: openTag.slice(0, 300),
          width: Math.round(r.width),
          height: Math.round(r.height),
        });
      }
    }
    /**
     * Form controls too small to use.
     *
     * Measured rather than asked for, like everything else here. The prompts
     * have always described comfortable field sizing and the output kept
     * arriving with 24px inputs, because a rule nothing checks is a suggestion.
     *
     * 36px is the floor rather than the 44px touch target: dense enterprise
     * tables legitimately run tighter than a phone form, and a check that fires
     * on every admin screen would be turned off within a week. Font size is the
     * other half and the one that bites on a real device — under 16px iOS zooms
     * the page on focus, which is why a cramped field is not only hard to read
     * but knocks the whole layout sideways when you tap it.
     *
     * Checkboxes, radios, sliders and colour swatches are supposed to be small.
     */
    const fields = [];
    for (const el of s.querySelectorAll('input,select,textarea')) {
      if (!visible(el)) continue;
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (/^(checkbox|radio|range|color|file|hidden|submit|button|image|reset)$/.test(type)) continue;
      const box = el.getBoundingClientRect();
      if (box.height < 2 || box.width < 2) continue;
      const cs = getComputedStyle(el);
      const fs = parseFloat(cs.fontSize) || 0;
      const h = Math.round(box.height);
      if (h >= 36 && fs >= 14) continue;
      fields.push({
        label: (el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
                el.getAttribute('name') || el.getAttribute('id') || el.tagName).slice(0, 30),
        tag: el.tagName.toLowerCase(),
        height: h,
        fontSize: Math.round(fs * 10) / 10,
      });
      if (fields.length >= 6) break;
    }

    const describe = (el) => {
      const cls = (el.getAttribute("class") || "").split(/[ ]+/).filter(Boolean).slice(0, 2).join(".");
      return (el.tagName.toLowerCase() + (cls ? "." + cls : "")).slice(0, 48);
    };
    /**
     * Layout that has visibly come apart, measured on the rendered screen.
     *
     * The audits before this one all ask about the SOURCE — which classes exist,
     * where the styling lives, whether a control has a handler. None of them can
     * see a bar drawn past the end of its track, a table pushing the page
     * sideways, or a card whose text has escaped its box, and those are exactly
     * what a person means by 「デザインが乱れている」. A screenshot shows it and a
     * vision model can describe it, but neither produces a number the repair
     * loop can be held to.
     *
     * Three things, all of them unambiguous at the DOM level:
     *
     *   - a child painted wider than the element containing it. The measured
     *     case was a percentage width driven by a ratio that reached 184, but an
     *     absolute width or an unbroken string does it too.
     *   - content scrolling sideways inside a box that was not asked to scroll.
     *   - text overflowing its own line box, which is what an unwrapped long
     *     word or a fixed-height row looks like.
     *
     * Bounded at six per screen: these come in families — one broken rule
     * produces forty findings — and a repair instruction listing forty is a
     * repair instruction nobody can act on.
     */
    const broken = [];
    const SLACK = 2; // sub-pixel rounding, not a defect
    for (const el of s.querySelectorAll('*')) {
      if (broken.length >= 6) break;
      if (!visible(el)) continue;
      const parent = el.parentElement;
      if (!parent || parent === s) continue;
      /*
       * Same reason as the empty-box pass: a drawing is not a layout.
       *
       * An SVG child routinely paints outside its parent's box — that is what
       * transforms and viewBox scaling do — and scrollWidth/clientWidth describe
       * a CSS box that an SVG element does not have. The v199 round reported
       * "text.chart-y-label の中身が 19px はみ出して切れている" on a chart axis
       * label, which is a finding no repair can act on.
       */
      if (el.namespaceURI === 'http://www.w3.org/2000/svg') continue;
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' || cs.position === 'absolute') continue;

      const box = el.getBoundingClientRect();
      const pbox = parent.getBoundingClientRect();
      if (box.width < 4 || pbox.width < 4) continue;

      const pcs = getComputedStyle(parent);
      const parentScrolls = /auto|scroll/.test(pcs.overflowX) || /auto|scroll/.test(pcs.overflow);
      const selfScrolls = /auto|scroll/.test(cs.overflowX) || /auto|scroll/.test(cs.overflow);

      const spill = Math.round(box.right - pbox.right);
      if (!parentScrolls && spill > SLACK && box.width <= pbox.width * 3) {
        broken.push({
          kind: 'spill',
          px: spill,
          el: describe(el),
          parent: describe(parent),
        });
        continue;
      }
      // Content wider than the box that holds it, where nothing asked to scroll.
      const hidden = Math.round(el.scrollWidth - el.clientWidth);
      if (!selfScrolls && hidden > SLACK && el.clientWidth > 0) {
        broken.push({ kind: 'clipped', px: hidden, el: describe(el), parent: describe(parent) });
      }
    }

    /*
     * The screen's own content, apart from the shell around it.
     *
     * \`bottom\` is taken over everything under the host, and when nothing is
     * marked [data-screen] the host is the whole app — so a full-height side nav
     * reaches the bottom of the viewport on its own. Measured on the carbon run of
     * 2026-09-14: the stylesheet said \`.screen { display: none }\` unless
     * \`.is-active\`, no screen ever got the class, the main area was blank, and
     * every screen measured fill 1.0. The run shipped at 78 with nothing reported.
     *
     * Only the case where the content region shows NOTHING is changed, and it
     * becomes fill 0. A short screen beside a tall nav keeps the fill it had;
     * moving every fill would move every score for a defect this narrow.
     */
    const SHELL = 'header, nav, aside, footer, [role="banner"], [role="navigation"], [role="complementary"], [role="contentinfo"]';
    const region = s.querySelector('main, [role="main"]') || s;
    const outsideShell = (el) => region !== s || !el.closest(SHELL);
    let contentShows = false;
    for (const el of region.querySelectorAll('*')) {
      if (!outsideShell(el) || !visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width >= 2 && r.height >= 2) { contentShows = true; break; }
    }
    let fill = Math.min(1, bottom / vh);
    let hiddenBy;
    if (!contentShows && fill > 0) {
      fill = 0;
      // Name what hid it: the outermost hidden element that still holds text.
      const candidates = [region, ...region.querySelectorAll('*')].filter((el) => {
        if (!outsideShell(el)) return false;
        const cs = getComputedStyle(el);
        return (cs.display === 'none' || cs.visibility === 'hidden') && (el.textContent || '').trim().length >= 10;
      });
      const outer = candidates.find((el) => !candidates.some((o) => o !== el && o.contains(el)));
      hiddenBy = outer
        ? describe(outer) + ' { ' + (getComputedStyle(outer).display === 'none' ? 'display: none' : 'visibility: hidden') + ' }'
        : 'empty';
    }
    /*
     * The runtime's error panel is on screen: this screen threw while it
     * rendered, and what the user sees is the panel the runtime put there
     * instead of a blank page. It is measured as the failure it is — fill 0,
     * named — so catching the throw for the user never reads to the pipeline
     * as a screen that worked. (No backticks: this is a template literal.)
     */
    if (document.querySelector('[data-makeui-render-error]')) {
      fill = 0;
      hiddenBy = 'render-error';
    }

    /*
     * Styling that never arrived, by the two symptoms it leaves on screen.
     *
     * A class a component uses and no stylesheet defines is common and mostly
     * harmless — measured over 38 stored projects, 33 had one, most of them hooks
     * like \`rooms-screen\` that were never meant to carry style. What matters is
     * where the missing style was holding something up, and two shapes of that
     * are visible and unambiguous:
     *
     *   a navigation list still wearing browser bullets (7 of the 38, including
     *   the digital-agency run of 2026-09-14 whose \`da-nav*\` classes existed
     *   nowhere), and
     *   an icon drawn on a 24-unit grid rendered at hundreds of pixels because
     *   nothing sized it (4 of 38, up to 990px).
     */
    const unstyledNav = [];
    // The whole page, not the screen: a marked [data-screen] leaves the shell's nav outside it.
    for (const list of document.querySelectorAll('nav ul, nav ol, header ul, header ol, [role="navigation"] ul, [role="navigation"] ol')) {
      const items = [...list.children].filter((li) => li.tagName === 'LI' && visible(li));
      if (items.length < 2) continue;
      const lcs = getComputedStyle(items[0]);
      if (lcs.display === 'list-item' && lcs.listStyleType !== 'none') {
        unstyledNav.push(describe(list.closest('nav, header, [role="navigation"]') || list));
      }
    }
    const oversizedIcons = [];
    for (const svg of document.querySelectorAll('svg')) {
      const vb = (svg.getAttribute('viewBox') || '').replace(/,/g, ' ').split(' ').filter(Boolean).map(Number);
      if (vb.length !== 4 || vb[2] > 48 || vb[3] > 48) continue;
      const r = svg.getBoundingClientRect();
      if (r.width > 96 || r.height > 96) {
        oversizedIcons.push(describe(svg.parentElement || svg) + ' > svg ' + Math.round(r.width) + 'x' + Math.round(r.height) + 'px');
      }
    }

    /*
     * The shell, as it was laid out — for checking a design system's composition.
     *
     * Read from rendered boxes, not from CSS. Measured on the preset runs of
     * 2026-09-14: Spindle's bottom navigation was an ordinary flex child at the
     * foot of a full-height column, which no rule in the stylesheet says; only the
     * rendered position does. The facts are neutral; what a system expects of them
     * is decided in preset-composition.ts.
     */
    const vw = window.innerWidth;
    const shows = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
    const luminance = (colour) => {
      const n = (colour.match(/[0-9.]+/g) || []).map(Number);
      if (n.length < 3 || (n.length > 3 && n[3] === 0)) return null;
      return Math.round(((0.2126 * n[0] + 0.7152 * n[1] + 0.0722 * n[2]) / 255) * 100) / 100;
    };
    const controlsIn = (el) => el.querySelectorAll('a, button, [role="tab"], [role="link"]').length;
    const layout = { header: null, sideNavWidth: 0, bottomNav: false, topNav: false, fab: false, breadcrumb: false, table: false, navItems: 0 };
    for (const el of document.querySelectorAll('header, [role="banner"]')) {
      if (!shows(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.top > 2 || r.width < vw * 0.6) continue;
      let lum = luminance(getComputedStyle(el).backgroundColor);
      if (lum === null && el.firstElementChild) lum = luminance(getComputedStyle(el.firstElementChild).backgroundColor);
      layout.header = { height: Math.round(r.height), luminance: lum };
      break;
    }
    for (const el of document.querySelectorAll('nav, aside, [role="navigation"]')) {
      if (!shows(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.left <= 2 && r.height >= vh * 0.5 && r.width >= 48 && r.width <= 360) layout.sideNavWidth = Math.max(layout.sideNavWidth, Math.round(r.width));
      // A <nav> is navigation by what it is, so one destination is enough; an aside
      // at the foot needs two. Measured on the spindle run of 2026-09-14: a real
      // bottom bar carrying a single destination was read as no bottom nav at all.
      else if (r.bottom >= vh - 4 && r.width >= vw * 0.6 && r.height >= 40 && r.height <= 112 &&
        controlsIn(el) >= (el.tagName === 'NAV' || el.getAttribute('role') === 'navigation' ? 1 : 2)) layout.bottomNav = true;
      // Horizontal, not wide: a header nav set to the right of the product name is a few hundred pixels.
      else if (r.top < 240 && r.height <= 112 && r.width >= r.height * 3 && controlsIn(el) >= 3) layout.topNav = true;
    }
    // How many destinations the primary navigation offers. A breadcrumb trail is not one.
    for (const el of document.querySelectorAll('nav, [role="navigation"]')) {
      if (!shows(el) || /breadcrumb|パンくず/i.test((el.getAttribute('class') || '') + (el.getAttribute('aria-label') || ''))) continue;
      layout.navItems = Math.max(layout.navItems, controlsIn(el));
    }
    for (const el of document.querySelectorAll('[role="tablist"]')) {
      if (shows(el) && el.getBoundingClientRect().top < 240 && el.querySelectorAll('[role="tab"]').length >= 3) layout.topNav = true;
    }
    for (const el of document.querySelectorAll('button, a')) {
      if (!shows(el)) continue;
      const pos = getComputedStyle(el).position;
      if (pos !== 'fixed' && pos !== 'absolute' && pos !== 'sticky') continue;
      const r = el.getBoundingClientRect();
      if (r.right >= vw - 160 && r.bottom >= vh - 160 && r.width >= 40 && r.width <= 100 && r.height >= 40 && r.height <= 100) layout.fab = true;
    }
    layout.breadcrumb = [...document.querySelectorAll('[aria-label*="breadcrumb" i], [aria-label*="パンくず"], [class*="breadcrumb"]')].some(shows);
    layout.table = [...document.querySelectorAll('table, [role="grid"], [role="table"]')].some(shows);

    return { id, fill, emptyBoxes: empties.slice(0, 4), fields, broken, hiddenBy, unstyledNav, oversizedIcons, layout };
  };

  const screens = new Map();
  /**
   * Ids that came from a real hash, as opposed to the DECLARED[0] fallback the
   * landing screen borrows. Reported separately because the caller uses them to
   * decide whether the app's routes and its declared screen ids are even the
   * same vocabulary — and a borrowed id would guarantee a match and answer the
   * question with its own assumption.
   */
  const hashIds = new Set();
  /*
   * A route is a screen only if something rendered for it.
   *
   * With no [data-screen] marker the screen's id is read from the hash, so a
   * hash that changed while the page did not became a new screen measuring the
   * old one. Measured on the spindle Vue run of 2026-09-15: the router watched
   * location.hash with Vue's watch(), which never fires, so no button moved
   * the app — and all six routes were recorded at fill 1.0, every one of them the
   * home screen. The same text under a second id is the first screen still
   * showing, not a second screen.
   */
  const firstIdByContent = new Map();
  const record = () => {
    if (location.hash) hashIds.add(hashId());
    for (const s of shown()) {
      const marked = s.el.hasAttribute && s.el.hasAttribute('data-screen');
      if (!marked) {
        const content = hash((s.el.innerText || '').slice(0, 4000));
        const seenAs = firstIdByContent.get(content);
        if (seenAs !== undefined && seenAs !== s.id && !screens.has(s.id)) continue;
        if (seenAs === undefined) firstIdByContent.set(content, s.id);
      }
      const m = measure(s); const p = screens.get(m.id);
      if (!p || m.fill > p.fill) screens.set(m.id, m);
    }
  };
  const key = () => shown().map((s) => s.id).join(',');

  /**
   * Whether the page responded to a click at all, as distinct from whether it
   * navigated.
   *
   * The dead-nav check used to ask only whether the set of visible screens
   * changed, and NAV_SELECTOR deliberately matches 'nav button' — so a menu
   * toggle, a notification bell, a user dropdown and a filter tab were all
   * clicked, all opened correctly, all left the screen set alone, and were all
   * reported as navigation that does nothing. The repair pass then went looking
   * for a routing bug in a working shell.
   *
   * Three cheap signals, none of which forces a layout beyond innerText: the
   * element count catches a menu or dialog being mounted, the rendered text
   * catches a content swap, and the state attributes catch a toggle that only
   * flips aria. A control that moves none of them did nothing.
   */
  /**
   * Hashed rather than measured by length.
   *
   * Measured on a real storefront: "カートに追加" moved the cart badge from 0 to
   * 1, which is the state change the button exists to make, and a length
   * comparison saw two identical numbers and called the button dead. Any
   * same-length edit — a counter, a status word, a toggled label — was
   * invisible. The hash costs a pass over a few kilobytes, twice per click.
   */
  const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; };
  /*
   * Classes and field values too.
   *
   * Replaying 33 stored outputs, two working controls were still reported dead
   * because what they change is invisible to innerText: a filter chip that only
   * moves btn--filter-active onto itself (its list happened to be the same),
   * and 「デモアカウントを入力」, which writes the demo credentials into fields the
   * walk had already filled — a value is not text. Both are a response a user
   * sees.
   */
  const sig = () =>
    document.querySelectorAll('body *').length + '|' +
    document.querySelectorAll(
      '[aria-expanded="true"],[open],[aria-selected="true"],[aria-current],[data-state="open"],.is-open,.active'
    ).length + '|' +
    hash(document.body.innerText || '') + '|' +
    hash([...document.querySelectorAll('body [class]')].map((e) => e.getAttribute('class')).join(' ')) + '|' +
    hash([...document.querySelectorAll('input, textarea, select')].map((e) => e.value + (e.checked ? '1' : '')).join('|'));

  /**
   * Exceptions raised by the app, and which control was pressed when.
   *
   * The walk pressed every control inside "try { el.click() } catch {}", which
   * reads as defensive and is not: a React event handler does not throw back
   * through el.click() at all — React reports it asynchronously — so the catch
   * saw nothing, and the exception reached the page as an uncaught error with
   * no connection to the button that caused it.
   *
   * It did land in the console-error list, which is how the run knew SOMETHING
   * threw. That is a weak finding: the repair planner is handed a stack trace
   * into a bundled file it cannot see, and has to work out both which control
   * and which source line. Measured, reported by a user clicking a product card:
   *
   *     TypeError: Cannot read properties of undefined (reading 'params')
   *       at hash (about:srcdoc:1465:61)
   *       at onClick (about:srcdoc:1711:30)
   *
   * Trapping here lets the finding say "詳細を見る threw TypeError: …", which
   * names the control, and the control is what the repair has to fix.
   */
  const thrown = [];
  /*
   * A mock's confirmation dialog is answered yes.
   *
   * 「提出」 on a stored expense form calls window.confirm before it submits. A
   * dialog the walk cannot answer is answered no — or, in a browser driven over
   * CDP, blocks the page — and the submit was reported dead. The destructive
   * labels are already never pressed (SKIP_ACTION), so what is left behind a
   * confirm is the step the screen exists for.
   */
  window.confirm = () => true;
  window.alert = () => {};
  window.prompt = () => '';
  window.addEventListener('error', (e) => {
    thrown.push(String((e.error && e.error.message) || e.message || 'error').slice(0, 200));
  });
  window.addEventListener('unhandledrejection', (e) => {
    thrown.push(String((e.reason && e.reason.message) || e.reason || 'rejection').slice(0, 200));
  });
  record();
  const nav = [];
  /*
   * What this walk would say if it were stopped here. The same shape as its
   * own answer at the end, with cutOff set so the pipeline can tell a walk
   * that ended from one that was ended. (No backticks in this comment: the
   * whole walk is one template literal, and one here ends it.)
   */
  let clicked = null;
  partial = () => JSON.stringify({
    screens: [...screens.values()],
    clicked: clicked ?? [...screens.keys()],
    truncated: true,
    cutOff: true,
    nav,
    tzOffset: new Date().getTimezoneOffset(),
    hashIds: [...hashIds],
    declared: [...document.querySelectorAll('[data-screen]')].map((s) => s.getAttribute('data-screen')),
  });
  const press = async (el, kind) => {
    /*
     * Said out loud BEFORE the click. A click whose handler takes the page's
     * main thread with it never comes back to say what it was, and nothing
     * after it can run — but this has already been sent. console.debug so it
     * is nobody's error.
     */
    console.debug(${JSON.stringify(WALK_MARK)} + kind + '|' + location.hash + '|' + ((el.textContent || el.value || el.getAttribute('aria-label') || '').trim()).slice(0, 60));
    const before = key();
    const sigBefore = sig();
    const hashBefore = location.hash;
    const thrownBefore = thrown.length;
    // Kept, but it is not the interesting path: a React handler reports its
    // error asynchronously rather than throwing back through click().
    try { el.click(); } catch (e) { thrown.push(String((e && e.message) || e).slice(0, 200)); }
    await settle();
    const after = key();
    record();
    /*
     * The page has to change, not only the address. An unmarked screen's id is
     * the hash, so a router that sets the hash and never re-renders (the spindle
     * Vue run of 2026-09-15) read as a working navigation on every press.
     */
    const pageChanged = sig() !== sigBefore;
    nav.push({
      kind,
      label: (el.textContent || '').trim().slice(0, 20),
      href: el.getAttribute('href') || '',
      /*
       * What the control says it is. A nav item for the screen already showing
       * carries aria-current="page" — the build contract requires it — and
       * clicking it correctly does nothing.
       *
       * Read AFTER the click, which is where this whole object is built, and
       * that is the right moment rather than a convenient one: it is only
       * consulted for a click that did NOT respond, and a click that did not
       * respond left the page as it was. So this is the state the control was
       * in when it was pressed. Reading it before would say the same thing and
       * would also mark every item that has just BECOME current, which is the
       * opposite case.
       *
       * Written without backticks on purpose: this whole walk is a template
       * literal, so a backtick in a comment ends the string and the file stops
       * parsing halfway through a function.
       */
      current: el.getAttribute('aria-current') || (el.closest && el.closest('[aria-current]') ? el.closest('[aria-current]').getAttribute('aria-current') : '') || '',
      /*
       * Whether this control acts on fields rather than on its own.
       *
       * The walk fills empty fields before it presses anything, and skips any
       * field that already holds a value — which a React form almost always
       * does, because its inputs are bound to state with defaults. So 適用 on a
       * price filter that already reads 0 to 30000 applies the range it already
       * had, nothing moves, and a working button is reported dead. Measured on
       * the storefront of 2026-09-20: the handler is there, it runs, and it has
       * nothing to do.
       *
       * The same shape covers 送信, 予約する, 検索 and カートに追加 — 84 of the
       * labels this finding reported in 30 days. A control whose effect is a
       * function of input the walk never varied is not something this walk can
       * judge, and saying so is more honest than reporting it and spending a
       * repair call on a button that works.
       *
       * Four levels, because a filter panel is a div in a div in a section.
       */
      actsOnFields: (() => {
        let node = el.parentElement;
        for (let up = 0; up < 4 && node; up++, node = node.parentElement) {
          if (node.querySelector('input:not([type=hidden]), select, textarea')) return true;
        }
        return false;
      })(),
      hashBefore,
      before,
      after,
      changed: before !== after && pageChanged,
      responded: pageChanged,
      // Anything the app threw while this control was being pressed.
      threw: thrown.slice(thrownBefore, thrownBefore + 2),
    });
  };

  /**
   * One row on whatever screen is showing now.
   *
   * Detail screens open from a row or a card, never from the nav — and in a
   * React app the rows only exist while their list is mounted. The first version
   * walked all the nav items and then looked for rows, by which point the app
   * was on the settings screen and there were none: the detail screen came back
   * as unreachable on an app where clicking a row opens it perfectly well. So
   * rows are tried where they actually are, on each screen as it is reached.
   */
  let rowsTried = 0;
  const tryRow = async () => {
    if (rowsTried >= 6 || outOfTime()) return;
    const s = document.querySelector('[data-screen]') ? '[data-screen] ' : '#root ';
    const row = document.querySelector(
      [s + 'tbody tr', s + '.card', s + '[data-id]', s + 'li[role="button"]'].join(',')
    );
    if (!row) return;
    rowsTried++;
    /*
     * A row pressed here is not pressed again as an action.
     *
     * A row with role="button" matches ACTION_SELECTOR too, and selecting the
     * row that is already selected correctly changes nothing. The same replay:
     * 「1Q84村上春樹913.6-M佐藤花子2」 opened its modal as a row, was pressed again
     * as an action a moment later, and was reported as a dead button.
     */
    pressedRows.add(row);
    actionLabels.add(((row.textContent || '').trim()).slice(0, 20));
    await press(row, 'row');
  };
  const pressedRows = new WeakSet();

  /**
   * Nav controls, found by role and by destination rather than by convention.
   *
   * The selector used to be a list of the places a nav usually lives — nav, aside,
   * .sidebar. Measured on a generated React app that puts its sidebar in a plain
   * div: three screens out of ten were reached and the other seven were reported
   * unreachable, which is a defect in the probe being read as a defect in the app.
   * A hash-routed app names its destinations in the markup, so href="#/..." finds
   * them whatever the surrounding element is called.
   */
  /**
   * The buttons inside a screen, which nothing was clicking.
   *
   * The walk pressed nav items and rows, so "the mock works" meant "you can move
   * between screens". Everything the screens are actually for — 追加, 保存,
   * フィルタ, 承認 — was never pressed by anything, and a button wired to no
   * handler at all shipped looking exactly like one that works. This is the
   * check for the product's own claim that what it generates is an operable mock
   * rather than a picture of one.
   *
   * Deliberately narrow about what it will press. A destructive control would
   * delete the content every later measurement depends on, and a control whose
   * whole effect is outside the page — copy, download, print — cannot be
   * observed here and would be reported as dead for doing its job correctly.
   */
  const ACTION_SELECTOR = 'button, [role="button"], input[type="submit"], input[type="button"]';
  const SKIP_ACTION =
    /削除|消去|破棄|取り消|ログアウト|サインアウト|リセット|初期化|コピー|共有|印刷|ダウンロード|エクスポート|delete|remove|logout|sign ?out|reset|copy|share|print|download|export/i;
  /**
   * A mock has no server, so a real form submission only reloads the page and
   * restarts the walk from nothing. The handler is the thing being measured;
   * the browser's default is not.
   */
  document.addEventListener('submit', (e) => e.preventDefault(), true);

  /**
   * Fill the screen's empty fields before pressing anything.
   *
   * The walk never typed. Every form that validates on submit therefore refused
   * to advance, and every screen reachable only through one — a confirmation, a
   * receipt, a 完了 — was counted unreachable and deducted for. Measured on a
   * 粗大ごみ申込み brief whose whole subject is a five-step form: React declared
   * eight screens, was marked down for 'complete', and the screen was fine. The
   * document was being penalised for the walk's inability to type.
   *
   * The values are plausible rather than minimal, because a validator that
   * wants an email or a date is entitled to one and a form that rejects 'x'
   * has done its job correctly. Nothing here is a shortcut past validation:
   * these go in through the field, and a form that still refuses to submit has
   * refused for a reason worth reporting.
   *
   * React does not read el.value = v. It tracks the value on the node and
   * skips the change as a no-op, so the prototype setter is called directly —
   * the standard workaround, and the reason a naive fill silently does nothing
   * in exactly one of the three frameworks.
   */
  const setValue = (el, v) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, v); else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  /*
   * Today, not a fixed date.
   *
   * This was '2026-09-15'. Replayed on 2026-09-13, two expense forms rejected it —
   * 「過去の日付を選択してください」, an expense cannot be in the future — and
   * their 提出 buttons were reported dead: the validator refused, the error was
   * already on screen from the draft save, and nothing changed. A fixed date
   * turns into a future date or a stale one depending on the day the walk runs;
   * the day it runs is valid for both a past-only and a from-today validator.
   */
  const pad2 = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const todayIso = now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
  const SAMPLE = {
    email: 'taro.yamada@example.com',
    tel: '090-1234-5678',
    url: 'https://example.com',
    number: '3',
    date: todayIso,
    time: '10:00',
    'datetime-local': todayIso + 'T10:00',
    month: todayIso.slice(0, 7),
    week: '2026-W38',
    password: 'Passw0rd!23',
    search: 'ソファ',
    text: '山田太郎',
    /*
     * A sentence, not a name. A textarea is a purpose, a reason, a comment — and
     * validators ask for one: 「目的は10文字以上入力してください」 refused 山田太郎
     * on a stored expense form, the error stayed on screen, and its 提出 was
     * reported dead.
     */
    textarea: '会議資料の印刷費として立て替えた分の精算をお願いします。',
  };
  const fillFields = (host) => {
    for (const el of host.querySelectorAll('input, textarea, select')) {
      if (!visible(el) || el.disabled || el.readOnly) continue;
      if (el instanceof HTMLSelectElement) {
        // The first option is very often the "選択してください" placeholder, and
        // choosing it is the same as choosing nothing.
        const pick = [...el.options].find((o) => !o.disabled && o.value && o.index > 0)
          || [...el.options].find((o) => !o.disabled && o.value);
        if (!pick || el.value === pick.value) continue;
        el.value = pick.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        continue;
      }
      const type = (el.type || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        // Only where something is required, so an optional 「メール配信を希望」
        // is not ticked on the user's behalf.
        if (el.checked || !(el.required || el.closest('[aria-required="true"]'))) continue;
        el.click();
        continue;
      }
      if (/^(hidden|file|submit|button|reset|image|range|color)$/.test(type)) continue;
      if (el.value) continue;
      setValue(el, SAMPLE[type] ?? SAMPLE.text);
    }
  };

  let actionsTried = 0;
  const actionLabels = new Set();
  const tryActions = async () => {
    /*
     * The candidates are read again before every press.
     *
     * A list taken once goes stale the moment a press changes the page. Pressing
     * what was on it anyway reported working controls as dead — measured by
     * replaying the 2026-09-13 run's document through this walk: the row click
     * opened a detail modal, 「×」 and 「貸出登録」 were read from it, 「×」 closed
     * it, and 「貸出登録」 was clicked while detached from the document. Replayed
     * over 33 stored outputs, most of the walk's dead actions were that shape.
     *
     * Skipping the stale ones fixed the false findings and lost their coverage:
     * a control that only exists after an earlier press was never pressed at all.
     * Reading the page again keeps both — what is gone is not pressed, and what
     * has appeared is.
     */
    const collect = () => {
      const marked = [...document.querySelectorAll('[data-screen]')].filter(visible);
      const host = marked.length ? marked[0] : document.getElementById('root');
      if (!host) return [];
      fillFields(host);
      return [...host.querySelectorAll(ACTION_SELECTOR)].filter((e) => {
        if (!visible(e) || e.disabled || pressedRows.has(e)) return false;
        /**
         * The shell is not the screen.
         *
         * Measured on a real storefront: the wordmark "SHOP" in the header is a
         * link home, and pressing it while already home correctly does nothing —
         * reported as a dead button. A header, a nav and a sidebar hold the same
         * kind of control, and none of them is what "the screen's own actions"
         * means.
         */
        if (e.closest('nav,header,aside,footer,[role="navigation"],[role="banner"],.sidebar,[data-nav]')) return false;
        /**
         * A control already in its selected state is expected to do nothing.
         *
         * The filter chip reading "すべて" on a list that is already unfiltered is
         * the in-screen twin of the nav item pointing at the current screen, and
         * it was reported for behaving correctly.
         */
        if (e.matches('[aria-selected="true"],[aria-pressed="true"],[aria-current],.active,.is-active,[data-active="true"]')) return false;
        const t = ((e.textContent || e.value || '').trim()).slice(0, 20);
        return t && !SKIP_ACTION.test(t) && !actionLabels.has(t);
      });
    };
    for (let pressedHere = 0; pressedHere < 2; pressedHere++) {
      if (outOfTime() || actionsTried >= 8) return;
      const el = collect()[0];
      if (!el) return;
      actionsTried++;
      actionLabels.add(((el.textContent || el.value || '').trim()).slice(0, 20));
      await press(el, 'action');
      const rec = nav[nav.length - 1];
      if (!rec.responded) await probeSelected(el, rec);
    }
  };
  /*
   * Whether a control that did nothing was simply already selected.
   *
   * 「月払い」 on a pricing page that opens on monthly, 「おすすめ順」 on a list
   * already in that order, 「申請者として利用」 for a user who is the applicant:
   * pressing each correctly changes nothing. The selected-state selectors above
   * cannot see them, because all three mark "selected" with a styling class
   * (btn-primary) and no attribute.
   *
   * So it is asked of the page instead of guessed from a class name: press a
   * sibling in the same group, and if that responds without leaving the screen,
   * press the original again. A control that responds on the way back was the
   * selected one; a control that still does nothing is dead. Two clicks, only
   * for controls already about to be reported, and the group ends as it began.
   */
  const probeSelected = async (el, rec) => {
    const parent = el.parentElement;
    if (!parent) return;
    const label = (e) => ((e.textContent || e.value || '').trim()).slice(0, 20);
    const group = [...parent.children].filter((e) => e !== el && e.matches(ACTION_SELECTOR) && visible(e) && !e.disabled);
    if (group.length === 0 || group.length > 6) return;
    const other = group.find((e) => label(e) && !SKIP_ACTION.test(label(e)));
    if (!other) return;
    await press(other, 'probe');
    const moved = nav[nav.length - 1];
    if (!moved.responded || moved.changed || !el.isConnected) return;
    await press(el, 'probe');
    if (nav[nav.length - 1].responded) {
      rec.responded = true;
      rec.alreadySelected = true;
    }
  };

  await tryRow();
  await tryActions();
  const NAV_SELECTOR = [
    'nav a', 'nav button', 'aside a', 'aside button',
    '.sidebar a', '.sidebar button', '[data-nav]',
    // A cart opened from a header icon is navigation by function and not by
    // element: no <nav>, no href, just a button in the shell. It sat outside
    // every selector here, and tryActions could not reach it either — that one
    // presses inside the mounted screen, and the header is not in it. Measured
    // at v170: three routes declared, two counted, and #/cart rendering
    // perfectly well when opened by hand.
    'header a', 'header button',
    '[role="navigation"] a', '[role="navigation"] button',
    'a[href^="#/"]', '[aria-current]',
  ].join(',');

  /**
   * The nav is re-queried before every click, and identified by what it says
   * rather than by which object it was.
   *
   * Holding element references across a click does not survive React. Measured
   * on a real generated app: the first click landed on the nav item for the
   * screen already showing, the shell re-rendered to move aria-current, every
   * captured node was replaced, and the remaining thirteen clicks went to
   * detached elements. One screen was measured and eight came back unreachable —
   * and silently, because a control that follows one which itself changed
   * nothing is excluded from the dead-nav count.
   */
  const navKey = (e) =>
    (e.getAttribute('href') || e.getAttribute('data-nav') || '') + '|' + (e.textContent || '').trim().slice(0, 24);
  const pressed = new Set();
  for (let n = 0; n < 14; n++) {
    /**
     * The same controls the action pass refuses, refused here too.
     *
     * Nav clicks never went through SKIP_ACTION, which was survivable while
     * the selector only matched things inside a <nav> — and a sidebar puts
     * ログアウト in exactly there. Pressing it mid-walk signs the app out and
     * every screen measured after that is the login screen. Now that the
     * shell's own buttons are included the odds go up, so the filter applies
     * to both passes: a control whose whole effect is to end the session or
     * to leave the page is not navigation worth measuring.
     */
    if (outOfTime()) { truncated = true; break; }
    const next = [...document.querySelectorAll(NAV_SELECTOR)].find(
      (e) => !pressed.has(navKey(e)) && !SKIP_ACTION.test((e.textContent || '').trim())
    );
    if (!next) break;
    pressed.add(navKey(next));
    /**
     * Close whatever the last click opened.
     *
     * The walk clicks menu toggles and account dropdowns because they live in
     * the nav, and an overlay left open swallows the next click — which then
     * looks like a dead control. Escape is what closes one in any shell built to
     * the conventions this pipeline asks for, and is inert everywhere else.
     */
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await press(next, 'nav');
    await tryRow();
    await tryActions();
  }

  /**
   * Screens the clicking never opened, visited by their own route.
   *
   * The score asks how many of the declared screens were measured —
   * min(fills, declared)/declared — so a screen that renders correctly but
   * that the walk could not find a control for costs the run the same as one
   * that is broken. That is a fact about the probe being scored as a fact
   * about the app, and it then buys repair passes for a screen with nothing
   * wrong with it.
   *
   * Reaching it by hash is a true measurement: the route is the app’s own,
   * and what renders there is what a user gets. What it is NOT is evidence
   * that anything links to it, so these are recorded apart from the clicked
   * ones and reachability keeps being decided by the walk above.
   */
  clicked = [...screens.keys()];
  for (const id of DECLARED) {
    if (outOfTime()) { truncated = true; break; }
    if (screens.has(id)) continue;
    location.hash = '#/' + id;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await settle();
    record();
    await tryRow();
    await tryActions();
  }

  return JSON.stringify({
    screens: [...screens.values()],
    clicked,
    truncated,
    nav,
    // Minutes behind UTC, as the page sees it. A form that compares a date
    // against "today" behaves differently in UTC and in Japan, and the walk
    // types today's date into it.
    tzOffset: new Date().getTimezoneOffset(),
    hashIds: [...hashIds],
    declared: [...document.querySelectorAll('[data-screen]')].map((s) => s.getAttribute('data-screen')),
  });
  })();
  const hard = new Promise((resolve) => setTimeout(() => resolve(partial()), ${hardDeadlineMs}));
  return Promise.race([body, hard]);
})()`

/**
 * Measures the contrast of every piece of visible text against what is actually
 * painted behind it.
 *
 * The background is walked up the ancestor chain because `background-color` is
 * `rgba(0,0,0,0)` on most elements — the colour a user sees comes from some
 * ancestor, and comparing against transparent black is how a contrast check
 * reports a page as perfect. Semi-transparent layers are composited rather than
 * skipped, since a scrim over an image is exactly where real failures live.
 *
 * Only leaf-ish text is measured: an element whose text comes entirely from its
 * children would otherwise be reported once per level of nesting, all with the
 * same colours.
 */
/** One click the walk made, as the page recorded it. */
interface NavClick {
  kind: string
  label: string
  /** The link's own target, when it had one. Buttons have none. */
  href: string
  /** location.hash immediately before the click. */
  hashBefore: string
  /** `aria-current` on the control, read as the click's record is built. */
  current?: string
  /** Whether the control acts on form fields the walk did not vary. */
  actsOnFields?: boolean
  /** The set of visible screens changed. */
  changed: boolean
  /** The DOM responded at all — navigated, or opened, or swapped content. */
  responded: boolean
  /** Anything the app threw while this control was being pressed. */
  threw?: string[]
}

/**
 * Controls that raised an exception when pressed.
 *
 * A different finding from a dead control, and a worse one: a dead button does
 * nothing, a throwing button takes the screen down. Reported by a user clicking
 * a product card —
 *
 *     TypeError: Cannot read properties of undefined (reading 'params')
 *       at hash (…) at onClick (…)
 *
 * — which reached the pipeline only as an anonymous `console-error` carrying a
 * stack into a bundled file the repair planner cannot see. It had to work out
 * both which control and which source line from that. Naming the control gives
 * the repair the one fact it actually needs.
 */
export function throwingControls(nav: NavClick[]): { label: string; error: string }[] {
  const out: { label: string; error: string }[] = []
  for (const n of nav) {
    const first = n.threw?.[0]
    if (!first || !n.label) continue
    if (out.some((o) => o.label === n.label)) continue
    out.push({ label: n.label, error: first })
  }
  return out.slice(0, 6)
}


/**
 * The nav controls that did nothing, out of everything the walk clicked.
 *
 * Rewritten after measuring it: the previous rule required the *preceding*
 * recorded click to have changed screens, which was written when nav clicks
 * were consecutive. A row click was later interleaved between every pair of nav
 * clicks, so the predecessor became a row click almost every time and the
 * condition stopped being satisfiable. Measured on a fixture with one
 * deliberately dead button: the old rule reported nothing at all. A check that
 * cannot fire is worse than no check, because it reads as a clean result.
 *
 * What replaces it is three conditions that each correspond to a real way of
 * being wrong:
 *
 *   - Nothing anywhere responded. The page is frozen, or the walk never landed a
 *     click. Reporting every control as dead reports the walk's failure as the
 *     app's.
 *   - The first control. The walk starts on the landing screen holding no hash,
 *     and the first thing in a nav is usually that screen's own item.
 *   - A link pointing at the screen already showing. Correctly does nothing.
 *
 * Everything else that took a click and moved nothing is dead.
 */
export function deadControls(nav: NavClick[]): string[] {
  // Liveness is judged over every click, rows included: a row that opened a
  // detail screen proves the page is responding just as well as a nav item does.
  if (!nav.some((n) => n.responded)) return []
  const route = (h: string) => String(h || '').replace(/^#\/?/, '').split('/')[0]
  const clicks = nav.filter((n) => n.kind === 'nav')
  const dead: string[] = []
  for (let j = 0; j < clicks.length; j++) {
    const n = clicks[j]
    if (j === 0 || !n.label || n.responded) continue
    if (n.href && n.href.startsWith('#') && route(n.href) === route(n.hashBefore)) continue
    /*
     * A nav item for the screen already showing, whichever element it is.
     *
     * The line above excuses that case and can only see it on an ANCHOR, by
     * comparing its href with the current hash. Generated navs are buttons —
     * `<button onClick={() => navigate(item.id)} aria-current={…}>` — so they
     * carry no href, the comparison never fires, and pressing 「商品一覧」 while
     * the product list is showing was reported as a dead control.
     *
     * Replayed 2026-09-20 over the eight stored documents that shipped with a
     * dead-control finding: six walks returned, five named exactly one dead
     * nav item, and every one of the five was the current screen's own item —
     * 商品一覧 on the product list, デッキ一覧 on the deck list. Not one was a
     * control that failed to work.
     *
     * The repair loop has been spending calls on these: `action-dead-runtime`
     * is fixed 5% of the time and survives 84% of runs, which is the shape of
     * a defect that was never there to fix.
     *
     * `aria-current` is what the build contract already requires of the item
     * for the current page, so this reads what is there rather than asking for
     * anything new.
     */
    if (n.current === 'page' || n.current === 'true') continue
    if (!dead.includes(n.label)) dead.push(n.label)
  }
  return dead
}

/**
 * The in-screen buttons that took a click and did nothing.
 *
 * Separate from `deadControls` because the excuses are different, not because
 * the idea is. A nav item may legitimately point at the screen already showing;
 * a 保存 button has no equivalent reason to sit there doing nothing, so there is
 * no first-control exemption here. The liveness guard is the same one: if the
 * page never responded to anything, that is the walk failing, not the app.
 *
 * The narrowing that matters happens in the page, where controls whose effect
 * is outside the document — copy, download, print — are never pressed at all.
 * Reporting those as dead would be reporting them for working.
 */
export function deadActions(nav: NavClick[]): string[] {
  if (!nav.some((n) => n.responded)) return []
  const dead: string[] = []
  for (const n of nav) {
    if (n.kind !== 'action' || !n.label || n.responded) continue
    /*
     * A control that acts on fields the walk never varied — see `actsOnFields`
     * where the click is recorded. The walk fills EMPTY fields and a React form
     * rarely has any, so 適用 applies the range it already had and nothing
     * moves. Replayed over the documents that shipped with this finding, every
     * one that returned was this or the nav case above.
     *
     * Not an excuse for the control: an excuse for the walk, which cannot make
     * a precondition it does not know about.
     */
    if (n.actsOnFields) continue
    if (!dead.includes(n.label)) dead.push(n.label)
  }
  return dead
}

const CONTRAST = `(() => {
  const parse = (c) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(c || '');
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  /*
   * What is actually behind the text, and whether we can know it.
   *
   * This accumulated background-color and nothing else, so a gradient scrim and
   * a photograph were both invisible to it: the walk went straight past them to
   * the body background. Measured on a real hero banner — white heading, a
   * linear-gradient(rgba(0,0,0,.3), transparent) scrim, a stock photo under
   * it — and the reported backdrop was the page's own near-white, giving 1.1:1.
   *
   * That number happened to describe the outcome, because the photo slot had
   * fallen back to a pale placeholder. Over a dark photo the same code reports a
   * failure that does not exist, and a hero fixed with a proper gradient scrim
   * still reports as broken because the fix is a background-image too. A
   * measurement that cannot see half the things it is measuring should not be
   * reporting a ratio at all.
   *
   * So: an image between the text and the nearest opaque colour makes the
   * backdrop UNKNOWN, and unknown is reported as its own finding rather than as
   * a number. A solid background-color still resolves normally, which is why the
   * contract asks for a solid panel — it is the version of this that can be
   * checked.
   */
  const backdrop = (el) => {
    let acc = null;
    let imaged = false;
    for (let n = el; n; n = n.parentElement) {
      const st = getComputedStyle(n);
      // A gradient or a picture set as this element's background.
      if (st.backgroundImage && st.backgroundImage !== 'none') imaged = true;
      // A picture placed inside this element and covering it, which is how a
      // generated hero puts a photograph behind its words. Walked over
      // children rather than with a selector: this runs for every piece of
      // text on the page, and querySelectorAll on every ancestor of every one
      // of them is a different order of work for the same answer.
      if (!imaged) {
        let box = null;
        for (const child of n.children) {
          const tag = child.tagName;
          if (tag !== 'IMG' && tag !== 'SVG' && tag !== 'PICTURE' && tag !== 'VIDEO') continue;
          box = box || n.getBoundingClientRect();
          const m = child.getBoundingClientRect();
          if (m.width >= box.width * 0.9 && m.height >= box.height * 0.9) { imaged = true; break; }
        }
      }
      const c = parse(st.backgroundColor);
      if (!c || c.a === 0) continue;
      acc = acc ? over(acc, c) : c;
      if (acc.a >= 1) return { color: acc, imaged: false };
    }
    const body = parse(getComputedStyle(document.body).backgroundColor);
    const base = body && body.a >= 1 ? body : { r: 255, g: 255, b: 255, a: 1 };
    /*
     * Opacity between the text and the picture settles the question.
     *
     * A solid panel behind the words is the fix this reports in order to
     * provoke, so it must not go on reporting once the panel is there. At 0.7
     * the picture contributes under a third and the composite below is close
     * enough to measure against; below it, the picture is what a reader sees
     * and no number computed from colours alone describes the result.
     *
     * A gradient scrim never reaches this test at all — it is a
     * background-image, so it never enters acc — which is correct: its
     * opacity varies across the element, and the text is rarely where it is
     * strongest.
     */
    return { color: acc ? over(acc, base) : base, imaged: imaged && (!acc || acc.a < 0.7) };
  };

  const faults = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') continue;
    const own = [...el.childNodes]
      .filter((n) => n.nodeType === 3 && n.textContent.trim())
      .map((n) => n.textContent.trim())
      .join(' ');
    if (!own) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || parseFloat(st.opacity) < 0.1) continue;
    const fg = parse(st.color);
    if (!fg || fg.a === 0) continue;
    const back = backdrop(el);
    const bg = back.color;
    const r = ratio(fg.a < 1 ? over(fg, bg) : fg, bg);
    const size = parseFloat(st.fontSize) || 16;
    const weight = parseInt(st.fontWeight, 10) || 400;
    // WCAG "large text": 24px, or 18.66px when bold.
    const required = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
    // Text over a picture: the ratio above was computed against something that
    // is not what a reader sees, so it is reported as undeterminable rather
    // than as a fault or as a pass.
    if (back.imaged) {
      const text0 = own.slice(0, 60);
      if (!seen.has('img|' + text0)) {
        seen.add('img|' + text0);
        faults.push({ text: text0, fg: st.color, bg: 'image', ratio: 0, required, overImage: true });
      }
      continue;
    }
    if (r + 0.05 >= required) continue;
    const text = own.slice(0, 60);
    const key = text + '|' + st.color + '|' + Math.round(r * 10);
    if (seen.has(key)) continue;
    seen.add(key);
    faults.push({
      text,
      fg: st.color,
      bg: 'rgb(' + [bg.r, bg.g, bg.b].map((v) => Math.round(v)).join(', ') + ')',
      ratio: Math.round(r * 100) / 100,
      required,
    });
  }
  return JSON.stringify(faults.sort((a, b) => a.ratio - b.ratio).slice(0, 6));
})()`

/**
 * What the page does at phone width.
 *
 * Horizontal overflow is the whole point. A layout that merely looks cramped is
 * a judgement call; one that scrolls sideways is broken, every user meets it
 * immediately, and it is invisible at 1440px — which is the only width this
 * check has ever looked at.
 */
const MOBILE = `(() => {
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const wide = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    // Only elements that themselves stick out, not every ancestor of one.
    if (r.right <= vw + 1 && r.left >= -1) continue;
    if ([...el.children].some((k) => {
      const kr = k.getBoundingClientRect();
      return kr.right > vw + 1 || kr.left < -1;
    })) continue;
    // Same reason as the empty-box label above: className is an object on an
    // SVG element, and a chart is exactly the kind of thing that overflows.
    wide.push((el.getAttribute('class') || el.tagName).slice(0, 40) + ' ' + Math.round(r.width) + 'px');
  }
  let bottom = 0;
  for (const el of document.querySelectorAll('body *')) {
    if (el.offsetParent === null) continue;
    bottom = Math.max(bottom, el.getBoundingClientRect().bottom + window.scrollY);
  }
  return JSON.stringify({
    overflow: [...new Set(wide)].slice(0, 5),
    overflowBy: Math.max(0, Math.round(document.documentElement.scrollWidth - vw)),
    fill: Math.min(1, bottom / vh),
    layoutWidth: vw,
  });
})()`

interface Cdp {
  send(method: string, params?: unknown, sessionId?: string): Promise<any>
  close(): void
  errors: string[]
  /**
   * The control the walk announced it was about to press, most recent last.
   *
   * Read from the page's console as EVENTS, which is the one channel that
   * still has the answer after the page stops: a page whose main thread is
   * blocked can run nothing and answer no evaluate, but every message it
   * logged before it blocked has already crossed the socket. See WALK_MARK.
   */
  pressed: string[]
}

async function connect(endpoint: string, credentials: AwsCredentialIdentityProvider): Promise<Cdp> {
  const url = new URL(endpoint.replace(/^ws/, 'http'))
  const signer = new SignatureV4({
    service: 'bedrock-agentcore',
    region: REGION,
    credentials,
    sha256: NodeSha256 as any,
  })
  /**
   * Presigned rather than header-signed: the runtime's WebSocket is the WHATWG
   * one, which has no way to set headers on the upgrade request. Query-string
   * signing is the form that survives that constraint.
   */
  const p = await signer.presign(
    {
      method: 'GET',
      protocol: url.protocol,
      hostname: url.hostname,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: { host: url.hostname },
    } as any,
    { expiresIn: 300 }
  )
  const wsUrl = `wss://${p.hostname}${p.path}?${new URLSearchParams(p.query as Record<string, string>)}`
  const ws = new WebSocket(wsUrl)

  let id = 0
  const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>()
  const errors: string[] = []
  const pressed: string[] = []

  ws.addEventListener('message', (ev: MessageEvent) => {
    let msg: any
    try {
      msg = JSON.parse(String(ev.data))
    } catch {
      return
    }
    if (msg.id && pending.has(msg.id)) {
      const q = pending.get(msg.id)!
      pending.delete(msg.id)
      msg.error ? q.rej(new Error(JSON.stringify(msg.error))) : q.res(msg.result)
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params?.exceptionDetails
      errors.push(String(d?.exception?.description ?? d?.text ?? 'exception').slice(0, 300))
    } else if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
      errors.push(String(msg.params.entry.text).slice(0, 300))
    } else if (
      msg.method === 'Runtime.consoleAPICalled' &&
      msg.params?.type === 'debug' &&
      typeof msg.params?.args?.[0]?.value === 'string' &&
      msg.params.args[0].value.startsWith(WALK_MARK)
    ) {
      // Kept to the last few: only the final one names what froze the page.
      pressed.push(msg.params.args[0].value.slice(WALK_MARK.length).slice(0, 120))
      if (pressed.length > 8) pressed.shift()
    } else if (
      msg.method === 'Runtime.consoleAPICalled' &&
      (msg.params?.type === 'error' || msg.params?.type === 'assert')
    ) {
      /**
       * `console.error` from the page, which neither of the two above reports.
       *
       * `exceptionThrown` carries what nothing caught, and `Log.entryAdded`
       * carries what the BROWSER logged — network failures, CSP refusals. A
       * framework that catches a render error and reports it itself lands in
       * neither, so a Vue app whose template dereferenced undefined came back
       * as `screens 0, consoleErrors 0`: nothing rendered, and by our own
       * measurement nothing went wrong.
       *
       * The same gap swallowed our own guard. The runnable document ends with
       * a check that console.errors `render() was called but #root is empty`,
       * written so that a blank page "lands in the verifier's error list rather
       * than being reported as an app that simply looks empty" — and it never
       * once did, because this branch did not exist.
       */
      const args = (msg.params.args ?? [])
        .map((a: any) => a?.description ?? (a?.value !== undefined ? String(a.value) : ''))
        .filter(Boolean)
        .join(' ')
      if (args) errors.push(args.slice(0, 300))
    }
  })

  /**
   * Report why the connection failed, not that it failed.
   *
   * The first version rejected with a bare 'websocket error'. A WHATWG error
   * event carries no detail by design, so an authorisation failure on the
   * upgrade — the single most likely cause — reached the log as two words with
   * nothing to act on, and cost three rounds of guessing at IAM. The close event
   * does carry a code and reason, and it always follows the error, so waiting a
   * moment for it turns "it broke" into "1006 / 403 Forbidden".
   */
  await new Promise<void>((res, rej) => {
    let closeInfo = ''
    const fail = (why: string) =>
      rej(new Error(`websocket ${why}${closeInfo ? ` (${closeInfo})` : ''} host=${url.hostname} path=${url.pathname}`))
    const timer = setTimeout(() => fail('open timed out'), 20_000)
    ws.addEventListener('close', (ev: any) => {
      closeInfo = `code=${ev.code} reason=${ev.reason || 'none'}`
    })
    ws.addEventListener('open', () => { clearTimeout(timer); res() }, { once: true })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      // The close event lands just after the error and holds the actual reason.
      setTimeout(() => fail('error'), 250)
    }, { once: true })
  })

  return {
    send: (method, params, sessionId) =>
      new Promise((res, rej) => {
        const n = ++id
        pending.set(n, { res, rej })
        ws.send(JSON.stringify(sessionId ? { id: n, method, params, sessionId } : { id: n, method, params }))
        /*
         * The walk gets longer than everything else, because it IS everything
         * else: one Runtime.evaluate carries the whole click-through. It bounds
         * itself at 20s, so this only has to be far enough clear of that to
         * tell "the walk decided to stop" apart from "the transport gave up",
         * which are different failures and want different fixes.
         */
        const ms = method === 'Runtime.evaluate' ? 45_000 : 30_000
        setTimeout(() => {
          if (pending.delete(n)) rej(new Error(`cdp timeout: ${method}`))
        }, ms)
      }),
    close: () => ws.close(),
    errors,
    pressed,
  }
}

/**
 * One shell across every screen the walk opened: a flag any screen showed, the
 * first header measured, the widest side nav. A breadcrumb on the detail screen
 * is the system's breadcrumb even though the list screen has none.
 */
export function mergeLayout(layouts: LayoutFact[]): LayoutFact | undefined {
  if (layouts.length === 0) return undefined
  return {
    header: layouts.find((l) => l.header)?.header ?? null,
    sideNavWidth: Math.max(...layouts.map((l) => l.sideNavWidth ?? 0)),
    bottomNav: layouts.some((l) => l.bottomNav),
    topNav: layouts.some((l) => l.topNav),
    fab: layouts.some((l) => l.fab),
    breadcrumb: layouts.some((l) => l.breadcrumb),
    table: layouts.some((l) => l.table),
    navItems: Math.max(...layouts.map((l) => l.navItems ?? 0)),
  }
}

interface VerifyOptions {
  /**
   * Screens the project declares but does not write into the DOM — the ScreenId
   * union of a React project. Plain HTML output declares its screens in the
   * markup and needs none of this.
   */
  declaredScreens?: string[]
  /**
   * The run this belongs to, for the log line when it fails.
   *
   * The failure was logged without it, so the one walk in thirty days that did
   * not come back could not be found by filtering the run's own log — it took
   * reading every line in the minute around it.
   */
  requestId?: string
  /** Told why nothing came back, when nothing does. See VerifyFailure. */
  onFailure?: (failure: VerifyFailure) => void
}

/**
 * Why verification returned nothing — which the caller needs, because "the
 * mode skipped it" and "it was tried and the page stopped answering" are
 * different facts to tell a user, and only one of them is a defect in the app.
 */
export interface VerifyFailure {
  /**
   * page-frozen: the walk's evaluate never came back. With the walk racing its
   *   own timer (WALK_HARD_DEADLINE_MS) that can only mean the page's main
   *   thread stopped — nothing in it could run, not even that timer.
   * browser: anything else — the session, the socket, the transport.
   */
  reason: 'page-frozen' | 'browser'
  /** The control being pressed when the page stopped, from WALK_MARK. */
  frozeOn?: { kind: string; hash: string; label: string }
  error: string
  durationMs: number
}

/** A WALK_MARK body back into its parts: kind|hash|label. */
export function parsePressMark(mark: string): { kind: string; hash: string; label: string } {
  const [kind = '', hash = '', ...rest] = mark.split('|')
  return { kind, hash, label: rest.join('|') }
}

/**
 * Renders the document and reports what it does. Returns null when the browser
 * is unavailable or misbehaves — verification is an improvement to the pipeline,
 * never a new way for a generation to fail.
 */
export async function verifyInBrowser(
  source: string,
  options: VerifyOptions = {}
): Promise<RuntimeFacts | null> {
  if (!BROWSER_ID) {
    logger.info('Browser verification skipped — AGENTCORE_BROWSER_ID not set')
    return null
  }

  /**
   * React output is a project, not a page, and has to be compiled before there is
   * anything to render. Doing it here rather than at the call sites means no
   * caller can forget — and forgetting is not hypothetical: every React run
   * before this change was verified as a blank document and reported zero
   * defects on the strength of it.
   */
  const runnable = toRunnableDocument(source)
  if (runnable.error) {
    // The project does not compile. That is a finding about the output, not a
    // failure of verification, so it is reported as one — with no screens, which
    // is the truth about a page that cannot start.
    logger.warn('Generated React project failed to compile', { error: runnable.error })
    return {
      screens: [],
      deadNav: [],
      deadActions: [],
      throwing: [],
      smallFields: [],
      consoleErrors: decodeReactErrors([runnable.error]),
      screenshot: '',
      unreachable: [],
      // Nothing rendered, so nothing was measured. Empty here means "not
      // applicable", which the audit reads the same way as "nothing found" —
      // correct, because a page that cannot start has no contrast to fail.
      contrast: [],
      mobile: null,
      // The walk never ran, so it did not stop early either. A project that
      // does not compile is a finding about the output; nothing here should
      // read as "not measured".
      truncated: false,
    }
  }
  if (runnable.warnings.length > 0) {
    logger.info('React compile warnings', { warnings: runnable.warnings.slice(0, 5) })
  }
  const html = runnable.html

  const client = new BedrockAgentCoreClient({ region: REGION })
  let sessionId: string | undefined
  let cdp: Cdp | undefined
  const started = Date.now()

  try {
    const session = await client.send(
      new StartBrowserSessionCommand({
        browserIdentifier: BROWSER_ID,
        name: 'makeui-verify',
        sessionTimeoutSeconds: 180,
        viewPort: VIEWPORT,
      })
    )
    sessionId = session.sessionId
    const endpoint = session.streams?.automationStream?.streamEndpoint
    if (!endpoint) throw new Error('no automation stream endpoint')

    /**
     * Credentials come off the client that just made a successful call, rather
     * than from a fresh provider chain. `@aws-sdk/credential-provider-node` is
     * only a transitive dependency here, and building the signer on a package
     * nothing declares is a build that breaks on an unrelated `npm install`.
     */
    cdp = await connect(endpoint, client.config.credentials)
    const targets = await cdp.send('Target.getTargets')
    const page = (targets.targetInfos ?? []).find((t: any) => t.type === 'page')
    if (!page) throw new Error('no page target')
    const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })

    await cdp.send('Page.enable', {}, sid)
    await cdp.send('Runtime.enable', {}, sid)
    await cdp.send('Log.enable', {}, sid)

    /**
     * about:blank first, and this is not optional.
     *
     * The session opens on chrome://newtab, whose Content Security Policy forbids
     * inline script. Setting the document there leaves every <script> in the
     * generated page unexecuted: the page renders as a static shell, every
     * control is dead and every screen looks empty. The first run of this check
     * reported exactly that and it was entirely an artefact of the starting URL.
     */
    await cdp.send('Page.navigate', { url: 'about:blank' }, sid)
    await new Promise((r) => setTimeout(r, 400))

    const { frameTree } = await cdp.send('Page.getFrameTree', {}, sid)
    await cdp.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html }, sid)
    // Enough for a mock's own scripts to build the first screen. These documents
    // have no network to wait on — everything is inline.
    await new Promise((r) => setTimeout(r, 2500))

    const shot = await cdp
      .send('Page.captureScreenshot', { format: 'png' }, sid)
      .catch(() => ({ data: '' }))

    const walk = JSON.parse(
      (
        await cdp.send(
          'Runtime.evaluate',
          {
            expression: walkExpression(options.declaredScreens ?? []),
            returnByValue: true,
            awaitPromise: true,
          },
          sid
        )
      ).result?.value ?? '{}'
    )

    /**
     * Contrast is read after the walk, on whatever screen it finished on.
     *
     * One screen's worth is enough to know whether the palette clears the floor:
     * the failures this catches are token-level — a muted grey on white, a badge
     * whose label sits on its own accent — and those are the same on every
     * screen because they come from the same variables.
     */
    const contrast: ContrastFault[] = JSON.parse(
      (await cdp.send('Runtime.evaluate', { expression: CONTRAST, returnByValue: true }, sid))
        .result?.value ?? '[]'
    )

    /**
     * Then the same document at phone width.
     *
     * Cheaper than it looks: the page is already loaded, so this is a metrics
     * override, a reflow and one read — no second session, no second render of
     * the document. Overriding rather than resizing the window is what makes it
     * cheap, and it is also what a phone actually reports to the page.
     */
    let mobile: MobileFact | null = null
    try {
      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
        sid
      )
      await new Promise((r) => setTimeout(r, 700))
      mobile = JSON.parse(
        (await cdp.send('Runtime.evaluate', { expression: MOBILE, returnByValue: true }, sid))
          .result?.value ?? 'null'
      )
    } catch (e) {
      logger.info('Mobile pass skipped', { error: String(e) })
    } finally {
      await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sid).catch(() => {})
    }

    const measured: any[] = walk.screens ?? []
    const nav: any[] = walk.nav ?? []
    // A compiled React app declares its screens in routes.ts and puts none of
    // them in the DOM, so the walk finds nothing to compare against. The caller
    // supplies the list in that case.
    const domDeclared: string[] = walk.declared ?? []
    const declared: string[] = domDeclared.length ? domDeclared : options.declaredScreens ?? []
    const usingSupplied = domDeclared.length === 0 && declared.length > 0

    /**
     * What the walk CLICKED its way to, which is not the same as what it
     * measured.
     *
     * The walk now also opens any declared screen it never found a control
     * for, by setting the route directly — worth doing, because the screen
     * genuinely renders and the score counts measured screens. But those
     * visits say nothing about whether the app links to them, and folding
     * them in here would let a screen with no route into it report as
     * reachable. Reachability stays the click walk's answer.
     */
    const clicked: string[] = walk.clicked ?? measured.map((m: any) => m.id)
    const reached = new Set<string>(clicked)

    /**
     * Only compare the two lists when they are speaking the same language.
     *
     * For HTML mocks they always are: `declared` and the walk both read the same
     * data-screen attributes. For a React project they need not. `declared` holds
     * the ScreenId union from routes.ts while the walk reads the hash, and the
     * two only match if the app serialises a route as `#/<ScreenId>` — which the
     * output spec asks for and generated code does not always do. Measured on a
     * real run: the app reached `#/equipment` for the screen its union calls
     * `equipment-list`, and every one of its ten screens came back unreachable.
     *
     * So the vocabularies are checked for overlap first. No overlap means the
     * hash is not the screen id, and the honest answer is that this run cannot
     * tell — not that the whole app is unreachable. A false "unreachable" is
     * expensive: it feeds a repair pass that will go looking for a navigation
     * bug that does not exist.
     *
     * Only hash-derived ids count towards the overlap. The landing screen has no
     * hash and borrows its label from the declared list, so counting it would
     * guarantee a match and have the check confirm its own assumption.
     */
    const routed: string[] = walk.hashIds ?? []
    const comparable = !usingSupplied || routed.some((id) => declared.includes(id))
    if (!comparable) {
      logger.info('Reachability not comparable — route ids do not match the declared screens', {
        routed: routed.join(',') || 'none',
        declared: declared.join(','),
      })
    }

    const facts: RuntimeFacts = {
      screens: measured.map((m) => ({ id: m.id, fill: m.fill, emptyBoxes: m.emptyBoxes ?? [], reachable: reached.has(m.id), broken: m.broken ?? [], ...(m.hiddenBy ? { hiddenBy: m.hiddenBy } : {}) })),
      deadNav: deadControls(nav),
      deadActions: deadActions(nav),
      throwing: throwingControls(nav),
      /**
       * Collected from every screen the walk measured, deduplicated by label.
       *
       * A shared field component renders on four screens and is the same defect
       * four times; reporting it once keeps the instruction readable and stops
       * one bad token inflating the count.
       */
      smallFields: measured
        .flatMap((m: any) =>
          (m.fields ?? []).map((f: any) => ({ screen: m.id, ...f }))
        )
        .filter(
          (f: SmallField, i: number, all: SmallField[]) =>
            all.findIndex((o) => o.label === f.label && o.height === f.height) === i
        )
        .slice(0, 8),
      /*
       * Decoded here, at the one place the walk records them, so everything
       * downstream reads the sentence: the `console-error` repair instruction,
       * the note in the chat, the probe output and the log. See react-error.ts —
       * production React reports an invariant as a number, and 31 of the 34
       * minified errors in 21 days were the same one.
       */
      consoleErrors: decodeReactErrors([...new Set(cdp.errors)]),
      screenshot: shot?.data ?? '',
      unreachable: comparable ? declared.filter((d) => d && !reached.has(d)) : [],
      contrast,
      mobile,
      truncated: Boolean(walk.truncated),
      // One entry per element, however many screens render the same shell.
      unstyledNav: [...new Set(measured.flatMap((m: any) => m.unstyledNav ?? []))].slice(0, 4) as string[],
      oversizedIcons: [...new Set(measured.flatMap((m: any) => m.oversizedIcons ?? []))].slice(0, 6) as string[],
      layout: mergeLayout(measured.map((m: any) => m.layout).filter(Boolean)),
    }

    if (walk.truncated) {
      /*
       * Said out loud, because a truncated walk under-reports: screens it never
       * reached read as unreachable and controls it never pressed read as
       * untested. Better than losing the run, and not the same as a clean pass.
       */
      logger.info('Walk stopped at its deadline — later screens and controls were not reached', {
        measured: (walk.screens ?? []).length,
        clicked: (walk.clicked ?? []).length,
      })
    }

    logger.info('Browser verification completed', {
      durationMs: Date.now() - started,
      compiled: runnable.compiled,
      screens: facts.screens.map((s) => `${s.id}:${s.fill.toFixed(2)}`).join(','),
      emptyBoxes: facts.screens.reduce((n, s) => n + s.emptyBoxes.length, 0),
      deadNav: facts.deadNav.length,
      deadActions: facts.deadActions.join(',') || 'none',
      consoleErrors: facts.consoleErrors.length,
      unreachable: facts.unreachable.join(',') || 'none',
      contrast: facts.contrast.length
        ? facts.contrast.map((c) => `${c.ratio}:1<${c.required}`).join(',')
        : 'ok',
      mobileOverflow: facts.mobile ? facts.mobile.overflowBy : 'n/a',
      screenshotBytes: facts.screenshot ? Math.round((facts.screenshot.length * 3) / 4) : 0,
      /*
       * What the walk did, beside what it found. It presses more than it did —
       * candidates re-read before every press, a probe for every control that
       * did not respond — and it has a deadline, so whether it finished is part
       * of every reading of the numbers above.
       */
      truncated: facts.truncated,
      actions: nav.filter((n: any) => n.kind === 'action').length,
      probes: nav.filter((n: any) => n.kind === 'probe').length,
      alreadySelected: nav.filter((n: any) => n.alreadySelected).length,
      tzOffset: typeof walk.tzOffset === 'number' ? walk.tzOffset : 'n/a',
    })
    return facts
  } catch (e) {
    const error = String(e)
    const durationMs = Date.now() - started
    const frozen = /cdp timeout: Runtime\.evaluate/.test(error)
    const last = cdp?.pressed[cdp.pressed.length - 1]
    const failure: VerifyFailure = {
      reason: frozen ? 'page-frozen' : 'browser',
      ...(frozen && last ? { frozeOn: parsePressMark(last) } : {}),
      error,
      durationMs,
    }
    logger.warn('Browser verification failed; continuing without it', {
      requestId: options.requestId,
      ...failure,
      // The last few presses, so a freeze that follows a sequence can be read.
      pressed: cdp?.pressed.slice(-4),
    })
    options.onFailure?.(failure)
    return null
  } finally {
    cdp?.close()
    if (sessionId) {
      await client
        .send(new StopBrowserSessionCommand({ browserIdentifier: BROWSER_ID, sessionId }))
        .catch(() => {})
    }
  }
}
