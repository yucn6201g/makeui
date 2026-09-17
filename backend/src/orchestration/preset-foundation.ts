import { normaliseCss, withoutFoundation, FOUNDATION_START, FOUNDATION_END } from './preset-conformance.js'
import { isFencedTransport, readProjectFiles, writeProjectFile } from '../tools/project-transport.js'

/**
 * The part of a design system that is values, written by code instead of by a model.
 *
 * Every build bound to a preset used to ask the model to transcribe the spec's
 * colours into :root. Measured on the four verification runs of 2026-09-14 (one
 * per preset, all conformance 1.0): none of them loaded its typeface. Not one
 * `@font-face`, not one Google Fonts link — so Carbon rendered without IBM Plex,
 * Material 3 without Roboto, and the Agency's pages in whatever the viewer had
 * installed. Conformance still read 100%, because it checks that the font's NAME
 * is in a `font-family` declaration, and it was.
 *
 * A value table is not a design decision. It has one right answer, published by
 * the system, and a model asked to copy it can only match it or drift. So the
 * block below is generated from the same published tokens the spec was written
 * from, put at the top of src/styles/globals.css, and put back after every step
 * that could have removed it. The model's job is to reference it.
 *
 * What it carries:
 *   - the font import, where the typeface is a web font (Spindle's stack is the
 *     platform's own fonts, as the system publishes it, so it has none)
 *   - the colour, type, spacing, radius, elevation, motion and control-height
 *     tokens, under the system's own names where it has them
 *   - the focus indicator, as a rule rather than a token, with `!important`:
 *     it is the one place a component's own rule must not win. The Agency's
 *     black-over-yellow focus is what makes a page recognisably theirs, and a
 *     build that restyled it per component had left the system.
 *
 * What it does not: component shapes and layout. Those stay the model's, guided by
 * the spec, because they are the design work.
 */

export interface PresetFoundation {
  /** Google Fonts css2 URL, when the typeface is a web font. */
  fontImport?: string
  /** The custom property holding the base font stack. */
  fontVar: string
  /** Custom properties, in the order they are written. */
  vars: [string, string][]
  /** Declarations for the focus-visible rule. */
  focus: string
  /** Font sizes the type scale permits, px. */
  typeScale: number[]
  /** Spacing steps, px. */
  spacing: number[]
  /** Heights a text or action button may take, px. */
  buttonHeights: number[]
  /** Heights a text field or select may take, px. */
  fieldHeights: number[]
}

const px = (values: number[]) => values.map((v) => `${v}px`).join(' / ')

const FOUNDATIONS: Record<string, PresetFoundation> = {
  /* @digital-go-jp/design-tokens 2.0.1 and the Agency's example components. */
  'digital-agency': {
    fontImport: 'https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&display=swap',
    fontVar: '--font-family-base',
    vars: [
      ['--color-key-50', '#E8F1FE'], ['--color-key-100', '#D9E6FF'], ['--color-key-200', '#C5D7FB'],
      ['--color-key-300', '#9DB7F9'], ['--color-key-900', '#0017C1'], ['--color-key-1000', '#00118F'],
      ['--color-key-1200', '#000060'],
      ['--color-white', '#FFFFFF'], ['--color-black', '#000000'],
      ['--color-gray-50', '#F2F2F2'], ['--color-gray-100', '#E6E6E6'], ['--color-gray-200', '#CCCCCC'],
      ['--color-gray-300', '#B3B3B3'], ['--color-gray-420', '#949494'], ['--color-gray-536', '#767676'],
      ['--color-gray-600', '#666666'], ['--color-gray-700', '#4D4D4D'], ['--color-gray-800', '#333333'],
      ['--color-gray-900', '#1A1A1A'],
      ['--color-success-1', '#259D63'], ['--color-success-2', '#197A4B'],
      ['--color-error-1', '#EC0000'], ['--color-error-2', '#CE0000'],
      ['--color-warning-yellow-1', '#B78F00'], ['--color-warning-yellow-2', '#927200'],
      ['--color-warning-orange-1', '#FB5B01'], ['--color-warning-orange-2', '#C74700'],
      ['--color-link', '#00118F'], ['--color-link-visited', '#8B008B'], ['--color-focus-yellow', '#FFD43D'],
      ['--font-family-base', "'Noto Sans JP', -apple-system, BlinkMacSystemFont, sans-serif"],
      ['--font-size-display', '48px'], ['--font-size-h1', '36px'], ['--font-size-h2', '32px'],
      ['--font-size-h3', '28px'], ['--font-size-h4', '24px'], ['--font-size-h5', '20px'],
      ['--font-size-h6', '16px'], ['--font-size-body-large', '17px'], ['--font-size-body', '16px'],
      ['--font-size-small', '14px'],
      ['--line-height-heading-tight', '1.4'], ['--line-height-heading', '1.5'], ['--line-height-body', '1.7'],
      ['--line-height-dense', '1.3'], ['--letter-spacing-body', '0.02em'],
      ['--space-4', '4px'], ['--space-8', '8px'], ['--space-12', '12px'], ['--space-16', '16px'],
      ['--space-24', '24px'], ['--space-32', '32px'], ['--space-40', '40px'], ['--space-48', '48px'],
      ['--space-64', '64px'],
      ['--radius-4', '4px'], ['--radius-6', '6px'], ['--radius-8', '8px'], ['--radius-12', '12px'],
      ['--radius-16', '16px'], ['--radius-24', '24px'], ['--radius-32', '32px'], ['--radius-full', '9999px'],
      ['--elevation-1', '0 2px 8px 1px rgba(0, 0, 0, 0.1), 0 1px 5px 0 rgba(0, 0, 0, 0.3)'],
      ['--elevation-3', '0 4px 16px 3px rgba(0, 0, 0, 0.1), 0 1px 6px 0 rgba(0, 0, 0, 0.3)'],
      ['--button-height-large', '56px'], ['--button-height-medium', '48px'],
      ['--button-height-small', '36px'], ['--button-height-xsmall', '28px'],
      ['--field-height-large', '56px'], ['--field-height-medium', '48px'], ['--field-height-small', '40px'],
    ],
    focus: 'outline: 4px solid #000000 !important; outline-offset: 2px !important; box-shadow: 0 0 0 2px #FFD43D !important;',
    typeScale: [14, 16, 17, 20, 24, 28, 32, 36, 48],
    spacing: [4, 8, 12, 16, 24, 32, 40, 48, 64],
    buttonHeights: [28, 36, 48, 56],
    fieldHeights: [40, 48, 56],
  },

  /* @carbon/themes (white), @carbon/type, @carbon/layout, @carbon/motion, @carbon/styles. */
  carbon: {
    fontImport:
      'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+JP:wght@400;600&family=IBM+Plex+Sans:wght@300;400;600&family=IBM+Plex+Mono&display=swap',
    fontVar: '--cds-font-family',
    vars: [
      ['--cds-background', '#FFFFFF'], ['--cds-layer-01', '#F4F4F4'], ['--cds-layer-hover-01', '#E8E8E8'],
      ['--cds-layer-selected-01', '#E0E0E0'], ['--cds-layer-accent-01', '#E0E0E0'], ['--cds-field-01', '#F4F4F4'],
      ['--cds-border-subtle-00', '#E0E0E0'], ['--cds-border-subtle-01', '#C6C6C6'],
      ['--cds-border-strong-01', '#8D8D8D'],
      ['--cds-text-primary', '#161616'], ['--cds-text-secondary', '#525252'], ['--cds-text-helper', '#6F6F6F'],
      ['--cds-text-on-color', '#FFFFFF'],
      ['--cds-link-primary', '#0F62FE'], ['--cds-link-primary-hover', '#0043CE'], ['--cds-link-visited', '#8A3FFC'],
      ['--cds-interactive', '#0F62FE'], ['--cds-focus', '#0F62FE'], ['--cds-highlight', '#D0E2FF'],
      ['--cds-support-error', '#DA1E28'], ['--cds-support-success', '#24A148'],
      ['--cds-support-warning', '#F1C21B'], ['--cds-support-info', '#0043CE'],
      ['--cds-button-primary', '#0F62FE'], ['--cds-button-primary-hover', '#0050E6'],
      ['--cds-button-primary-active', '#002D9C'], ['--cds-button-secondary', '#393939'],
      ['--cds-button-secondary-hover', '#474747'], ['--cds-button-danger-primary', '#DA1E28'],
      ['--cds-button-danger-hover', '#B81921'],
      ['--cds-notification-background-error', '#FFF1F1'], ['--cds-notification-background-success', '#DEFBE6'],
      ['--cds-notification-background-warning', '#FCF4D6'], ['--cds-notification-background-info', '#EDF5FF'],
      ['--cds-shell-header-background', '#161616'], ['--cds-shell-header-text', '#F4F4F4'],
      ['--cds-font-family', "'IBM Plex Sans JP', 'IBM Plex Sans', system-ui, -apple-system, sans-serif"],
      ['--cds-font-family-mono', "'IBM Plex Mono', Menlo, monospace"],
      ['--cds-heading-07-font-size', '54px'], ['--cds-heading-07-line-height', '1.19'],
      ['--cds-heading-06-font-size', '42px'], ['--cds-heading-06-line-height', '1.199'],
      ['--cds-heading-05-font-size', '32px'], ['--cds-heading-05-line-height', '1.25'],
      ['--cds-heading-04-font-size', '28px'], ['--cds-heading-04-line-height', '1.29'],
      ['--cds-heading-03-font-size', '20px'], ['--cds-heading-03-line-height', '1.4'],
      ['--cds-heading-02-font-size', '16px'], ['--cds-heading-02-line-height', '1.5'],
      ['--cds-heading-01-font-size', '14px'], ['--cds-heading-01-line-height', '1.43'],
      ['--cds-body-02-font-size', '16px'], ['--cds-body-02-line-height', '1.5'],
      ['--cds-body-01-font-size', '14px'], ['--cds-body-01-line-height', '1.43'],
      ['--cds-label-01-font-size', '12px'], ['--cds-label-01-line-height', '1.33'],
      ['--cds-spacing-01', '2px'], ['--cds-spacing-02', '4px'], ['--cds-spacing-03', '8px'],
      ['--cds-spacing-04', '12px'], ['--cds-spacing-05', '16px'], ['--cds-spacing-06', '24px'],
      ['--cds-spacing-07', '32px'], ['--cds-spacing-08', '40px'], ['--cds-spacing-09', '48px'],
      ['--cds-spacing-10', '64px'], ['--cds-spacing-11', '80px'], ['--cds-spacing-12', '96px'],
      ['--cds-spacing-13', '160px'],
      ['--cds-shadow', '0 2px 6px rgba(0, 0, 0, 0.3)'],
      ['--cds-duration-fast-01', '70ms'], ['--cds-duration-fast-02', '110ms'],
      ['--cds-duration-moderate-01', '150ms'], ['--cds-duration-moderate-02', '240ms'],
      ['--cds-easing-productive', 'cubic-bezier(0.2, 0, 0.38, 0.9)'],
      ['--cds-button-height-lg', '48px'], ['--cds-button-height-md', '40px'], ['--cds-button-height-sm', '32px'],
      ['--cds-field-height-lg', '48px'], ['--cds-field-height-md', '40px'],
    ],
    focus: 'outline: 2px solid #0F62FE !important; outline-offset: -2px !important;',
    typeScale: [12, 14, 16, 20, 28, 32, 42, 54],
    spacing: [2, 4, 8, 12, 16, 24, 32, 40, 48, 64, 80, 96, 160],
    buttonHeights: [32, 40, 48],
    fieldHeights: [40, 48],
  },

  /* @openameba/spindle-tokens 1.10, theme-light, @openameba/spindle-ui 3.3. */
  spindle: {
    fontVar: '--font-family-base',
    vars: [
      ['--color-surface-primary', '#FFFFFF'], ['--color-surface-secondary', '#08121A0A'],
      ['--color-surface-tertiary', '#08121A14'], ['--color-surface-accent-primary', '#298737'],
      ['--color-surface-accent-primary-light', '#E7F5E9'], ['--color-surface-accent-secondary', '#82BE28'],
      ['--color-surface-accent-secondary-light', '#F0F7E6'],
      ['--color-surface-accent-neutral-high-emphasis', '#394148'], ['--color-surface-caution', '#D91C0B'],
      ['--color-text-high-emphasis', '#08121A'], ['--color-text-medium-emphasis', '#08121ABD'],
      ['--color-text-low-emphasis', '#08121A9C'], ['--color-text-disable', '#08121A4D'],
      ['--color-text-accent-primary', '#237B31'], ['--color-text-accent-secondary', '#477D00'],
      ['--color-text-caution', '#D91C0B'], ['--color-text-high-emphasis-inverse', '#FFFFFF'],
      ['--color-border-high-emphasis', '#08121A78'], ['--color-border-medium-emphasis', '#08121A4D'],
      ['--color-border-low-emphasis', '#08121A14'], ['--color-border-accent-primary', '#298737'],
      ['--color-border-caution', '#D91C0B'],
      ['--color-object-accent-secondary', '#5E9B15'], ['--color-object-rating', '#EE7B00'],
      ['--color-object-pink', '#E6456A'], ['--color-focus-clarity', '#0091FF'],
      ['--color-button-contained-hover', '#0F5C1F'], ['--color-button-outlined-hover', '#E7F5E9'],
      ['--color-button-lighted-hover', '#C6E5C9'],
      ['--font-family-base',
        "'Helvetica Neue', Helvetica, Arial, 'Segoe UI', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', Meiryo, sans-serif"],
      ['--font-size-28', '28px'], ['--font-size-22', '22px'], ['--font-size-20', '20px'],
      ['--font-size-17', '17px'], ['--font-size-16', '16px'], ['--font-size-14', '14px'],
      ['--font-size-13', '13px'], ['--font-size-12', '12px'],
      ['--line-height-heading', '1.3'], ['--line-height-body', '1.6'], ['--line-height-reading', '1.8'],
      ['--spacing-4', '4px'], ['--spacing-6', '6px'], ['--spacing-8', '8px'], ['--spacing-12', '12px'],
      ['--spacing-14', '14px'], ['--spacing-16', '16px'], ['--spacing-20', '20px'], ['--spacing-24', '24px'],
      ['--spacing-28', '28px'], ['--spacing-36', '36px'], ['--spacing-40', '40px'], ['--spacing-44', '44px'],
      ['--spacing-48', '48px'], ['--spacing-56', '56px'], ['--spacing-64', '64px'], ['--spacing-72', '72px'],
      ['--spacing-80', '80px'], ['--spacing-96', '96px'],
      ['--radius-snackbar', '4px'], ['--radius-field', '8px'], ['--radius-menu', '12px'],
      ['--radius-dialog', '20px'], ['--radius-pill', '3em'],
      ['--shadow-lv2', '0 3.25px 7.75px 0 #08121A1F'], ['--shadow-lv4', '0 4.75px 14.25px 0 #08121A1F'],
      ['--shadow-lv6', '0 11px 28px 0 #08121A1F'],
      ['--motion-duration-fast', '150ms'], ['--motion-duration-neutral', '350ms'],
      ['--motion-easing-ease-out', 'cubic-bezier(0, 0, 0, 1)'],
      ['--motion-easing-bounce', 'cubic-bezier(0.55, 2.05, 0.65, 0.75)'],
      ['--button-height-large', '48px'], ['--button-height-medium', '40px'], ['--button-height-small', '32px'],
      ['--field-height', '48px'], ['--field-height-small', '40px'],
    ],
    focus: 'outline: 2px solid #0091FF !important; outline-offset: 1px !important;',
    typeScale: [12, 13, 14, 16, 17, 20, 22, 28],
    spacing: [4, 6, 8, 12, 14, 16, 20, 24, 28, 36, 40, 44, 48, 56, 64, 72, 80, 96],
    buttonHeights: [32, 40, 48],
    fieldHeights: [40, 48],
  },

  /* @material/web 2.5 tokens v0_192: baseline light scheme, typescale, shape, elevation, motion. */
  material3: {
    fontImport:
      'https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&family=Noto+Sans+JP:wght@400;500;700&display=swap',
    fontVar: '--md-ref-typeface-plain',
    vars: [
      ['--md-sys-color-primary', '#6750A4'], ['--md-sys-color-on-primary', '#FFFFFF'],
      ['--md-sys-color-primary-container', '#EADDFF'], ['--md-sys-color-on-primary-container', '#21005D'],
      ['--md-sys-color-secondary', '#625B71'], ['--md-sys-color-secondary-container', '#E8DEF8'],
      ['--md-sys-color-on-secondary-container', '#1D192B'],
      ['--md-sys-color-tertiary', '#7D5260'], ['--md-sys-color-tertiary-container', '#FFD8E4'],
      ['--md-sys-color-on-tertiary-container', '#31111D'],
      ['--md-sys-color-error', '#B3261E'], ['--md-sys-color-error-container', '#F9DEDC'],
      ['--md-sys-color-on-error-container', '#410E0B'],
      ['--md-sys-color-surface', '#FEF7FF'], ['--md-sys-color-surface-container-lowest', '#FFFFFF'],
      ['--md-sys-color-surface-container-low', '#F7F2FA'], ['--md-sys-color-surface-container', '#F3EDF7'],
      ['--md-sys-color-surface-container-high', '#ECE6F0'],
      ['--md-sys-color-surface-container-highest', '#E6E0E9'], ['--md-sys-color-surface-variant', '#E7E0EC'],
      ['--md-sys-color-on-surface', '#1D1B20'], ['--md-sys-color-on-surface-variant', '#49454F'],
      ['--md-sys-color-outline', '#79747E'], ['--md-sys-color-outline-variant', '#CAC4D0'],
      ['--md-sys-color-inverse-surface', '#322F35'], ['--md-sys-color-inverse-on-surface', '#F5EFF7'],
      ['--md-sys-color-inverse-primary', '#D0BCFF'], ['--md-sys-color-scrim', '#000000'],
      ['--md-sys-color-shadow', '#000000'],
      ['--md-ref-typeface-plain', "Roboto, 'Noto Sans JP', system-ui, sans-serif"],
      ['--md-sys-typescale-display-large-size', '57px'], ['--md-sys-typescale-display-large-line-height', '64px'],
      ['--md-sys-typescale-display-medium-size', '45px'], ['--md-sys-typescale-display-medium-line-height', '52px'],
      ['--md-sys-typescale-display-small-size', '36px'], ['--md-sys-typescale-display-small-line-height', '44px'],
      ['--md-sys-typescale-headline-large-size', '32px'], ['--md-sys-typescale-headline-large-line-height', '40px'],
      ['--md-sys-typescale-headline-medium-size', '28px'], ['--md-sys-typescale-headline-medium-line-height', '36px'],
      ['--md-sys-typescale-headline-small-size', '24px'], ['--md-sys-typescale-headline-small-line-height', '32px'],
      ['--md-sys-typescale-title-large-size', '22px'], ['--md-sys-typescale-title-large-line-height', '28px'],
      ['--md-sys-typescale-title-medium-size', '16px'], ['--md-sys-typescale-title-medium-line-height', '24px'],
      ['--md-sys-typescale-title-small-size', '14px'], ['--md-sys-typescale-title-small-line-height', '20px'],
      ['--md-sys-typescale-body-large-size', '16px'], ['--md-sys-typescale-body-large-line-height', '24px'],
      ['--md-sys-typescale-body-medium-size', '14px'], ['--md-sys-typescale-body-medium-line-height', '20px'],
      ['--md-sys-typescale-body-small-size', '12px'], ['--md-sys-typescale-body-small-line-height', '16px'],
      ['--md-sys-typescale-label-large-size', '14px'], ['--md-sys-typescale-label-large-line-height', '20px'],
      ['--md-sys-typescale-label-medium-size', '12px'], ['--md-sys-typescale-label-medium-line-height', '16px'],
      ['--md-sys-typescale-label-small-size', '11px'], ['--md-sys-typescale-label-small-line-height', '16px'],
      ['--md-sys-shape-corner-extra-small', '4px'], ['--md-sys-shape-corner-small', '8px'],
      ['--md-sys-shape-corner-medium', '12px'], ['--md-sys-shape-corner-large', '16px'],
      ['--md-sys-shape-corner-extra-large', '28px'], ['--md-sys-shape-corner-full', '9999px'],
      ['--md-sys-elevation-level1', '0 1px 2px rgba(0, 0, 0, 0.3), 0 1px 3px 1px rgba(0, 0, 0, 0.15)'],
      ['--md-sys-elevation-level2', '0 1px 2px rgba(0, 0, 0, 0.3), 0 2px 6px 2px rgba(0, 0, 0, 0.15)'],
      ['--md-sys-elevation-level3', '0 1px 3px rgba(0, 0, 0, 0.3), 0 4px 8px 3px rgba(0, 0, 0, 0.15)'],
      ['--md-sys-motion-easing-standard', 'cubic-bezier(0.2, 0, 0, 1)'],
      ['--md-sys-motion-duration-short4', '200ms'], ['--md-sys-motion-duration-medium2', '300ms'],
      ['--md-sys-motion-duration-medium4', '400ms'],
      ['--md-sys-state-hover-state-layer-opacity', '0.08'], ['--md-sys-state-focus-state-layer-opacity', '0.1'],
      ['--md-sys-state-pressed-state-layer-opacity', '0.1'],
      ['--md-button-height', '40px'], ['--md-text-field-height', '56px'], ['--md-fab-size', '56px'],
      ['--md-space-4', '4px'], ['--md-space-8', '8px'], ['--md-space-12', '12px'], ['--md-space-16', '16px'],
      ['--md-space-24', '24px'], ['--md-space-32', '32px'],
    ],
    focus: 'outline: 3px solid #625B71 !important; outline-offset: 2px !important;',
    typeScale: [11, 12, 14, 16, 22, 24, 28, 32, 36, 45, 57],
    spacing: [4, 8, 12, 16, 24, 32],
    buttonHeights: [40],
    fieldHeights: [56],
  },
}

export function presetFoundation(presetName: string | undefined): PresetFoundation | null {
  return presetName ? FOUNDATIONS[presetName] ?? null : null
}

/** The shadow and elevation values a system publishes, for the elevation rule to exempt. */
export function foundationShadows(presetName: string | undefined): string[] {
  const f = presetName ? FOUNDATIONS[presetName] : undefined
  return f ? f.vars.filter(([n]) => /shadow|elevation/.test(n)).map(([, v]) => v) : []
}

/** The body's font rule, which sits just outside the markers. */
function bodyRule(f: PresetFoundation): string {
  return `body { font-family: var(${f.fontVar}); }`
}

/**
 * The block itself: the import, the tokens and the focus rule between the markers,
 * and the body's font rule right after them.
 *
 * The font rule is outside on purpose. Everything between the markers is cut out
 * before a document is measured, and a build that relies on this rule for its
 * typeface — which is the build this module asks for — would otherwise be
 * reported as missing the system's font on every run, and sent to a repair.
 */
export function foundationCss(presetName: string): string {
  const f = FOUNDATIONS[presetName]
  if (!f) return ''
  return [
    `${FOUNDATION_START} ${presetName} — written by MakeUI from the system's published tokens. Reference these with var(); do not redefine them. */`,
    ...(f.fontImport ? [`@import url('${f.fontImport}');`] : []),
    ':root {',
    ...f.vars.map(([name, value]) => `  ${name}: ${value};`),
    '}',
    `:where(a, button, input, select, textarea, summary, [tabindex], [role="button"], [role="tab"], [role="link"], [role="menuitem"], [role="option"]):focus-visible { ${f.focus} }`,
    FOUNDATION_END,
    bodyRule(f),
  ].join('\n')
}

const GLOBALS = 'src/styles/globals.css'

/**
 * A stylesheet with the block at its top, and with nothing left that fights it.
 *
 * Idempotent: an existing block is taken out first, so every step that might have
 * dropped or edited it can call this again. Two more things are moved, both
 * because the cascade would otherwise undo the block:
 *
 *   A declaration of one of the block's own names inside another :root rule. It
 *   comes later in the file, so it wins — a model that "transcribed the colours"
 *   out of habit would override the published value with its own copy of it.
 *
 *   An `@import` further down. CSS ignores an import that follows any rule, and
 *   the block is a rule; a model's own font import would silently stop loading.
 */
export function withFoundationCss(css: string, presetName: string): { css: string; overridden: string[] } {
  const f = FOUNDATIONS[presetName]
  if (!f) return { css, overridden: [] }
  const names = new Set(f.vars.map(([n]) => n))
  const overridden: string[] = []
  let rest = withoutFoundation(css)
  rest = rest.replace(/(^|[}\s;])((?::root|html)(?:\s*,\s*(?::root|html))*)\s*\{([^{}]*)\}/g, (_whole, lead: string, sel: string, body: string) => {
    // An empty one left by an earlier pass is residue too.
    if (!body.trim()) return lead
    let removed = 0
    const kept = body.replace(/[ \t]*(--[\w-]+)\s*:\s*[^;{}]*;?[ \t]*(\r?\n)?/g, (decl, name: string) => {
      if (!names.has(name)) return decl
      overridden.push(name)
      removed++
      return ''
    })
    if (removed === 0) return `${lead}${sel} {${body}}`
    // A rule that held nothing but copies of the block goes entirely, rather than
    // staying behind as an empty :root with a line per declaration it used to have.
    return kept.trim() ? `${lead}${sel} {${kept}}` : lead
  })
  /*
   * The URL is matched whole. `[^;]+;` stopped at the first semicolon, and a Google
   * Fonts URL has one in every weight list (`wght@400;700`) — measured on the first
   * run with the block: the project's own import stayed below the block's rules,
   * where CSS ignores it.
   */
  const imports: string[] = []
  rest = rest.replace(/^[ \t]*@import\s+(?:url\([^)]*\)|"[^"]*"|'[^']*')[^;\n]*;[ \t]*(?:\r?\n|$)/gm, (line) => {
    imports.push(line.trim())
    return ''
  })
  rest = rest.split(bodyRule(f)).join('')
  /*
   * The project's imports go above the block, not inside it: inside, the next call
   * would cut them out with the block and they would be gone. Above the start
   * marker they are still ahead of every rule, which is all an import needs.
   */
  const head = [...imports, foundationCss(presetName)].join('\n')
  return { css: `${head}\n\n${rest.replace(/^\s+/, '')}`, overridden }
}

export interface FoundationResult {
  html: string
  applied: boolean
  /** Tokens a model declared again under the block's own names, now removed. */
  overridden: string[]
}

/**
 * The block, put into a project (or a single document) for the bound preset.
 *
 * A project gets it in src/styles/globals.css, created when the build wrote none —
 * the bundle and the exported project both load every stylesheet. A legacy
 * single document gets it as the first <style> in its head.
 */
export function applyPresetFoundation(source: string, presetName: string | undefined): FoundationResult {
  if (!presetName || !FOUNDATIONS[presetName]) return { html: source, applied: false, overridden: [] }
  if (isFencedTransport(source)) {
    const files = readProjectFiles(source)
    const path = files.has(GLOBALS)
      ? GLOBALS
      : [...files.keys()].filter((p) => p.endsWith('.css')).sort((a, b) => (files.get(b)!.length - files.get(a)!.length))[0] ?? GLOBALS
    const before = files.get(path) ?? ''
    const { css, overridden } = withFoundationCss(before, presetName)
    if (css === before) return { html: source, applied: false, overridden }
    const next = writeProjectFile(source, path, css)
    return next ? { html: next, applied: true, overridden } : { html: source, applied: false, overridden: [] }
  }
  const head = /<head[^>]*>/i.exec(source)
  if (!head) return { html: source, applied: false, overridden: [] }
  const stripped = source.replace(new RegExp(`<style data-makeui-foundation>[\\s\\S]*?</style>\\s*`, 'g'), '')
  const at = /<head[^>]*>/i.exec(stripped)!
  const end = at.index + at[0].length
  const html = `${stripped.slice(0, end)}\n<style data-makeui-foundation>\n${foundationCss(presetName)}\n</style>${stripped.slice(end)}`
  return { html, applied: html !== source, overridden: [] }
}

/**
 * For the build prompt: what is already in the stylesheet, by name.
 *
 * Names only, with their values — the model needs to know what to reference, and
 * a list is a fraction of the spec's prose while saying the same thing exactly.
 */
export function foundationPromptBlock(presetName: string): string {
  const f = FOUNDATIONS[presetName]
  if (!f) return ''
  /*
   * Names, not declarations.
   *
   * This listed `  --name: value` for every token, which is a :root block in all
   * but braces — and the foundation call wrote it out again as one: the first
   * seven generations with the block re-declared 72 to 85 tokens each (removed
   * again by withFoundationCss, but paid for as output). The values are in the
   * spec above, beside the same names; what a rule needs from here is which name
   * to write in var().
   */
  const groups = new Map<string, string[]>()
  for (const [name] of f.vars) {
    // '--md-sys-color-primary' groups under '--md-sys-color'; '--color-key-50' under '--color-key'.
    const key = name.split('-').slice(0, name.startsWith('--md-sys-') ? 5 : 4).join('-')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(name)
  }
  return `DESIGN TOKENS — ALREADY WRITTEN. MakeUI writes these custom properties at the top of
src/styles/globals.css from the system's published tokens${f.fontImport ? ', with the @import that loads its\ntypeface' : ''} and its focus-visible rule. Their values are the ones in the spec above. So:
  - Do NOT declare any of these names yourself — no :root copy of them, no font import,
    no focus-visible outline of your own. Writing them out again is wasted output.
  - Reference them with var(--name) in every rule. A hard-coded value that one of
    these names already holds is a defect.
  - body already has font-family: var(${f.fontVar}).
  - Type sizes come from this scale only: ${px(f.typeScale)}.
  - Buttons are ${px(f.buttonHeights)} tall; text fields and selects ${px(f.fieldHeights)}
    (these override any generic minimum elsewhere in this prompt).
Names available:
${[...groups.values()].map((g) => `  ${g.join(', ')}`).join('\n')}`
}

/**
 * The spec as the code-writing calls see it: the block's tokens are not written as declarations.
 *
 * Listing the tokens by name alone did not stop the copying. On the four runs of
 * 2026-09-14 after that change the foundation call still re-declared 67-80 tokens,
 * and the spec is why: it states each one as `--color-key-900: #0017C1`, a :root
 * line in all but braces, a few hundred characters above the instruction not to.
 * Rewritten as `--color-key-900 (= #0017C1)` it still says which name holds which
 * value — the component sections that say "bg #0017C1" still need that — without
 * being a declaration to transcribe. The design phase keeps the spec as written.
 */
export function withoutTokenDeclarations(spec: string, presetName: string | undefined): string {
  const f = presetName ? FOUNDATIONS[presetName] : undefined
  if (!f || !spec) return spec
  let out = spec
  for (const [name] of f.vars) {
    out = out.replace(new RegExp(`${escapeRegExp(name)}:\\s*(\\S+)`, 'g'), `${name} (= $1)`)
  }
  return out
}

/** For the visual critic: the numbers a fix may use. */
export function presetScaleNote(presetName: string | undefined): string {
  const f = presetName ? FOUNDATIONS[presetName] : undefined
  if (!f) return ''
  return `この画面はデザインシステム「${presetName}」で作られています。修正指示に書く数値は必ずこの中から選んでください（ここに無い値を提案しないこと）:
文字サイズ ${px(f.typeScale)}／余白 ${px(f.spacing)}／ボタンの高さ ${px(f.buttonHeights)}／入力欄の高さ ${px(f.fieldHeights)}`
}

/**
 * Serif and sans stacks that left the system, put back on it.
 *
 * `measureConformance` reports a stack without the system's font, and the only
 * repair it could ask for was a model rewrite of the stylesheet. There is one
 * right answer, and it is a token. Monospace and icon fonts are left alone: a
 * code block in Plex Mono or an icon font is not a stray body stack.
 */
export function snapFontFamilies(source: string, presetName: string | undefined): { html: string; changes: number } {
  const f = presetName ? FOUNDATIONS[presetName] : undefined
  if (!f || !isFencedTransport(source)) return { html: source, changes: 0 }
  const systemFont = (f.vars.find(([n]) => n === f.fontVar)?.[1] ?? '').split(',')[0].replace(/['"]/g, '').trim().toLowerCase()
  let html = source
  let changes = 0
  for (const [path, body] of readProjectFiles(source)) {
    if (!/\.(css|vue|svelte)$/.test(path)) continue
    const block = body.match(new RegExp(`${escapeRegExp(FOUNDATION_START)}[\\s\\S]*?${escapeRegExp(FOUNDATION_END)}`))?.[0] ?? ''
    const outside = block ? body.replace(block, '/*makeui:foundation:placeholder*/') : body
    let n = 0
    const moved = outside.replace(/(font-family\s*:\s*)([^;}\n]+)/gi, (whole, head: string, value: string) => {
      const v = value.toLowerCase()
      if (v.includes(systemFont) || /var\(|inherit|initial|unset|mono|courier|consolas|menlo|icon|symbols/.test(v)) return whole
      n++
      return `${head}var(${f.fontVar})`
    })
    if (n === 0) continue
    const next = writeProjectFile(html, path, block ? moved.replace('/*makeui:foundation:placeholder*/', () => block) : moved)
    if (!next) continue
    html = next
    changes += n
  }
  return { html, changes }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const BUTTONISH = /(?:^|[\s.#\-_])(?:btn|button)(?:$|[\s.:\-_[>+~])/i
const FIELDISH = /(?:^|[\s.#\-_])(?:input|select|field|text-?field|search(?:-?box|-?input)?)(?:$|[\s.:\-_[>+~])/i
const NOT_SIZED = /textarea|icon|fab|close|toggle|switch|checkbox|radio|range|slider|chip|tag|badge|avatar|group|wrap|row|label|hint|helper|error|message|list|container/i

export interface ComponentDrift {
  fontSizes: number[]
  buttonHeights: number[]
  fieldHeights: number[]
  details: string[]
}

/**
 * The part of a system the palette check never saw: sizes.
 *
 * Measured on the stylesheets only, with tokens resolved and the foundation block
 * cut out, so what is counted is what the build wrote. Reported rather than
 * rewritten: a 15px caption snapped to 14px or 16px changes a layout, and which
 * way is a design call. The findings join the preset repair the pipeline already
 * runs; they do not start one on their own.
 */
export function measureComponentDrift(source: string, presetName: string | undefined): ComponentDrift {
  const empty: ComponentDrift = { fontSizes: [], buttonHeights: [], fieldHeights: [], details: [] }
  const f = presetName ? FOUNDATIONS[presetName] : undefined
  if (!f) return empty
  const sheets = isFencedTransport(source)
    ? [...readProjectFiles(source)].flatMap(([path, body]) =>
        path.endsWith('.css') ? [body] : /\.(vue|svelte)$/.test(path) ? [...body.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]) : [])
    : [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1])
  const css = withoutFoundation(normaliseCss(sheets.join('\n')))

  const sizes = new Set<number>()
  for (const m of css.matchAll(/font-size\s*:\s*([\d.]+)px\s*(?:!important)?\s*[;}\n]/gi)) {
    const v = Math.round(parseFloat(m[1]))
    if (!f.typeScale.includes(v)) sizes.add(v)
  }
  const buttons = new Set<number>()
  const fields = new Set<number>()
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(',').map((s) => s.trim()).filter(Boolean)
    const heights = [...m[2].matchAll(/(?:^|[;\s])(?:min-)?height\s*:\s*([\d.]+)px/gi)].map((h) => Math.round(parseFloat(h[1])))
    if (heights.length === 0) continue
    const lastPart = (s: string) => s.split(/[\s>+~]+/).pop() ?? s
    const isButton = selectors.some((s) => BUTTONISH.test(lastPart(s)) && !NOT_SIZED.test(lastPart(s)))
    const isField = selectors.some((s) => FIELDISH.test(lastPart(s)) && !NOT_SIZED.test(lastPart(s)))
    for (const h of heights) {
      if (isButton && !f.buttonHeights.includes(h)) buttons.add(h)
      else if (isField && !isButton && !f.fieldHeights.includes(h)) fields.add(h)
    }
  }
  const list = (s: Set<number>) => [...s].sort((a, b) => a - b)
  const details: string[] = []
  if (sizes.size) details.push(`文字サイズがシステムの段階にありません: ${list(sizes).map((v) => `${v}px`).join(', ')}（使える値: ${px(f.typeScale)}）`)
  if (buttons.size) details.push(`ボタンの高さがシステムの値ではありません: ${list(buttons).map((v) => `${v}px`).join(', ')}（使える値: ${px(f.buttonHeights)}）`)
  if (fields.size) details.push(`入力欄の高さがシステムの値ではありません: ${list(fields).map((v) => `${v}px`).join(', ')}（使える値: ${px(f.fieldHeights)}）`)
  return { fontSizes: list(sizes), buttonHeights: list(buttons), fieldHeights: list(fields), details }
}
