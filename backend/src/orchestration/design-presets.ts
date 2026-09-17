/**
 * The design systems a build can be bound to, and the registry of the ones a
 * user brought.
 *
 * Split out of graph.ts, where these 741 lines sat between the model plumbing
 * above them and the scoring below — six specification documents, their
 * machine-checkable signatures, and the small registry that lets an imported
 * system be looked up by the same string a built-in one is. Nothing moved
 * except the file it lives in: graph.ts re-exports every name, so no call site
 * changed.
 *
 * The specs are prose on purpose. They are read by a model, not parsed, and the
 * signature beside each one is the part that is measured — see
 * `preset-conformance.ts`, which is where a spec becomes something a document
 * can be checked against.
 */
import { measureConformance, type PresetSignature, type MotionContract, type ConformanceResult } from './preset-conformance.js'
import { logger } from '../utils/logger.js'
import { foundationShadows } from './preset-foundation.js'

/**
 * Every value below is taken from the system's own published source, not from
 * memory, and the source is named in the spec's header so the next person to
 * touch it can check it again. Read 2026-09-14:
 *
 *   digital-agency  @digital-go-jp/design-tokens 2.0.1 (primitives, type, radius,
 *                   elevation), @digital-go-jp/tailwind-theme-plugin 1.0.1
 *                   (semantic colours, text styles), and the Agency's example
 *                   React components (button, input, link, banner, heading).
 *                   The site is at v2.18.0.
 *   carbon          @carbon/themes 11.81 (white theme + button and notification
 *                   component tokens), @carbon/type, @carbon/layout,
 *                   @carbon/styles 1.115 (component dimensions; square corners
 *                   are the v11 default, radii sit behind the v12 flag).
 *   spindle         @openameba/spindle-tokens 1.10 (spacing, shadow, motion,
 *                   font) and packages/spindle-tokens/tokens/theme-light in the
 *                   repository (colour); @openameba/spindle-ui 3.3 (component
 *                   dimensions). Its icons are CC BY-NC-ND and are NOT used.
 *   material3       @material/web 2.5 tokens v0_192 (baseline light scheme,
 *                   shape, typescale, typeface).
 *
 * The digital-agency spec replaced one written from memory whose values had
 * drifted from the system: #D32F2F for error where the system has #EC0000,
 * 40px buttons where it has 48 and 56, a blue focus ring where it has a black
 * outline over yellow, and a teal secondary it does not define.
 */
const PRESET_SPECS: Record<string, string> = {
  'digital-agency': `
DESIGN SYSTEM: デジタル庁デザインシステム (Digital Agency Design System, DADS)
Reference: https://design.digital.go.jp/dads/ (v2.18.0) — tokens from @digital-go-jp/design-tokens

─── COLORS (USE THESE EXACT VALUES) ───
Key colour (blue):
--color-key-900: #0017C1   (primary actions, active states)
--color-key-1000: #00118F  (hover; also link text)
--color-key-1200: #000060  (pressed)
--color-key-50: #E8F1FE    (text-button hover, selected row)
--color-key-100: #D9E6FF   (text-button pressed)
--color-key-200: #C5D7FB   (outline-button hover)
--color-key-300: #9DB7F9   (outline-button pressed)
Neutral (solid gray):
--color-white: #FFFFFF
--color-gray-50: #F2F2F2   (page sections, table header, disabled field background)
--color-gray-100: #E6E6E6
--color-gray-200: #CCCCCC  (dividers)
--color-gray-300: #B3B3B3  (disabled text/fill)
--color-gray-420: #949494  (non-text borders that must reach 3:1)
--color-gray-536: #767676  (the lightest text colour that passes AA on white)
--color-gray-600: #666666  (input borders, secondary text)
--color-gray-700: #4D4D4D
--color-gray-800: #333333  (body text in fields)
--color-gray-900: #1A1A1A  (headings and body text)
Semantic:
--color-success-1: #259D63   --color-success-2: #197A4B
--color-error-1: #EC0000     --color-error-2: #CE0000
--color-warning-yellow-1: #B78F00   --color-warning-yellow-2: #927200
--color-warning-orange-1: #FB5B01   --color-warning-orange-2: #C74700
Link: #00118F, visited #8B008B, underline always, underline-offset 3px
Focus (characteristic — never a plain blue ring):
  outline: 4px solid #000000; outline-offset: 2px; box-shadow: 0 0 0 2px #FFD43D
  (a black outline over a yellow ring, visible on any background)

─── TYPOGRAPHY ───
font-family: 'Noto Sans JP', -apple-system, BlinkMacSystemFont, sans-serif
Text styles are named size-weight-leading, and body text carries letter-spacing 0.02em:
Display: 48px / 700 / line-height 1.4
H1: 36px / 700 / 1.4   (std-36B-140)
H2: 32px / 700 / 1.5   (std-32B-150)
H3: 28px / 700 / 1.5   (std-28B-150)
H4: 24px / 700 / 1.5   (std-24B-150)
H5: 20px / 700 / 1.5   (std-20B-150)
H6: 16px / 700 / 1.7   (std-16B-170)
Body: 16px / 400 / 1.7 / letter-spacing 0.02em   (std-16N-170)
Body large: 17px / 400 / 1.7   Dense text: 16px / 400 / 1.3 (tables, labels)
Small: 14px / 400 / 1.5 — the smallest size used for content
Button/label text: 16px / 700 / line-height 1 (oln-16B-100)

─── SPACING ───
4px grid. Common steps: 4 / 8 / 12 / 16 / 24 / 32 / 40 / 48 / 64
Between fields 24px, between sections 40px, between page blocks 64px

─── RADIUS & ELEVATION ───
Radius tokens: 4 / 6 / 8 / 12 / 16 / 24 / 32 / full
  Buttons 8px (large/medium), 6px (small), 4px (extra small); inputs 8px; cards 8-16px
Elevation 1-8 exists for things that float — dropdowns, dialogs, the sticky header on
  scroll: elevation-1 = 0 2px 8px 1px rgba(0,0,0,0.1), 0 1px 5px 0 rgba(0,0,0,0.3)
  elevation-3 = 0 4px 16px 3px rgba(0,0,0,0.1), 0 1px 6px 0 rgba(0,0,0,0.3)
  Cards and panels on the page are flat with a 1px border — no shadow.

─── COMPONENTS ───
Buttons (min-width 96px, padding 0 16px, 16px/700 text, gap 4px before an icon):
  Sizes: large min-height 56px · medium 48px · small 36px · extra-small 28px
  Solid fill (primary): bg #0017C1, white text, 4px double transparent border;
    hover bg #00118F + underline; pressed bg #000060; disabled bg #B3B3B3, text #F2F2F2
  Outline: bg #FFFFFF, 1px solid currentColor, text #0017C1; hover bg #C5D7FB, text #00118F + underline
  Text: text #0017C1 underlined; hover bg #E8F1FE and a thicker 3px underline
Inputs / selects / textareas: 1px solid #666666, border-radius 8px, bg #FFFFFF,
  text 16px #333333, padding 12px 16px; heights large 56px · medium 48px · small 40px
  Hover: border #000000. Error: border #EC0000 with the message below in #CE0000.
  Read-only: dashed border. Disabled: border #B3B3B3, bg #F2F2F2, text #949494.
  Label above the field, 16px/700. A 必須 (required) badge beside the label.
Notification banner: 1px border and a 8px radius in the semantic colour, an icon, a
  heading 17px/700 (20px on desktop), body below; types success / error / warning / info
Status badge: bg #767676 or the semantic colour, white 16px text, 8px radius
Tables: header bg #F2F2F2, 1px #CCCCCC row dividers, 16px text line-height 1.3,
  cell padding 12px 16px, numbers right-aligned with tabular-nums
Definition list (dl/dt/dd) for record details; breadcrumbs above the page title.

─── LAYOUT ───
Content max-width 1200px, centred. 12-column grid, 24px gutter.
Breakpoints: mobile < 768px, tablet 768-1023px, desktop ≥ 1024px.

─── COMPOSITION (how screens are built in this system) ───
Shell: full-width header (service name left, utility links right, 1px bottom border),
  a breadcrumb row, then content in a centred column. Public services are entered
  from the top: one task per page, no persistent sidebar.
List/index screen: page title (H2), a one-sentence description of the list, a
  search box and filters (bordered selects and inputs, never chips-only), then the
  table. Rows are tall for legibility.
Detail screen: title, a status badge, then a definition list of the record's fields.
  Actions sit together at the bottom of the content, the forward action first.
Procedure/form screen: a step navigation across the top showing every step with the
  current one marked; one logical group per section under a bordered heading; a
  confirm step that re-displays every entered value as a read-only definition list
  before submission. This confirm-before-submit pattern is characteristic — include it
  whenever the flow writes something.
Notices: the notification banner for deadlines, required documents and errors. Never a
  toast for anything the user must not miss.
Density: airy. 24px between fields, 40px between sections.

─── AESTHETIC ───
Plain, authoritative, accessible public-service UI (JIS X 8341-3 AA).
No gradients, no decorative shadows on the page, no ornament.
Underlined links and underline-on-hover buttons are part of the system, not decoration.
ALL text must be in Japanese (日本語).`,

  carbon: `
DESIGN SYSTEM: Carbon Design System (IBM) — white theme, productive
Reference: https://carbondesignsystem.com/ — tokens from @carbon/themes, @carbon/type, @carbon/layout

─── COLORS (USE THESE EXACT VALUES) ───
--cds-background: #FFFFFF
--cds-layer-01: #F4F4F4        (panels, tiles, the field background)
--cds-layer-hover-01: #E8E8E8
--cds-layer-selected-01: #E0E0E0
--cds-layer-accent-01: #E0E0E0 (table header)
--cds-field-01: #F4F4F4
--cds-border-subtle-00: #E0E0E0
--cds-border-subtle-01: #C6C6C6
--cds-border-strong-01: #8D8D8D (the bottom border of fields)
--cds-text-primary: #161616
--cds-text-secondary: #525252
--cds-text-helper: #6F6F6F
--cds-text-on-color: #FFFFFF
--cds-link-primary: #0F62FE   hover #0043CE   visited #8A3FFC
--cds-interactive: #0F62FE
--cds-focus: #0F62FE
--cds-highlight: #D0E2FF
--cds-support-error: #DA1E28
--cds-support-success: #24A148
--cds-support-warning: #F1C21B
--cds-support-info: #0043CE
Buttons: primary #0F62FE (hover #0050E6, active #002D9C) · secondary #393939 (hover #474747)
  · danger #DA1E28 (hover #B81921)
Notifications background: error #FFF1F1 · success #DEFBE6 · warning #FCF4D6 · info #EDF5FF
UI shell header: #161616 with #F4F4F4 text

─── TYPOGRAPHY ───
font-family: 'IBM Plex Sans JP', 'IBM Plex Sans', system-ui, -apple-system, sans-serif
Monospace: 'IBM Plex Mono', Menlo, monospace
Productive type set (sizes in px / weight / line-height / letter-spacing):
heading-07: 54 / 300 / 1.19 / 0   (display numbers only)
heading-06: 42 / 300 / 1.199 / 0
heading-05: 32 / 400 / 1.25 / 0
heading-04: 28 / 400 / 1.29 / 0
heading-03: 20 / 400 / 1.4 / 0
heading-02: 16 / 600 / 1.5 / 0
heading-01: 14 / 600 / 1.43 / 0.16px
body-01: 14 / 400 / 1.43 / 0.16px   (the default text size)
body-02: 16 / 400 / 1.5 / 0
label-01 / helper-text-01: 12 / 400 / 1.33 / 0.32px
Headings are light (400) above 16px — weight is not how Carbon builds hierarchy.

─── SPACING ───
Spacing scale (px): 2 / 4 / 8 / 12 / 16 / 24 / 32 / 40 / 48 / 64 / 80 / 96 / 160
Grid: 2x grid, 16-column at large screens, 32px gutter; breakpoints sm 320 · md 672 · lg 1056 · xl 1312 · max 1584

─── SHAPE & ELEVATION ───
Corners are SQUARE: border-radius 0 on buttons, fields, tiles, tables, modals and
  notifications. The only rounded element is the tag (a pill: border-radius 999px).
Elevation only for things that float (menus, dropdown lists): 0 2px 6px rgba(0,0,0,0.3).
  Tiles and panels separate by background layer, not shadow.
Motion: productive — fast 70ms / 110ms, moderate 150ms / 240ms, cubic-bezier(0.2, 0, 0.38, 0.9)

─── COMPONENTS ───
Buttons: height 48px (large, the default), 40px (medium), 32px (small); padding
  0 64px 0 16px (label left-aligned, room for a trailing icon); 14px/400 text;
  radius 0; primary / secondary / tertiary (1px #0F62FE border, blue text) / ghost / danger.
  Focus: 2px inset #0F62FE outline with a 1px inset #FFFFFF.
Text input: height 40px, bg #F4F4F4, NO border except a 1px #8D8D8D bottom border,
  padding 0 16px, 14px text; label above in 12px #525252; helper text below 12px #6F6F6F;
  focus 2px #0F62FE outline; invalid: 2px #DA1E28 outline and a red message.
Data table: header bg #E0E0E0, 14px/600 header text; rows 48px (default) with a
  1px #E0E0E0 bottom border; row hover #E8E8E8; selected #E0E0E0; a toolbar above
  (search, batch actions) and pagination below.
Inline notification: min-height 48px, background by type (above), a 3px left border
  in the support colour, an icon, a bold title and a subtitle on one line.
Tag: height 24px, border-radius 999px (pill), 12px text, tinted background.
Tabs: 48px, 2px bottom border on the selected tab in #0F62FE (line style).
Tile: bg #F4F4F4, padding 16px, radius 0.

─── COMPOSITION (how screens are built in this system) ───
Shell: the UI shell — a 48px dark header (#161616, product name left, global actions
  right) and, for multi-section products, a 256px left side nav on #FFFFFF with 32px
  items; content to the right on #FFFFFF.
Page header: breadcrumb, a heading-04/05 title, optional tabs directly under it.
List screen: data table with a toolbar (search on the left, filter and primary action on
  the right, batch-action bar replacing the toolbar when rows are selected) and
  pagination (items per page, range, page arrows) in a strip below.
Detail screen: structured list or tiles in a 16-column grid; actions in the page
  header's right side.
Forms: fields in a single column up to 8 grid columns wide, 32px between groups,
  primary button bottom-left with secondary to its left in a button set.
Dashboard: tiles on #F4F4F4 in a grid with 1px gaps; numbers in heading-05.
Density: productive and compact. 48px rows, 14px text.

─── AESTHETIC ───
Industrial clarity: square corners, a strict grid, layers of grey, one blue for
  interaction. No gradients, no decorative shadows, no rounded cards.
Content in Japanese (日本語) unless the request says otherwise.`,

  spindle: `
DESIGN SYSTEM: Spindle (Ameba Design System, CyberAgent) — light theme
Reference: https://spindle.ameba.design/ — tokens from @openameba/spindle-tokens and the repository's theme-light tokens
Spindle icons are licensed CC BY-NC-ND: do NOT copy them. Draw simple line icons of your own.

─── COLORS (USE THESE EXACT VALUES) ───
Surface:
--color-surface-primary: #FFFFFF
--color-surface-secondary: #08121A0A   (grouped backgrounds)
--color-surface-tertiary: #08121A14    (neutral buttons, chips)
--color-surface-accent-primary: #298737 (Ameba green — primary actions)
--color-surface-accent-primary-light: #E7F5E9
--color-surface-accent-secondary: #82BE28
--color-surface-accent-secondary-light: #F0F7E6
--color-surface-accent-neutral-high-emphasis: #394148 (dark chips, tooltips)
--color-surface-caution: #D91C0B
Text:
--color-text-high-emphasis: #08121A
--color-text-medium-emphasis: #08121ABD
--color-text-low-emphasis: #08121A9C
--color-text-disable: #08121A4D
--color-text-accent-primary: #237B31
--color-text-accent-secondary: #477D00
--color-text-caution: #D91C0B
--color-text-high-emphasis-inverse: #FFFFFF
Border:
--color-border-high-emphasis: #08121A78
--color-border-medium-emphasis: #08121A4D (text fields)
--color-border-low-emphasis: #08121A14 (dividers)
--color-border-accent-primary: #298737
--color-border-caution: #D91C0B
Object: accent secondary #5E9B15, rating #EE7B00, expressive pink #E6456A
Focus: #0091FF (2px outline, 1px offset)
Hover/active: contained button #0F5C1F · outlined button #E7F5E9 · lighted button #C6E5C9
Note the system tints text and borders by ALPHA of one ink colour (#08121A), not by
  separate greys — write them as 8-digit hex or rgba(8,18,26,α).

─── TYPOGRAPHY ───
font-family: 'Helvetica Neue', Helvetica, Arial, 'Segoe UI', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', Meiryo, sans-serif
Headings 700, line-height 1.3; body 16px / 400 / line-height 1.6 (1.8 for long reading)
Sizes: 28 / 22 / 20 / 17 / 16 / 14 / 13 / 12 px
Button text 700; captions 13px medium emphasis

─── SPACING ───
Spacing levels (px): 4 / 6 / 8 / 12 / 14 / 16 / 20 / 24 / 28 / 36 / 40 / 44 / 48 / 56 / 64 / 72 / 80 / 96
Mobile-first: 16px screen padding on mobile, 24px on tablet, 40px on desktop

─── SHAPE, ELEVATION, MOTION ───
Radii: buttons are PILLS (border-radius 3em) · text fields 8px · navigation tabs 8px ·
  dropdown menus and inline notifications 12px · dialogs and semi-modals 20px ·
  snackbars 4px · avatars and icon buttons 50%
Shadow (box-shadow): lv2 0 3.25px 7.75px 0 #08121A1F · lv4 0 4.75px 14.25px 0 #08121A1F
  · lv6 0 11px 28px 0 #08121A1F — for cards that float, menus and dialogs
Motion: fast 150ms, neutral 350ms; ease-out cubic-bezier(0,0,0,1); a light bounce
  cubic-bezier(0.55,2.05,0.65,0.75) is allowed for small appearing elements (likes, badges)

─── COMPONENTS ───
Buttons (700 text, line-height 1.3, full-width on mobile):
  large min-height 48px, 16px text, padding 8px 16px · medium 40px, 14px · small 32px, 13px
  contained: bg #298737, white text, hover #0F5C1F
  outlined: 2px solid #298737, text #298737, hover bg #E7F5E9
  lighted: bg #E7F5E9, text #237B31
  neutral: bg #08121A14, text #08121ABD
  danger: 2px solid #D91C0B, text #D91C0B
  disabled: opacity 0.3
Text field: min-height 48px (40px small), padding 0 16px, 1px solid #08121A4D,
  radius 8px, 16px text; focus 2px #0091FF outline; error border and message in #D91C0B
Inline notification: radius 12px, tinted surface, icon + one-line text + optional action
Snackbar: dark surface, white text, radius 4px, bottom of the screen
Navigation tab: text tabs with an 8px-radius active indicator
Dialog: radius 20px, padding 24px, actions stacked full-width on mobile
Semi-modal: a bottom sheet with a 20px top radius
List: 16px text rows with a 1px #08121A14 divider and a chevron for navigation

─── COMPOSITION (how screens are built in this system) ───
Mobile-first consumer service. Design at 375px first, then widen to a centred
  column (max ~720px for content, 1080px for grids).
Shell: a simple top bar (service name or back arrow + title, actions right), and on
  primary screens a bottom navigation with 4-5 destinations. On desktop the same
  destinations become a horizontal header nav.
Feed / list screen: cards or list rows with a thumbnail, title (700), one line of
  meta in medium emphasis, and a reaction row (like, comment) — content first.
Detail screen: hero image or title block, author/meta row with an avatar, body text
  at 16px/1.8, then related items and a sticky bottom action bar on mobile.
Forms: one field per row, labels above, a full-width contained button at the bottom.
Empty/success states: a friendly illustration of your own, one sentence, one action.
Density: comfortable. 16-24px between elements, generous touch targets (≥44px).

─── AESTHETIC ───
Friendly, soft and legible: pill buttons, rounded cards and dialogs, one green accent,
  ink-alpha greys. Warm microcopy in Japanese (日本語). No gradients on text, no heavy shadows.`,

  material3: `
DESIGN SYSTEM: Material Design 3 (Google) — baseline light scheme
Reference: https://m3.material.io/ — tokens from @material/web (v0_192)

─── COLORS (USE THESE EXACT VALUES — the baseline scheme) ───
--md-sys-color-primary: #6750A4
--md-sys-color-on-primary: #FFFFFF
--md-sys-color-primary-container: #EADDFF
--md-sys-color-on-primary-container: #21005D
--md-sys-color-secondary: #625B71
--md-sys-color-secondary-container: #E8DEF8
--md-sys-color-on-secondary-container: #1D192B
--md-sys-color-tertiary: #7D5260
--md-sys-color-tertiary-container: #FFD8E4
--md-sys-color-on-tertiary-container: #31111D
--md-sys-color-error: #B3261E
--md-sys-color-error-container: #F9DEDC
--md-sys-color-on-error-container: #410E0B
--md-sys-color-surface: #FEF7FF
--md-sys-color-surface-container-lowest: #FFFFFF
--md-sys-color-surface-container-low: #F7F2FA
--md-sys-color-surface-container: #F3EDF7
--md-sys-color-surface-container-high: #ECE6F0
--md-sys-color-surface-container-highest: #E6E0E9
--md-sys-color-surface-variant: #E7E0EC
--md-sys-color-on-surface: #1D1B20
--md-sys-color-on-surface-variant: #49454F
--md-sys-color-outline: #79747E
--md-sys-color-outline-variant: #CAC4D0
--md-sys-color-inverse-surface: #322F35
--md-sys-color-inverse-on-surface: #F5EFF7
--md-sys-color-inverse-primary: #D0BCFF
--md-sys-color-scrim / shadow: #000000 (scrim at 32% behind dialogs)
State layers: hover 8%, focus 10%, pressed 10% of the on-colour over the component.
Focus ring: a 3px outline in secondary #625B71, 2px outside the component.

─── TYPOGRAPHY ───
font-family: Roboto, 'Noto Sans JP', system-ui, sans-serif
Type scale (size / line-height / weight / tracking):
display-large: 57 / 64 / 400 / -0.25px
display-medium: 45 / 52 / 400 / 0
display-small: 36 / 44 / 400 / 0
headline-large: 32 / 40 / 400 / 0
headline-medium: 28 / 36 / 400 / 0
headline-small: 24 / 32 / 400 / 0
title-large: 22 / 28 / 400 / 0
title-medium: 16 / 24 / 500 / 0.15px
title-small: 14 / 20 / 500 / 0.1px
body-large: 16 / 24 / 400 / 0.5px
body-medium: 14 / 20 / 400 / 0.25px
body-small: 12 / 16 / 400 / 0.4px
label-large: 14 / 20 / 500 / 0.1px (buttons, tabs)
label-medium: 12 / 16 / 500 / 0.5px
label-small: 11 / 16 / 500 / 0.5px

─── SHAPE, ELEVATION, MOTION ───
Corner scale: none 0 · extra-small 4px · small 8px · medium 12px · large 16px ·
  extra-large 28px · full (pill)
  Buttons full · chips 8px · cards 12px · FAB 16px · dialogs 28px · text fields 4px (top corners for filled)
Elevation levels: 0 · 1 = 0 1px 2px rgba(0,0,0,0.3), 0 1px 3px 1px rgba(0,0,0,0.15) ·
  2 = 0 1px 2px rgba(0,0,0,0.3), 0 2px 6px 2px rgba(0,0,0,0.15) ·
  3 = 0 1px 3px rgba(0,0,0,0.3), 0 4px 8px 3px rgba(0,0,0,0.15)
  Most surfaces separate by surface-container tone, not shadow.
Motion: standard easing cubic-bezier(0.2, 0, 0, 1); 200ms small (short4), 300ms / 400ms larger transitions (medium2 / medium4)

─── COMPONENTS ───
Buttons: height 40px, padding 0 24px, radius full, label-large text
  Filled: bg #6750A4, text #FFFFFF · Tonal: bg #E8DEF8, text #1D192B
  Outlined: 1px #79747E border, text #6750A4 · Text: text #6750A4, padding 0 12px
  Elevated: bg #F7F2FA, text #6750A4, elevation 1
FAB: 56px, radius 16px, bg #EADDFF, icon #21005D, elevation 3; bottom-right on mobile
Text fields: height 56px, label floats; Filled: bg #E6E0E9, radius 4px 4px 0 0,
  1px #49454F bottom indicator (2px #6750A4 when focused); Outlined: 1px #79747E,
  radius 4px (2px #6750A4 when focused); error #B3261E; supporting text 12px below
Cards: radius 12px, padding 16px; elevated (bg #F7F2FA + level 1), filled (bg
  #E6E0E9), or outlined (1px #CAC4D0)
Chips: height 32px, radius 8px, 1px #79747E border (filter chips get a check and
  bg #E8DEF8 when selected)
Lists: rows 56px (one line) / 72px (two lines), 16px side padding, leading icon or avatar
Top app bar: 64px, title-large title, surface colour (surface-container on scroll)
Navigation bar (mobile): 80px, 3-5 destinations, active indicator pill 64x32 in #E8DEF8
Navigation rail (tablet/desktop): 80px wide, same pill indicator
Dialog: radius 28px, bg #ECE6F0, headline-small title, text buttons right-aligned
Snackbar: bg #322F35, text #F5EFF7, action in #D0BCFF, radius 4px

─── COMPOSITION (how screens are built in this system) ───
Adaptive layout by window size: compact (< 600px) uses a top app bar + navigation bar
  at the bottom; medium (600-839px) a navigation rail; expanded (≥ 840px) a rail or a
  navigation drawer with list-detail panes side by side.
List screen: top app bar with search, a row of filter chips, then a list or a grid of
  cards; a FAB for the primary create action.
Detail screen: top app bar with a back arrow and actions, a hero or header block, then
  content sections; on expanded windows the detail sits in a pane beside the list.
Forms: outlined text fields in one column, 16-24px apart, the filled primary button at
  the bottom (full-width on compact).
Density: comfortable; 8px grid; 16px screen margins on compact, 24px on medium and up.

─── AESTHETIC ───
Tonal, soft and touch-friendly: surfaces separated by tone, pill buttons, rounded
  containers, one purple primary with tonal containers. Content in Japanese (日本語)
  unless the request says otherwise. No gradients, no hard black shadows.`,
}

/**
 * What to do with a preset naming an imported design system: nothing.
 *
 * This used to load the record, register its spec and signature, and build
 * against it. There are no records to load — the importer, the store, and the
 * three routes between them are gone, and nothing can select one — so the
 * lookup could only ever have missed, and a lookup that can only miss is a
 * round trip to the database to reach the line below it.
 *
 * The value still arrives. Projects built while the importer existed carry
 * `system:<uuid>` in their record, and an old job can be resumed carrying one.
 * `'none'` rather than a built-in preset, for the reason it always was: giving
 * someone a design system they did not choose, applied and enforced, is worse
 * than giving them none.
 */
export async function resolveUserDesignSystem(preset: string | undefined, userId: string, requestId: string): Promise<string | null> {
  if (preset?.startsWith('system:')) {
    logger.info('Imported design systems are no longer available; building without one',
      { requestId, userId, preset })
    return 'none'
  }
  /*
   * A built-in preset that was removed, for the same reason and to the same place.
   *
   * product, editorial, warm, console and wireframe were styles written for this
   * app rather than published systems, and were removed on 2026-09-14 when three
   * published systems were added. Projects built with them still carry the name.
   * Without this the name reached `getPresetConfig`, which answered with a KB
   * prefix for a corpus that no longer exists and no spec at all — a build bound
   * to nothing that still logged a preset name.
   */
  if (preset && preset !== 'none' && !PRESET_SPECS[preset]) {
    logger.info('Preset is no longer available; building without one', { requestId, userId, preset })
    return 'none'
  }
  return null
}

/** The built-in presets, for the API and the tests. `none` is always valid. */
export function presetIds(): string[] {
  return ['none', ...Object.keys(PRESET_SPECS)]
}

export function getPresetSpec(presetName: string): string {
  // Unknown/none → no spec. Never silently substitute a different design system.
  return PRESET_SPECS[presetName] || ''
}

/**
 * Signature values that must survive from the preset spec into the generated HTML.
 * Used to score conformance and to build the repair instruction when a preset is
 * only partially applied — prose instructions alone let the model drift.
 */
/**
 * The machine-checkable contract for each preset.
 *
 * `required` anchors the system is present at all; `palette`, `radii`,
 * `elevation` and `font` are what actually hold it in place — they are measured
 * against the document after custom properties and units are resolved, so a
 * system expressed entirely in tokens is still verifiable.
 */
const PRESET_SIGNATURE: Record<string, PresetSignature> = {
  'digital-agency': {
    required: ['#0017C1', '#1A1A1A', 'Noto Sans JP'],
    palette: ['#0017C1', '#00118F', '#000060', '#E8F1FE', '#D9E6FF', '#C5D7FB', '#9DB7F9',
      '#FFFFFF', '#F2F2F2', '#E6E6E6', '#CCCCCC', '#B3B3B3', '#949494', '#767676', '#666666',
      '#4D4D4D', '#333333', '#1A1A1A', '#000000',
      '#259D63', '#197A4B', '#EC0000', '#CE0000', '#B78F00', '#927200', '#FB5B01', '#C74700',
      '#8B008B', '#FFD43D'],
    radii: [4, 6, 8, 12, 16, 24, 32],
    // Elevation 1-8 is part of the system, for things that float; the page itself is flat.
    elevation: 'subtle',
    motion: { namedPropertiesOnly: true, maxDurationMs: 400 },
    font: 'Noto Sans JP',
  },
  carbon: {
    required: ['#0F62FE', '#161616', '#F4F4F4', 'IBM Plex Sans'],
    palette: ['#0F62FE', '#0050E6', '#002D9C', '#0043CE', '#D0E2FF', '#EDF5FF', '#8A3FFC',
      '#FFFFFF', '#F4F4F4', '#E8E8E8', '#E0E0E0', '#C6C6C6', '#8D8D8D', '#6F6F6F', '#525252',
      '#474747', '#393939', '#161616',
      '#DA1E28', '#B81921', '#FFF1F1', '#24A148', '#DEFBE6', '#F1C21B', '#FCF4D6'],
    // Square in v11. Tags are pills, which the radius check does not count.
    radii: [],
    elevation: 'subtle',
    motion: { namedPropertiesOnly: true, maxDurationMs: 240 },
    font: 'IBM Plex Sans',
  },
  spindle: {
    required: ['#298737', '#08121A', 'Hiragino Sans'],
    // Alpha tints of #08121A are written as 8-digit hex, which the palette measure does
    // not read; the 6-digit ink itself, and every solid colour, is listed.
    palette: ['#298737', '#237B31', '#0F5C1F', '#E7F5E9', '#C6E5C9', '#82BE28', '#477D00',
      '#5E9B15', '#F0F7E6', '#FFFFFF', '#08121A', '#394148', '#D91C0B', '#0091FF', '#EE7B00',
      '#E6456A'],
    radii: [4, 8, 12, 20],
    elevation: 'subtle',
    motion: { namedPropertiesOnly: true, maxDurationMs: 500 },
    font: 'Hiragino Sans',
  },
  material3: {
    required: ['#6750A4', '#1D1B20', '#FEF7FF', 'Roboto'],
    palette: ['#6750A4', '#FFFFFF', '#EADDFF', '#21005D', '#625B71', '#E8DEF8', '#1D192B',
      '#7D5260', '#FFD8E4', '#31111D', '#B3261E', '#F9DEDC', '#410E0B', '#FEF7FF', '#F7F2FA',
      '#F3EDF7', '#ECE6F0', '#E6E0E9', '#E7E0EC', '#1D1B20', '#49454F', '#79747E', '#CAC4D0',
      '#322F35', '#F5EFF7', '#D0BCFF', '#000000'],
    radii: [4, 8, 12, 16, 28],
    elevation: 'subtle',
    motion: { namedPropertiesOnly: true, maxDurationMs: 500 },
    font: 'Roboto',
  },
  /**
   * `none` had no signature at all, so the most-used option was the only one
   * with zero enforcement — and the one where machine-made defaults creep back.
   * There is no palette to check against, but the tells are still checkable.
   */
  none: {
    required: [],
    forbidden: [
      // The indigo-violet default, in any of its usual spellings.
      /#6366f1|#818cf8|#8b5cf6|#7c3aed|#a855f7|#4f46e5|#c084fc/i,
    ],
    elevation: 'subtle',
  },
}

/**
 * How closely the document was built to its design system.
 *
 * Delegates to `measureConformance`, which normalises custom properties and
 * units first. That matters: the previous implementation matched literal values
 * at the point of use, which modern token-based output made unreachable, so the
 * checks had quietly stopped being able to fail.
 */
/** The radii a preset permits, or an empty list when it constrains none. */
/**
 * Whether this preset has anything to measure against.
 *
 * Exported instead of the table, which is mutable — `registerDesignSystem`
 * adds and evicts entries — and a caller holding a reference to it could read a
 * different system than the one the run resolved. Callers only ever asked
 * `PRESET_SIGNATURE[name] ? …`, which is this question.
 */
export function hasPresetSignature(presetName: string): boolean {
  return Boolean(PRESET_SIGNATURE[presetName])
}

export function presetRadii(presetName: string): number[] {
  return PRESET_SIGNATURE[presetName]?.radii ?? []
}

/** What a preset permits of movement, or null when it constrains none. */
export function presetMotion(presetName: string): MotionContract | null {
  return PRESET_SIGNATURE[presetName]?.motion ?? null
}

export function presetConformance(html: string, presetName: string): ConformanceResult {
  const sig = PRESET_SIGNATURE[presetName]
  if (!sig) return { ratio: 1, missing: [], violations: 0, paletteShare: 1, details: [] }
  // The system's own elevation, from the token block's table — one source for both.
  return measureConformance(html, { ...sig, shadows: foundationShadows(presetName) })
}
