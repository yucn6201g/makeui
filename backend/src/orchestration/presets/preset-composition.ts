import type { LayoutFact } from '../../tools/browser/browser-verify.js'
import type { InteractionDefect } from '../audit/interaction-audit.js'

/**
 * Whether a screen was BUILT the way its design system builds screens.
 *
 * Conformance checks values — colours, radii, type — and the token block now
 * writes those. What neither can see is the shell: every preset's spec has a
 * COMPOSITION section, and a page carrying the right hex values in a layout the
 * system would never use has recoloured a generic template. That was the most
 * common way presets came out looking alike, and nothing measured it.
 *
 * Measured on the eight preset runs of 2026-09-14 (the layout facts the walk now
 * records, checked against screenshots of each):
 *
 *   carbon    both runs: 48px header at luminance 0.09, 256px side nav    conforms
 *   digital-agency  both runs: header, no side nav, NO breadcrumb row      breadcrumb missing
 *   material3 first run: 80px rail and a FAB                               conforms
 *             second run: tabs across the top, no rail, no bottom bar      navigation missing
 *   spindle   both runs: bottom navigation                                 conforms
 *
 * Only what each spec states as the shell is required, and only what the walk can
 * measure without judgement. The FAB is not required of Material 3, because the
 * spec asks for one only where there is a primary create action; a data table is
 * not required of Carbon, because not every Carbon screen is a list.
 */

interface Expectation {
  /**
   * Unmet expectations, as sentences for the instruction. Empty when the shell conforms.
   * `screens` is how many screens the walk measured, when known.
   */
  check: (l: LayoutFact, screens?: number) => string[]
}

const EXPECTATIONS: Record<string, Expectation> = {
  carbon: {
    check: (l) => {
      const h = l.header
      if (h && h.height >= 44 && h.height <= 56 && h.luminance !== null && h.luminance <= 0.2) return []
      return [
        'UI シェルは高さ 48px の暗いヘッダー（背景 #161616、左に製品名、右にグローバル操作）です。' +
          (h ? `現在のヘッダーは高さ ${h.height}px・明るさ ${h.luminance ?? '透明'} です。` : '現在、画面上端にヘッダーがありません。'),
      ]
    },
  },
  'digital-agency': {
    check: (l, screens) => {
      const out: string[] = []
      /*
       * Only when there is somewhere below the top level to be. The system puts a
       * breadcrumb on pages under the top one; an app whose every screen is a
       * destination in the header has no such page. Measured on the agency run of
       * 2026-09-14: two screens, both in the header nav, and no breadcrumb — which
       * is the system followed, and was reported as a departure from it.
       */
      if (!l.breadcrumb && (screens === undefined || l.navItems === undefined || screens > l.navItems)) {
        out.push('ヘッダーの下にパンくずリスト（nav aria-label="パンくずリスト"、現在地は aria-current="page"）の行を置き、その下にページ見出しを置きます。現在、どの画面にもパンくずがありません。')
      }
      if (l.sideNavWidth > 0) {
        out.push(`常設のサイドバーは使いません（1ページ1タスク、上から入る構成）。現在、左に幅 ${l.sideNavWidth}px のナビがあります。ナビはヘッダーに置いてください。`)
      }
      return out
    },
  },
  material3: {
    check: (l) => {
      const rail = l.sideNavWidth >= 72 && l.sideNavWidth <= 104
      const drawer = l.sideNavWidth >= 240
      if (rail || drawer || l.bottomNav) return []
      return [
        '広い画面では左端に幅 80px のナビゲーションレール（アイコンの上に 64×32px の丸いインジケーター、下にラベル）を置きます。' +
          '狭い画面では画面下のナビゲーションバー（高さ 80px）にします。' +
          (l.topNav ? '現在は画面上部のタブ／横並びナビになっています。' : l.sideNavWidth > 0 ? `現在の左ナビは幅 ${l.sideNavWidth}px です。` : '現在、主要なナビゲーションが見当たりません。'),
      ]
    },
  },
  spindle: {
    check: (l) => {
      if (l.bottomNav || l.topNav) return []
      return [
        '主要画面は、モバイルでは画面下のボトムナビゲーション（4〜5項目）、デスクトップではヘッダー内の横並びナビにします。' +
          (l.sideNavWidth > 0 ? `現在は左に幅 ${l.sideNavWidth}px のサイドナビがあります。` : '現在、どちらもありません。'),
      ]
    },
  },
}

/**
 * The shell, as an instruction to the call that writes it.
 *
 * The check above is reported and not repaired (see REPORT_ONLY in
 * repair-yield.ts): rebuilding the navigation of a working app broke it three
 * times in six on the run that measured it. The shell is written once, by the
 * foundation call, before any screen exists — so that is where it is asked for,
 * in the same terms the walk measures, so a build that follows it passes.
 */
const SHELL: Record<string, string> = {
  carbon:
    'The app shell is a 48px-tall dark header (background #161616, product name left, global actions right) fixed across the top. ' +
    'Multi-section products add a 256px side nav on #FFFFFF, docked left, full height below the header.',
  'digital-agency':
    'The app shell is a full-width light header (service name left, utility links right, 1px bottom border), then a breadcrumb row ' +
    '(<nav aria-label="パンくずリスト"> with the current page marked aria-current="page") on every screen below the top one, then content in a centred column. ' +
    'There is NO persistent side navigation: primary navigation lives in the header.',
  material3:
    'On wide windows the primary navigation is a navigation rail: 80px wide, docked left, full height, each destination an icon above a label with a 64x32px pill indicator ' +
    'in #E8DEF8 on the active one. Below 600px it becomes a bottom navigation bar, 80px tall. NOT tabs across the top — tabs are for sections within a screen. ' +
    'A top app bar (64px) holds the screen title.',
  spindle:
    'Primary screens use a bottom navigation bar across the foot of the viewport with 4-5 destinations (icon above label) on mobile; ' +
    'on desktop the same destinations become a horizontal nav inside the top bar. No left side navigation.',
}

export function shellRequirement(presetName: string | undefined): string {
  const s = presetName ? SHELL[presetName] : undefined
  return s ? `SHELL — required by the design system, and measured on the rendered app:\n${s}` : ''
}

export function hasCompositionCheck(presetName: string | undefined): boolean {
  return Boolean(presetName && EXPECTATIONS[presetName])
}

/** The shell's departures from the bound system, as one finding the repair can act on. */
export function auditComposition(layout: LayoutFact | undefined, presetName: string | undefined, screens?: number): InteractionDefect[] {
  if (!layout || !presetName) return []
  const expectation = EXPECTATIONS[presetName]
  if (!expectation) return []
  const unmet = expectation.check(layout, screens)
  if (unmet.length === 0) return []
  return [
    {
      id: 'preset-composition',
      note: 'デザインシステムの画面構成（シェル）になっていません。',
      instruction:
        `この画面はデザインシステム「${presetName}」で作られていますが、画面の組み立て方がシステムのものになっていません。` +
        '色や角丸は合っていても、シェルが違うと別のシステムに見えます。次を直してください（画面の中身・文言・データは変えないこと）:\n' +
        unmet.map((u, i) => `${i + 1}. ${u}`).join('\n'),
    },
  ]
}
