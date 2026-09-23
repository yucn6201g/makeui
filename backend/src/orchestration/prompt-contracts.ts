/**
 * What the assembler is told to produce, in the words it is told in.
 *
 * Seven prompt documents — the photo-placeholder policy, the depth and
 * signature briefs, the transport specification, what a finished screen
 * contains, and the stylesheet and project contracts. 754 lines of prose that
 * sat in graph.ts between the design presets above them and the scoring below,
 * sharing nothing with either: the pipeline hands these to a model, it does not
 * reason about them.
 *
 * Three of them are private here that could not be before. The policy and the
 * two briefs are read only by the contracts in this file, and being
 * module-level in a five-thousand-line file made that impossible to see.
 *
 * Moved unchanged. graph.ts re-exports the three names the rest of the codebase
 * imports, so no call site outside it changed.
 */
import { FRAMEWORKS, type OutputKind } from '../config/frameworks.js'

/**
 * Contract for React output.
 *
 * The whole pipeline (versions, S3, modify, thumbnails) moves a single `html`
 * string, so a React project travels as one document carrying its source files
 * inline. The frontend splits those back into a real project tree, compiles
 * them, and runs the app in the preview iframe.
 *
 * The carrier is the whole-line `@@@makeui:file` fence — see `outputSpecFor`,
 * which is what the model is actually told. This comment said `data-file`
 * blocks long after the fence replaced them, which is worth more than a
 * pedantic correction: a React run came back on the legacy carrier as recently
 * as v186, and a comment describing the old transport as the current one is
 * exactly the sort of thing that keeps it alive. The reader is still accepted,
 * deliberately — stored documents predate the fence — but nothing should be
 * written that way again.
 */
/**
 * Form controls, sized to be typed into.
 *
 * Nothing in any prompt constrained input dimensions — the only mention was
 * "comfortable 10-12px padding", which at the default 14px type gives a ~38px box,
 * and models then shrank the field to its label width. Contact and enquiry forms
 * came back with text boxes too small to use, which is what the user reported.
 *
 * Stated once and shared by all three assembler prompts: the same rule written out
 * three times is the same rule until someone edits one of them.
 */
export const FORM_CONTROL_SIZING = `
FORM CONTROLS — size them to be typed into. These are minimums, not suggestions:
  font-size: 16px on every input, textarea and select. Never smaller — below 16px
    iOS zooms the whole page when the field takes focus. This holds for EVERY rule
    that reaches a text field, not just the base one: writing
    \`input, textarea, select { font-size: 16px }\` and then
    \`input[type="text"], textarea { font-size: 14px }\` further down is the same as
    never setting it, because the second selector is more specific and wins.
  min-height: 44px for input and select; padding 12px 14px.
  textarea: min-height 140px, rows="6", resize: vertical.
  width: 100% of its field wrapper, and the form column itself 420-560px. A 200px
    box floating in a 1200px page is the single most common thing to get wrong here.
  checkbox / radio: 18-20px box, inside a label row with a 44px hit area.
  Label above the control, helper and error text below it, tied with aria-describedby.
  Never rely on the placeholder as the label — it disappears the moment typing starts.

TYPE HIERARCHY — the page has to say what is the page and what is beside it:
  The screen's own title is the largest text on that screen, and visibly so: at
  least 1.5x the body size and heavier, with every panel heading beside it —
  a sidebar's 「フィルタ」, a card's caption — a clear step smaller. A title set
  at the same size as the filter label next to it reads as two labels rather
  than a page and its controls; a user reported exactly that
  (「ページ見出し『商品一覧』が小さく、左サイドバーの『フィルタ』と同じ大きさで
  階層感がありません」). Of 34 shipped projects, 6 set h1 no larger than h2 and
  one set it SMALLER, so this is worth checking your own stylesheet for.
  Use one scale for the whole project and take every heading from it.`

/**
 * What goes where a photograph would.
 *
 * The rule used to be "draw an abstract still life from the palette" for every
 * photographic slot. That produces the wrong thing for a product catalogue: a grid
 * of invented geometric compositions is neither the product nor an honest gap, and
 * a reviewer reads it as the design rather than as missing content. A photo slot
 * has no honest substitute — so it is drawn as a deliberate placeholder that says
 * "a photograph belongs here" and gets the layout right.
 *
 * Shared by all three assembler prompts. The three IMAGERY sections were already
 * duplicated word for word, which is how they stay identical only until someone
 * edits one.
 */
const PHOTO_PLACEHOLDER_POLICY = `
  - Photographic content (product shots, avatars, covers, hero imagery): render a
    PLACEHOLDER, not invented artwork. A placeholder here is a design decision, not
    an unfinished screen — it is honest about what is missing and keeps the layout
    true. Build it as:
      · a box at the real aspect ratio the design calls for (1:1 for catalogue
        tiles, 4:3 or 16:9 for covers and heroes), sized with aspect-ratio so it
        never collapses to zero height and never stretches;
      · a flat surface fill from the neutral ramp — one step off the page
        background, never pure grey #ccc, never a gradient;
      · centred inside it, a small outlined picture glyph (about 24-32px, the same
        stroke family as the other icons) and, when the item has a name, that name
        in caption-size muted text;
      · the same treatment for every tile in a grid. Consistency is the point here —
        varying them per item is what made the old approach read as decoration.
    Give it a real alt: alt="\${商品名}の写真" — describe what the photograph WOULD
    show, so the markup stays correct once real photography replaces it.
    Do NOT draw a fake still life, a fake face, or a fake landscape in its place.
    Keep the glyph SMALL against the box — 24-32px inside a tile several hundred
    pixels across. A glyph scaled up to fill the slot stops reading as "a photo goes
    here" and starts reading as the artwork itself, which is the failure this whole
    rule exists to avoid.`

/**
 * The difference between competent and designed.
 *
 * Output that passes every check here still came back reading as machine-made, and
 * measuring it showed why the checks could not see it: the documents were already
 * well systematised — 7-9 type steps, spacing 98% on a 4px grid, 89% of colours
 * drawn from tokens — with real content and working controls. Nothing was wrong.
 * Nothing was *chosen* either. Every decision was the safe middle of its range, and
 * a page of safe middles is exactly what "AI-generated" looks like.
 *
 * So this asks for the one thing a rubric cannot: a position. Stated as concrete
 * moves rather than as "be more creative", because the latter reliably produces
 * decoration — the gradients and glows the ban list already removes.
 */
/**
 * The depth that separates a styled mock from a product.
 *
 * The presets describe tokens thoroughly — colours, type ramp, control sizes,
 * component treatments — and output conforms to them. What no prompt described
 * was everything that happens *around* the happy path, and that absence is what
 * makes generated work read as a demo: a table with three rows, a filter that is
 * a decorative select, a list with no empty state, a form that accepts anything.
 *
 * These are the surfaces a real team builds and a demo skips. Stated as
 * requirements with counts, because "make it realistic" has been in the prompt
 * for weeks and produces three rows every time.
 */
const PRODUCT_DEPTH = `
PRODUCT DEPTH — a mock is judged on what it does when you use it, not on the
first screenshot. Everything below is required, not aspirational.

DATA — enough to look like a system in use:
  · Primary lists/tables: 8-20 rows of plausible domain data. Three rows reads as
    a placeholder however well it is styled.
  · Real values: Japanese names, plausible dates spread over weeks, amounts with
    realistic magnitudes and tabular-nums, ids in a consistent format.
  · Deliberate variety so the states are visible: some rows pending, some
    approved, some rejected, one overdue, one with a very long title that has to
    truncate. A table where every row looks the same tests nothing.

INTERACTION — anything that looks operable must operate:
  · Search filters the list as you type. A search box that does nothing is worse
    than no search box.
  · Filters and tabs actually narrow the data, and combine with search.
  · Sortable columns sort, and show which column and direction is active.
  · Pagination or "load more" when the seed data exceeds one page.
  · Row click opens the detail for THAT row, carrying its id.
  · Create/edit writes to shared state and the list reflects it immediately.
  · Delete asks first, in an in-page dialog, and the list updates on confirm.
  · A chart segment, bar or point that opens something is a real <button> —
    or carries role="button", tabindex="0" and an onKeyDown for Enter and Space.
    An SVG <rect> with an onClick is invisible to the keyboard and to every
    assistive technology, so the screen behind it can only be reached with a
    mouse. If a chart is the only route to a screen, that screen has no route.

STATES — every surface that can be empty, busy or wrong has all three designed:
  · EMPTY: line-art SVG, one sentence naming what belongs here, and the action
    that creates the first one. Required on every list, including after a filter
    returns nothing — and that case says "条件に一致する項目がありません" with a
    clear-filters action, not the first-run message.
  · LOADING: skeletons matching the real layout for the initial load; a spinner
    with a disabled control for an action in flight. Never a bare "Loading...".
  · ERROR: what failed, in a sentence, and a retry.
  · DISABLED: visibly inert with the reason available, never a dead-looking
    control that silently does nothing.

FORMS — validated, not decorative:
  · Validate on blur and on submit; block submit while invalid.
  · Errors inline under the field, in the error colour, tied with
    aria-describedby, and the first invalid field takes focus on a failed submit.
  · Required fields marked in the label, not only by an asterisk colour.
  · Success is visible: a toast or an inline confirmation, and the form resets or
    routes onward.

KEYBOARD AND FOCUS — this is where mocks are exposed:
  · Escape closes modals and drawers; Enter submits the focused form.
  · Focus moves into a dialog on open and returns to the trigger on close.
  · Every interactive element is reachable by Tab with a visible :focus-visible ring.

RESPONSIVE — the three widths the preview actually shows:
  · 1280px+ full layout; 768-1024px the sidebar collapses or becomes a top bar,
    tables keep their columns or scroll horizontally in their own container;
    390px single column, controls at least 44px, nothing overflowing the viewport.
  · The page must never scroll horizontally. Wide content scrolls inside its own
    container, not the body.`

const DESIGN_SIGNATURE = `
COMMIT TO SOMETHING. A page where every choice is the safe midpoint reads as
generated even when nothing in it is wrong. Pick THREE of the following and make
them unmistakable; leave the rest quiet.
  · Type: a real scale contrast. If the body is 16px, a page title at 20px is a
    shrug — go to 32-48px, or set it small and wide-tracked in uppercase. One
    typeface used with conviction beats two used cautiously.
  · Density: decide whether this product is dense (an admin console, a trading
    screen: 8-12px rhythm, tabular numerals, hairline rules, many rows visible) or
    airy (a storefront, a marketing page: 32-64px rhythm, few things per screen).
    Do not land in between — the in-between is the default nobody chose.
  · One accent, used sparingly and always meaning the same thing. If the accent is
    "the primary action", nothing decorative may wear it.
  · A structural idea: a persistent left rail, a two-column split that holds across
    screens, a sticky summary bar, an oversized page header. Something the user
    would recognise the product by.
  · Edges: commit to hairline borders and near-flat surfaces, OR to elevation with
    real shadows. Mixing both is what makes a page look assembled from samples.
  · Empty and loading states designed as carefully as the full ones — this is the
    single most reliable tell that a person, not a template, built the screen.
State the three you picked in the specification, then hold them everywhere.`

/**
 * The transport, stated for the model that has to produce it.
 *
 * A whole-line fence rather than `<script data-file>`, because a Vue or Svelte
 * component contains its own `<script>` and the tag-based carrier ends the file
 * there. Measured on a minimal SFC: 113 bytes emitted, 68 read back.
 */
export const outputSpecFor = (kind: OutputKind): string => {
  const fw = FRAMEWORKS[kind]
  return `
══════════════════════════════════════════════
OUTPUT FORMAT — ${fw.label.toUpperCase()} PROJECT (absolutely binding)
══════════════════════════════════════════════
Emit ONE document. Start with:

  <!DOCTYPE html>
  <html lang="ja"><head><meta charset="UTF-8" /></head>
  <body>
  <div id="root"></div>

Then one FENCED BLOCK per source file, and nothing else. The fences are whole
lines, exactly as written, with the project path after the opening one:

  @@@makeui:file ${fw.entry}
  …the file's contents, verbatim…
  @@@makeui:endfile

  @@@makeui:file src/styles/globals.css
  …
  @@@makeui:endfile

Close with </body></html>.

Rules:
- NEVER wrap a file in <script> or <style>. The fence is the only carrier. A file's
  own markup — including its own <script> and <style> tags — is written verbatim
  inside the fence.
- A line equal to @@@makeui:file or @@@makeui:endfile may not appear inside a file.
- Ordinary ES modules with relative specifiers ('./Button', '../composables/useNavigation').
- Do NOT emit index.html, package.json, tsconfig.json or vite config — the app
  generates those around your files.
${fw.rules}`
}




/**
 * The stylesheet contract, shared by both build paths.
 *
 * This lived only in the per-file build's foundation prompt, and that is most of
 * why per-file output measured better. Same brief, same model, measured:
 *
 *     single call   globals.css 5,194 chars, 10 class rules
 *                   className used 0 times across eight screens
 *                   style={{…}} used 115 times
 *                   inline SVG 0, emoji 7
 *     per file      globals.css 14,986 chars, 78–163 class rules
 *                   className 161, style={{…}} 48
 *                   inline SVG 19–40, emoji 0
 *
 * The single call was never told the stylesheet was the contract. It was told
 * to write a stylesheet, which it did — decoratively — and then styled every
 * screen inline, which cannot carry `:hover`, `:focus-visible`, `:disabled` or
 * a media query. So that output had no interaction states and no responsive
 * behaviour anywhere, however many the stylesheet declared.
 *
 * Fixing that costs prompt text, not output tokens, which is why it belongs on
 * the cheap path most of all.
 */

/**
 * What "finished" means for one screen, stated as a bar rather than implied.
 *
 * The per-file build handed every screen its own rows out of the interaction
 * inventory and asked for all of them; the single call receives the whole
 * specification and was left to decide how much of it to implement. It
 * decided less. Measured on the same brief: 4 components against 14–24, and
 * screens that rendered the list but not the filter that the inventory listed
 * directly above it.
 *
 * Costs prompt text and no output tokens, which is the point on the cheap path.
 */
export const SCREEN_COMPLETENESS = `
══════════════════════════════════════════════
WHAT A FINISHED SCREEN CONTAINS
══════════════════════════════════════════════
The specification's INTERACTION INVENTORY lists, screen by screen, every control
and what it writes. That list is the contract, not a suggestion:

- Implement EVERY control the inventory names for that screen. A screen that
  renders the list but skips the filter listed beside it is unfinished, and the
  verifier will report the filter as missing.
- Every control does something real: writes state, navigates, opens, filters,
  sorts, validates. A control that cannot be given behaviour is removed, not
  left inert.
- Every reverse path exists: back, cancel, close, clear, and the empty state of
  anything that can be empty.
- Nothing throws when pressed. Routing helpers accept a missing argument and
  fall back to the first screen; ids read out of a route are read optionally
  (route.params?.id), never assumed.

DECOMPOSE. Pieces used on more than one screen, or complex enough to read badly
inline, get their own file under src/components/ui/: badges, cards, tables,
modals, empty states, form fields, toolbars, pagination. A multi-screen app
should have 8–16 of them. Putting everything in the screens is how a project
becomes four files nobody wants to open — measured: 4 components across eight
screens, against 14–24 for the same brief decomposed.`

/**
 * The stylesheet contract, in the framework's own spelling.
 *
 * This was one constant written in React — `className`, `style={{…}}` — and it
 * landed for React and for nothing else. Measured across nine real runs of the
 * same brief:
 *
 *     React    globals.css 21–27k, 116–160 rules, scoped blocks  0
 *     Vue      globals.css  6–12k,  13– 77 rules, scoped 17–23k over  6–12 blocks
 *     Svelte   globals.css  0–10k,   0– 53 rules, scoped 16–31k over  9–16 blocks
 *
 * Vue and Svelte are not writing less CSS than React. They are writing more of
 * it, once per component, because both scope a component's `<style>` and that
 * makes it the obvious place to put styling. The contract never said not to —
 * it only said the stylesheet was the design, which reads as satisfied when the
 * styling is in a stylesheet somewhere. One Svelte run shipped with no
 * globals.css at all.
 *
 * The consequence is the one the user reported: every component defines its own
 * card, its own button, its own spacing, and no two screens agree. A shared
 * vocabulary is not a preference here, it is the only thing making eight
 * screens look like one product.
 */
export function stylesheetContract(kind: OutputKind): string {
  const classAttr = kind === 'react' ? 'className' : 'class'
  const inlineBad =
    kind === 'react'
      ? `  BAD:   <article style={{ padding: 16, border: '1px solid #ddd', borderRadius: 8 }}>`
      : `  BAD:   <article style="padding: 16px; border: 1px solid #ddd; border-radius: 8px">`

  // Only Vue and Svelte have a scoped block to misuse; React has no equivalent,
  // and its measured failure is the inline style instead.
  const scoped =
    kind === 'react'
      ? ''
      : `
══════════════════════════════════════════════
A SCOPED <style> BLOCK IS NOT WHERE THE DESIGN LIVES
══════════════════════════════════════════════
Vue scopes a component's <style> to that component, which makes it the
natural place to put styling and the wrong place to put the design. Measured
across real runs of one brief:

  React   globals.css 21–27k, 116–160 rules, scoped blocks  0
  Vue     globals.css  6–12k,  13– 77 rules, scoped 17–23k over  6–12 blocks

Vue was not writing less CSS. It was writing MORE of it, once per component — so
every component defined its own card, its own button, its own spacing, and no two
screens agreed.

So: every shape that appears on more than one screen, or in more than one
component, belongs in src/styles/globals.css as a class. A scoped <style> is
only for layout that genuinely belongs to this one component and appears nowhere
else — a grid template, a sticky offset. If you find yourself writing .card,
.btn, .badge, .field or .empty inside a component, it belongs in globals.css.`

  return `
══════════════════════════════════════════════
src/styles/globals.css IS THE DESIGN. Write it first, write it long.
══════════════════════════════════════════════
Every screen must look like the same product, and the stylesheet is the only
thing that makes them so. It carries the whole visual language, not just tokens:

- :root tokens — colour, type scale, spacing scale, radius, shadow, motion.
- The shell: app frame, header, sidebar, main column, page header, section.
- Every shape a screen needs, as a class the screens simply use:
  .card .panel .table .row .badge .tag .btn (+ variants) .field .input .select
  .checkbox .modal .toolbar .empty .skeleton .pagination .stat .chip .avatar
  .divider .list .grid
- Real states on anything interactive: :hover, :focus-visible, :active,
  [disabled], [aria-current], and a visible selected state.
- Responsive rules down to 390px, including the table-to-card fallback.

Aim for 80+ class rules on a multi-screen app. A thin stylesheet is the single
most visible way a generated app falls apart: each screen then invents its own
look.

══════════════════════════════════════════════
TEXT OVER A PHOTOGRAPH
══════════════════════════════════════════════
You do not know what the photograph looks like. The images are chosen from a
stock library after you write the CSS, so their brightness is not something you
can design around — and when a slot cannot be filled it falls back to a LIGHT
grey placeholder.

A fixed scrim therefore cannot work. Measured on a real hero banner:

  .hero-overlay { background: linear-gradient(180deg, rgba(0,0,0,.3), transparent); }

30% black is enough over a dark photo and nothing over a light one. The image
that arrived was the pale placeholder, the heading sat where the gradient had
faded, and the rendered contrast was 1.1:1 against a required 4.5 — white text
on a white background, measured in the browser.

Pick one of these instead, and never the bare gradient:

  1. A solid panel behind the words — the most reliable, because the contrast is
     then a property of your CSS alone:
       .hero-copy { background: rgba(17,17,17,.72); border-radius: var(--radius-md);
                    padding: var(--space-lg); backdrop-filter: blur(2px); }
  2. Text BESIDE the image rather than on it — two columns, or the image as a
     band above the copy. Always legible, and usually the better layout.
  3. If it must be a scrim, make it strong and solid where the text actually is:
     at least rgba(0,0,0,.55) behind the text itself, not a gradient that reaches
     that value somewhere the text is not.

Whatever you choose, the text colour must be fixed against YOUR background, not
against the photograph.
${scoped}

THEN USE IT. Screens carry classes, not inline styles:

  GOOD:  <article ${classAttr}="card card--product">
${inlineBad}

Inline styles are only for values that come from DATA — a width from a
percentage, a colour from a record. Everything else is a class. This is not a
matter of taste: an inline style cannot express :hover, :focus-visible,
:disabled or a media query, so a screen written that way has no interaction
states and no responsive behaviour at all.

Measured on a real run: 115 inline styles, 0 classes, and not one working hover
state on the entire application.`
}

/**
 * The structural contract, in the framework's own file names.
 *
 * This was one constant naming App.tsx, src/main.tsx, src/store/AppProvider.tsx,
 * useReducer and useApp() — sixteen React-specific lines handed to every Vue and
 * Svelte generation. The same mistake as the stylesheet contract, and with the
 * same result: the instruction lands for React and reads as being about some
 * other project for the other two.
 *
 * Measured on v144, from the section at the very top of this text. React
 * rendered NAV_ITEMS in its shell — badly, but it rendered it. Vue and Svelte
 * declared NAV_ITEMS in routes.ts, used it nowhere, and put a footer of
 * href="#" links where the navigation should have been. Both reported
 * `shell-without-nav`, and both survived three repair passes still reporting it.
 */
export function projectContract(kind: OutputKind): string {
  const fw = FRAMEWORKS[kind]
  const ext = fw.componentExt
  const shell = `App${ext}`

  /*
   * One icon, written the way this framework writes a component.
   *
   * The example below was React — an exported function returning JSX with a
   * `className` prop — and it was handed to Vue and Svelte generations verbatim,
   * as the model of what "a typed component per glyph" means. An example in
   * another language is worse than no example: it is the most concrete thing in
   * several thousand words of contract, so it is what gets copied.
   */
  const iconExample =
    kind === 'vue'
      ? `    <!-- src/components/icons/CalendarIcon.vue -->
    <template>
      <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="1.5" stroke-linecap="round"
           stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <path d="M16 2v4M8 2v4M3 10h18" />
      </svg>
    </template>
    <script setup lang="ts">
    withDefaults(defineProps<{ size?: number }>(), { size: 20 })
    </script>`
      : `    interface IconProps { size?: number; className?: string }
    export function CalendarIcon({ size = 20, className }: IconProps) {
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
             stroke="currentColor" strokeWidth={1.5} strokeLinecap="round"
             strokeLinejoin="round" className={className} aria-hidden="true">
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <path d="M16 2v4M8 2v4M3 10h18" />
        </svg>
      );
    }`

  return `
  THE SHELL CARRIES THE NAVIGATION. NAV_ITEMS is not a type exercise: the shell
  renders it as a real navigation (sidebar or top bar), marks the active entry
  with aria-current="page", and every screen is reachable — from it, or from the
  action that makes the screen meaningful. Measured on a
  real nine-screen build, routes.ts declared NAV_ITEMS and ${shell} rendered
  "<header><h1>title</h1></header><main>{screen}</main>" — so nothing could be
  reached from anything, and the app was one screen with eight dead files
  behind it.

  A MOCK STARTS SIGNED IN. If the product has authentication, the shared state
  begins with a demo user already signed in and the shell renders the app, not a
  sign-in wall. The login screen still exists and is reachable from a sign-out in
  the header, and the demo credentials are printed on it and really work.
  Measured: "if (!state.currentUser && route.screen !== login) { navigate(login); return null }"
  with "currentUser: null" in the initial state made every one of nine screens
  unreachable, and the reviewer saw a login form and nothing else.

  This layout is a real project a developer continues working in, not a preview
  artifact. Screens, reusable components and icons are separate directories because
  they have different lifetimes: a screen is edited once, a Button is edited by
  everyone. Do not collapse them.

  IMPORT PATHS — every hop is exactly one level, which is the point of this layout:
    from src/screens/X${ext}      ../components/ui/Button   ../components/icons/Search
                                ${kind === 'vue' ? '../composables/useNavigation' : '../hooks/useNavigation'}    ../store
                                ../data/rooms             ../lib/format   ../routes
    from src/components/ui/X    ../icons/Check            ../../lib/format
    from ${fw.entry}           ./App   ./store   ./styles/globals.css
  Extensions omitted. Type-only imports use "import type".

NAVIGATION — this is the heart of the output. Build it first.
  src/routes.ts declares:
    export type ScreenId = 'home' | 'list' | 'detail' | 'create' | 'settings'  (name them for the domain)
    export type Route = { screen: ScreenId; params?: Record<string, string> }
    export interface NavItem { id: ScreenId; label: string }
    export const NAV_ITEMS: NavItem[] = [...]     // only top-level screens
  NAV_ITEMS holds the screens that make sense with nothing selected and nothing
  done yet: a list, a cart, a dashboard, settings. A screen that needs something
  first is NOT in it — a detail needs a selection, checkout needs a cart with
  something in it, a confirmation or 完了 screen needs the action it confirms.
  Those are reached from that action (a card click, 「レジに進む」, 「注文を確定」).
  Measured on two storefronts: a menu listing 商品詳細・チェックアウト・注文完了
  opened a blank detail, took payment for an empty cart and thanked the user for
  an order never placed.
  And each such screen still guards itself, because a hash can be typed: with no
  selection, an empty cart or no order, it shows a short explanation and a link
  back (「カートは空です」＋「商品一覧へ」), never the form, never a blank page. The
  button that leads there is disabled while its precondition is false.
  src/hooks/useNavigation.ts exports useNavigation(): { route, navigate, back, canGoBack }
    - Serialises Route to the hash: '#/list', '#/detail/42'
    - Subscribes to 'hashchange' so browser back/forward genuinely work
    - Keeps a history stack so back() returns to the previous screen
    - MUST default to the first screen when the hash is empty or unrecognised.
      The app is loaded in a fresh frame with NO hash at all, so a parser that
      returns null/undefined there renders a blank page — this is the single most
      common way a generated project ships broken:

        const DEFAULT_ROUTE: Route = { screen: 'list' };   // your first screen
        function parseHash(hash: string): Route {
          if (!hash || !hash.startsWith('#/')) return DEFAULT_ROUTE;
          …
          return DEFAULT_ROUTE;      // unknown screen falls back, never null
        }

    - EVERY routing helper must survive being called with nothing. This is the
      second most common way, and it fails on a click rather than on load, so it
      reaches the user as a working page that dies when touched. Measured,
      reported from a generated storefront:

        TypeError: Cannot read properties of undefined (reading 'params')
          at hash (…)  at onClick (…)

      A handler called navigate() with no argument, or looked a route up in a
      table and passed the miss straight through. Write them so that cannot
      matter:

        type Nav = Route | ScreenId | undefined;         // BOTH shapes, deliberately

        function toRoute(next: Nav): Route {
          if (!next) return DEFAULT_ROUTE;                  // navigate() with nothing
          if (typeof next === 'string') return { screen: next };   // navigate('cart')
          return next;                                     // navigate({ screen: 'cart' })
        }
        function toHash(next?: Nav): string {
          const r = toRoute(next);
          const id = r.params?.id;                          // params is always optional
          return id ? '#/' + r.screen + '/' + id : '#/' + r.screen;
        }
        function navigate(next?: Nav): void {
          location.hash = toHash(next);
        }

      Take BOTH shapes. Not as a convenience — as the thing that makes the
      failure above impossible. The router and its call sites are written at
      different moments, they disagree about once per project, and TypeScript
      does not run here to catch it: the preview compiles with Sucrase, which
      strips the types without checking them. Measured, three separate runs:

        navigate({ screen: 'home' })  into  navigate(screen: ScreenId)  ->  '#/[object Object]'
        navigate('product')           into  navigate(next?: Route)      ->  throws on click
        navigate(item.id)             into  navigate(next?: Route)      ->  '#/undefined'

      The first and third do not even throw — a template literal stringifies
      anything — so they ship as routes nobody can parse and screens nobody can
      reach, with a clean console. A router that accepts either shape turns all
      three into a working navigation and costs four lines.

      And read ids the same way at the other end: a detail screen takes
      route.params?.id and renders its empty state when it is missing, rather
      than assuming the list set it.

  ${shell} renders the screen for route.screen, and EVERY id in the ScreenId union
  must have a branch. The router will happily parse any id in that union, so one
  without a branch is a route that renders a blank page.

  If you write a chain of conditionals rather than a switch — which is the common
  shape and is fine — it still needs a final fallback, because a chain of "&&"
  expressions has no default arm:

      const screen =
        route.screen === 'list'   ? <ListScreen /> :
        route.screen === 'detail' ? <DetailScreen id={route.params!.id} /> :
        <ListScreen />;                     // <- every union member is covered by this

  Never let the render fall through to null. An unmatched route has to show
  something, and a screen that only exists after signing in must still resolve to
  the sign-in screen rather than to nothing.

  Deliver 5 OR MORE screens, and they must be connected in both directions:
    - a top-level nav (sidebar or tab bar) with aria-current on the active item
    - list → detail via a row click, passing an id through route params
    - detail → back, via both the back control and the browser back button
    - a create/edit screen whose submit writes to the store and returns to the list,
      where the new record is visible
    - at least one modal or drawer that overlays without changing the screen
  Every screen is a real destination with its own content — no "coming soon" stubs.

STATE — the mock has to behave like a real app:
  One shared store in ${fw.storeFile} holds ALL shared data (${fw.storeHint}), typed
  with interfaces from src/store/types.ts and src/data. Screens read and write through
  it, so a change made on one screen is visible on every other. Component-local
  UI state (input text, open/closed) stays in the component.
  Wire the real interactions for whatever this product is, for example:
    - add to cart → the item appears on the cart screen, the badge count and total
      update, quantity can change, remove works, an empty state shows when emptied
    - book a slot / add an event → it appears in the list or calendar immediately
      and is visible from the other screens that show it
    - create / edit / delete a record → the list reflects it with no reload
    - filter, search and sort read from the store and redraw
  Forms validate, show inline errors, and on success update the store, give
  feedback and return to the relevant screen.

  EVERY screen must render when its route is opened directly, with no earlier
  screen having run. A detail screen reached by #/detail/42 whose record is not
  in the store, a confirmation screen with nothing yet confirmed, a step three
  with steps one and two unvisited: each renders an empty state naming what is
  missing and a control back to the screen that supplies it. Never dereference
  the missing value — item.price on an undefined item throws and takes the
  whole app down, not just that screen. item?.price is not the fix either: it
  renders an empty price and a broken-looking screen that reports as healthy.
  Guard the section and say what happened.

AUTHENTICATION — if this product has a login screen, it MUST be passable:
  A reviewer opening this mock has no account and no way to guess one, so a login
  screen that rejects everything makes the entire app unreachable. That is the
  worst possible defect: the work behind it is invisible.
    - Define the demo account in src/data/demoAccount.ts and export it:
        export const DEMO_ACCOUNT = { email: 'demo@example.com', password: 'demo1234' } as const;
    - Show it ON THE LOGIN SCREEN, in a bordered panel using the design system's
      surface and muted text — labelled 「デモアカウント」 with both values visible
      and selectable. Not a tooltip, not a comment in the code.
    - Put a 「デモアカウントを入力」 button in that panel which fills both fields.
    - The mock auth accepts exactly those credentials and rejects others with a real
      inline error, so the failure path is demonstrable too.
    - After sign-in, route to the first real screen and show the signed-in user in
      the chrome, with a working sign-out that returns to the login screen.
  If the product has no authentication, do not invent one.

IMAGERY — draw it, do not leave holes:
  There is no image generator and no CDN, so every graphic in this app is an inline
  SVG React component you write — with one deliberate exception, photographs, which
  get a designed placeholder (below) rather than invented artwork.

  src/components/illustrations/ holds the artwork, one component per piece:
    - Empty states: a simple line drawing of the thing that is missing (an empty
      shelf, an empty calendar), 120-180px, stroke-only, in the border colour and
      the muted text colour FROM THIS PROJECT'S OWN TOKENS — write the names your
      stylesheet actually defines. An undefined custom property on \`stroke\`
      computes to \`none\`, so a drawing in a token the stylesheet does not have
      is a drawing nobody can see. This instruction used to name --border and
      --text-muted; 22 of 34 shipped projects then drew invisible artwork,
      because the presets call those colours something else. Never an icon
      scaled up.

  EVERY PIECE YOU DRAW MUST BE RENDERED BY A SCREEN. A file in this folder that
  no screen imports and renders is worth nothing — it is not a mock of anything,
  it is a file. Measured across 75 shipped projects: 47 of the 56 that had this
  folder rendered none of it, and every one of those 47 had an empty state
  somewhere drawing its own shape instead. So for each piece, name where it goes
  before you write it:
    - the empty-state drawing goes inside the branch that renders when a list is
      empty — the same block that holds the 「まだありません」 text, not beside it;
    - the wordmark goes in the shell's header, next to or in place of the product
      name;
    - the content frame goes where a photo or a chart would sit.
  If a piece has nowhere to go, do not draw it.
  ${PHOTO_PLACEHOLDER_POLICY}

  ${PRODUCT_DEPTH}

  ${DESIGN_SIGNATURE}
    - Avatars are the one exception: initials on a tinted disc, derived from the
      person's name, is a real convention rather than invented artwork.
    - Data visuals: charts are inline SVG driven by the store's real numbers, with
      axes, labels and a hover readout — never a static picture of a chart.
    - Brand: a wordmark or monogram for the product, drawn once and used in the nav.

  Rules: viewBox with no fixed width/height (size from CSS), currentColor or the
  palette tokens only, no gradients unless the design system defines them, no
  filters, no photographic pretence. Decorative art gets aria-hidden="true";
  meaningful art gets role="img" and a <title>.
  Keep each piece under ~40 lines of markup — this is furniture, not illustration
  for its own sake.

  DRAW THIS PRODUCT, NOT A GENERIC SHAPE. The failure mode here is producing four
  neutral placeholders that satisfy the folder requirement and depict nothing:

    BAD   EmptyState${ext}  → a rounded square with a tick inside
    GOOD  EmptyState${ext}  → for an expense app, an outlined receipt with its lines
                            blank; for a booking app, an empty calendar cell grid

    BAD   DataChart${ext}   → three <rect> with hard-coded heights
    GOOD  DataChart${ext}   → interface { data: { label: string; value: number }[] }
                            and .map() over it, with axis labels from the data.
                            A chart that cannot be passed numbers is a picture of a
                            chart, and the reviewer is reading fictional figures.

    BAD   ContentBox${ext}  → one component reused for every row, so a list of twelve
                            items shows the same tile twelve times
    GOOD  ContentBox${ext}  → takes a seed (the record id) and varies the composition
                            from it, so the grid reads as twelve different things

  Name each file after what it depicts in this product, not after its slot.

INTERACTION COMPLETENESS — the acceptance bar:
  Before finishing, walk the screens you built and list every interactive element
  you placed: each nav item, button, link, tab, filter, sort control, search box,
  checkbox, toggle, select, form field, table row, card, icon button, pagination
  control, modal trigger and close control. Every one of them must do something
  real. If you cannot make one work, remove it rather than leaving it inert.
  Depth expected of a serious mock:
    - Lists: search, filter by at least one facet, sort by at least one column,
      and an empty state that appears when the filters match nothing
    - Records: open a detail view, edit it, delete it with a confirm step in the UI
      (a modal, not window.confirm), and see the list update
    - Forms: required-field validation with inline messages, a disabled submit
      until valid, a success state, and the new data visible afterwards
    - Quantities and money: recompute totals on every change; format numbers
    - Modals and drawers: open, close via the close button, the backdrop and Escape
    - Feedback: a toast or inline confirmation for actions that change data
    - Loading and empty states written as real UI, not as text placeholders
  Also handle: keyboard focus stays visible, Escape closes overlays, and the
  active screen is reflected in the nav.

  COMPOSITE WIDGETS TAKE ARROW KEYS. A calendar, a tab strip, a segmented
  control, a listbox and a set of radio-like options are ONE stop on the Tab
  ring, not one stop per cell. Inside, the arrows move and Enter or Space
  chooses:
    - calendar/grid: Left and Right move a day, Up and Down a week, and the
      focused cell is the only one with tabIndex={0} — the rest are -1
    - tabs and segmented controls: Left and Right move along, and the tab that
      has focus is the one shown
    - listbox and option lists: Up and Down move, Enter selects, Escape closes
  Wire this with onKeyDown on the container and a ref to the focused cell. A
  grid of forty buttons that are each individually tabbable is not keyboard
  support, it is forty presses of Tab to reach the second week.

  Nothing may be a dead control: every button changes state, navigates, or opens
  something. No alert()/confirm() as a substitute for UI, no "coming soon".

TYPESCRIPT QUALITY:
- Every component has a typed props interface. No "any".
- A component that works over rows of unknown shape — Table, List, Select — takes a
  TYPE PARAMETER, never any[]. This is the one place "any" reliably creeps back in:
    interface TableProps<T> { rows: T[]; onRowClick?: (row: T) => void }
    export default function Table<T>({ rows, onRowClick }: TableProps<T>) { … }
- Data modules export interfaces alongside their const arrays.
- Reducer actions are a discriminated union; the reducer switches exhaustively.
- Event handlers use the correct React types (React.ChangeEvent<HTMLInputElement>, …).

ICONS — src/components/icons/ is mandatory, emoji are not icons:
  Export a typed component per glyph and import them wherever an icon appears — nav
  items, buttons, empty states, status badges:

${iconExample}

  Rules: 24x24 viewBox, fill="none", stroke="currentColor", stroke-width 1.5,
  round caps and joins, aria-hidden on decorative icons. One consistent family.
  NEVER use an emoji as an icon. Any emoji used as UI chrome is a defect.

  EVERY GLYPH YOU DRAW MUST BE RENDERED BY A SCREEN OR A SHARED COMPONENT. A file
  in this folder that nothing imports and renders is not an icon, it is a file —
  and a project whose nav and buttons carry no icons, with a full icons folder,
  is the same project as one with no icons at all. Measured on a run that drew
  ChevronIcon, SearchIcon, CloseIcon and CheckIcon and rendered none of them:
  those are the four names anyone would pick before knowing where they go.
  So name the place first, and draw the glyphs THIS product's screens use:
    - every nav item takes one;
    - a button whose label is an action takes the glyph for that action;
    - the status badges and the icon-only controls take theirs.
  If a glyph has nowhere to go, do not draw it.

  AND TWO PLACES A GLYPH NEVER GOES, both reported by a user on one storefront
  whose project held exactly one icon:
    - ON A PHOTOGRAPH. A magnifier centred on a product image means nothing and
      covers the thing it is centred on. If the picture is meant to zoom, that
      is a control with a handler, not a decoration.
    - AS AN EMPTY STATE'S PICTURE. That is the illustration's job — see IMAGERY
      — and an icon enlarged to fill the space is the exact thing that section
      forbids. Measured across 28 stored documents whose empty states drew
      something: every one of them drew an icon there, and none an illustration.
  A project with one glyph and four places that want a graphic needs three more
  glyphs, not the same one four times.

QUALITY:
- Components stay small and single-purpose; no file over ~150 lines.
- Lists render from src/data via .map with stable key props.
- Accessible markup: semantic landmarks, labels tied to inputs, aria-current on the
  active nav item, aria-label on icon-only controls, visible :focus-visible styles.
- Realistic Japanese content unless the request is in another language.

══════════════════════════════════════════════
SPECIFICATION.md — required, at the project root
══════════════════════════════════════════════
Emit it as its own fenced block, before the source files, like every other file:

  @@@makeui:file SPECIFICATION.md
  …the document…
  @@@makeui:endfile

This is the document someone reads to understand what was built without opening
the code, and it is the document a developer picks up the work from. Write it for
that reader, in Japanese, with these headings:

  # <プロダクト名>
  1〜2文。何のためのUIで、誰が使うのか。

  ## 画面一覧
  表形式で「画面ID | 画面名 | 役割 | 到達経路」。ルートも書く（#/list など）。

  ## 画面ごとの仕様
  画面ごとに小見出しを立て、表示する情報、操作できる要素とその結果、空状態、
  エラー時の表示を箇条書きで。ここが本体なので省略しない。

  ## データ
  扱うレコードの型と主なフィールド。モックデータの件数も書く。

  ## 状態と遷移
  アプリ全体で共有する状態のキーと、どの操作がどれを書き換えるか。

  ## デザイン
  アクセントカラー（16進数）、ニュートラル、書体、角丸、余白の刻み、影の方針。

  ## 認証
  ログインがある場合のみ。デモ用の認証情報をここにも明記する。

  ## 対象外
  今回作っていないもの。無ければ見出しごと省略。

Rules:
- It describes what you ACTUALLY built. Not aspirations, not the brief restated.
  If a control did not get built, it is not in the specification.
- No code, no file paths, no framework talk. Those belong in README.md.
- 絵文字は使わない。
`
}
