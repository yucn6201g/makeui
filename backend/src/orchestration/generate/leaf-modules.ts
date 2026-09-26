import { FRAMEWORKS, type OutputKind } from '../../config/frameworks.js'

/**
 * The missing modules that can be written without asking anyone.
 *
 * `writeMissing` sends every dangling import to a model, one call per file, six
 * per round. Measured over 30 days of runtime logs: 344 unresolved specs, 100
 * modules written, 339 file repairs reverted for one that was not. So the model
 * is asked, and two times in three the answer does not arrive in a usable state
 * — and the repair that was reverted took a working screen down with it.
 *
 * Half of that population needs nobody's judgement. Of the 307 relative specs,
 * 177 name a leaf graphic: `EmptyStateIllustration` (55), `EmptyCartIcon` (16),
 * `ChevronLeftIcon`, `BackIcon`, `CheckIcon`, `ProductImagePlaceholder`. These
 * are components with no logic, no state and no data — an <svg> and its props.
 * Nothing about the specific project changes what they should contain, which is
 * exactly the condition for writing one here instead of buying one.
 *
 * What this does NOT cover, and must not pretend to: `../store/cart`,
 * `../hooks/useNavigate`, `./screens/ContactScreen`. Those carry the project's
 * own behaviour, and a stub for one is worse than the revert — the screen
 * renders and does nothing, which no check downstream calls a failure.
 */

/** Names that mean "a picture", and nothing else. */
const LEAF = /(icon|illustration|logo|wordmark|graphic|placeholder|artwork|image)$/i

/**
 * The name says what to draw.
 *
 * A stub with the wrong glyph is still a defect — a back arrow that renders as a
 * grey square is a screen the user cannot leave. The names in the corpus are
 * uniformly descriptive (`ChevronLeftIcon`, `TrashIcon`, `SearchIcon`), so most
 * of them say precisely what they are, and the ones that do not fall through to
 * a neutral mark rather than to a guess.
 *
 * Order matters: `ChevronLeftIcon` must not be read as `left` before `chevron`,
 * and `CheckCircleIcon` is a check, not a circle.
 */
const GLYPHS: [RegExp, string][] = [
  [/chevron.?down|caret.?down|arrow.?down(?!load)/i, 'M6 9l6 6 6-6'],
  [/chevron.?up|caret.?up|arrow.?up/i, 'M6 15l6-6 6 6'],
  [/chevron.?right|caret.?right|forward|next/i, 'M9 6l6 6-6 6'],
  [/chevron|caret|back|arrow.?left|previous|prev/i, 'M15 6l-6 6 6 6'],
  [/check.?circle|success|complete|done|verified/i, 'M4 12a8 8 0 1 0 16 0 8 8 0 1 0-16 0M8 12l3 3 5-6'],
  [/check|tick|selected/i, 'M4 12l5 5L20 6'],
  [/close|dismiss|cancel|remove|^x(icon)?$/i, 'M6 6l12 12M18 6L6 18'],
  [/plus|add|new|create/i, 'M12 5v14M5 12h14'],
  [/minus|subtract/i, 'M5 12h14'],
  [/search|find|magnif/i, 'M4 11a7 7 0 1 0 14 0 7 7 0 1 0-14 0M20 20l-4.2-4.2'],
  [/cart|basket|bag|checkout/i, 'M6 7h12l-1.2 12H7.2zM9 7a3 3 0 0 1 6 0'],
  [/calendar|schedule|date|event/i, 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4'],
  [/home|house|dashboard/i, 'M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z'],
  [/user|person|profile|account|avatar|member/i, 'M8.5 8a3.5 3.5 0 1 0 7 0 3.5 3.5 0 1 0-7 0M5 20a7 7 0 0 1 14 0'],
  [/trash|delete|bin/i, 'M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13'],
  [/download|export/i, 'M12 4v10M8 11l4 4 4-4M5 20h14'],
  [/upload|import/i, 'M12 20V10M8 13l4-4 4 4M5 4h14'],
  [/file|document|contract|clipboard|note|form|invoice|receipt/i, 'M7 3h7l4 4v14H7zM14 3v4h4'],
  [/alert|warning|error|required|attention/i, 'M12 4l9 16H3zM12 10v4M12 17h.01'],
  [/info|help|question/i, 'M4 12a8 8 0 1 0 16 0 8 8 0 1 0-16 0M12 11v5M12 8h.01'],
  [/pending|clock|time|history|recent/i, 'M4 12a8 8 0 1 0 16 0 8 8 0 1 0-16 0M12 7v5l3 2'],
  [/chart|graph|stat(?!e)|analytic|budget|report/i, 'M5 19V9M10 19V5M15 19v-7M20 19v-3'],
  [/image|photo|picture|gallery|product/i, 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4'],
  [/package|box|inventory|shipping|delivery|order/i, 'M12 3l8 4v10l-8 4-8-4V7zM4 7l8 4 8-4M12 11v10'],
  [/menu|list|hamburger/i, 'M4 7h16M4 12h16M4 17h16'],
  [/heart|favorite|like|wish/i, 'M12 20S4 14.5 4 9.5A4 4 0 0 1 12 8a4 4 0 0 1 8 1.5C20 14.5 12 20 12 20z'],
  [/star|rating|bookmark/i, 'M12 4l2.4 5 5.6.7-4 3.9 1 5.4-5-2.7-5 2.7 1-5.4-4-3.9 5.6-.7z'],
  [/lock|secure|private/i, 'M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3'],
  [/mail|email|message|contact/i, 'M4 6h16v12H4zM4 7l8 6 8-6'],
  [/setting|gear|config/i, 'M8.5 12a3.5 3.5 0 1 0 7 0 3.5 3.5 0 1 0-7 0M12 3v3M12 18v3M3 12h3M18 12h3'],
]

/** A mark that says "something belongs here" without claiming to be anything. */
const NEUTRAL_ICON = 'M5 5h14v14H5z'

/**
 * The larger drawings, for the names that fill a space rather than a text line.
 *
 * More than half the illustration population is literally `EmptyStateIllustration`
 * (55 of 177). An empty state has no correct drawing — a neutral frame is not a
 * placeholder for it, it IS it — so this is the one case where a written stub is
 * not second best.
 */
const SCENES: [RegExp, string][] = [
  [/cart|basket|bag/i, 'M46 44h68l-7 52H53zM66 44a14 14 0 0 1 28 0'],
  [/search|find/i, 'M52 52a24 24 0 1 0 48 0 24 24 0 1 0-48 0M104 88l16 16'],
  [/calendar|schedule|event/i, 'M36 34h88v56H36zM36 50h88M58 24v16M102 24v16'],
  [/document|file|contract|list|note|order|invoice/i, 'M52 24h40l20 20v60H52zM92 24v20h20M64 60h36M64 74h24'],
  [/chart|graph|stat(?!e)|analytic|budget/i, 'M36 96h88M50 96V64M72 96V40M94 96V72M116 96V54'],
  [/image|photo|picture|product|gallery/i, 'M32 30h96v64H32zM32 78l26-24 20 20 14-14 26 26'],
]
const NEUTRAL_SCENE = 'M32 30h96v64H32zM32 78h96M78 66l14-14 22 26'

const glyphFor = (name: string) => GLYPHS.find(([re]) => re.test(name))?.[1] ?? NEUTRAL_ICON
const sceneFor = (name: string) => SCENES.find(([re]) => re.test(name))?.[1] ?? NEUTRAL_SCENE

/** An illustration fills a space; an icon sits in a line of text. */
const isScene = (name: string) => /illustration|artwork|graphic|placeholder|wordmark/i.test(name)

const baseName = (path: string) => path.split('/').pop()!.replace(/\.[A-Za-z]+$/, '')

/**
 * How the file that wants this module expects to import it.
 *
 * `import Chevron from './ChevronIcon.js'` and `import { ChevronIcon } from …` need
 * different files, and getting it wrong writes a module whose import still fails
 * — the same revert, one round later. Read from the importer rather than assumed,
 * because both forms are in the corpus.
 */
export function importShape(
  importerBody: string,
  spec: string
): { def: string | null; named: string[] } | null {
  const q = spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = importerBody.match(new RegExp(`import\\s+([^;\\n]*?)\\s+from\\s+['"]${q}['"]`))
  if (!m) return null
  const clause = m[1].trim()
  const braces = clause.match(/\{([^}]*)\}/)
  const named = braces
    ? braces[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean)
    : []
  const bare = clause.replace(/\{[^}]*\}/, '').replace(/[,\s]+/g, ' ').trim()
  return { def: /^[A-Za-z_$][\w$]*$/.test(bare) ? bare : null, named }
}

/**
 * The module body, or null when this is not a leaf graphic.
 *
 * Null is the important half. Anything with behaviour in it goes to the model as
 * before; the point of this is to stop spending a call on an <svg>, not to stop
 * spending calls.
 */
export function leafModule(
  path: string,
  kind: OutputKind,
  importerBody: string,
  spec: string
): string | null {
  const name = baseName(path)
  if (!LEAF.test(name)) return null
  // A leaf graphic is a component. `src/utils/imageIcon.ts` is not one, and the
  // framework decides which extension that sentence means.
  if (!path.endsWith(FRAMEWORKS[kind].componentExt)) return null

  const scene = isScene(name)
  const d = scene ? sceneFor(name) : glyphFor(name)
  const box = scene ? '0 0 160 120' : '0 0 24 24'
  const w = scene ? 160 : 24
  const stroke = scene ? '3' : '2'
  // The ratio is baked in rather than passed, so a caller that sets only `size`
  // gets a drawing at its own proportions instead of a squashed one.
  const height = scene ? `typeof size === 'number' ? size * 0.75 : size` : 'size'
  const why =
    `${name} は import されているだけで、どのファイルにも書かれていませんでした。`
    + '画面が起動するように中立的な図形を置いています。差し替えて構いません。'

  if (kind === 'vue') {
    return [
      '<script setup lang="ts">',
      `// ${why}`,
      'withDefaults(defineProps<{ size?: number | string; color?: string }>(), {',
      `  size: ${w},`,
      "  color: 'currentColor',",
      '});',
      '</script>',
      '',
      '<template>',
      `  <svg :width="size" :height="${height}" viewBox="${box}"`,
      `    fill="none" :stroke="color" stroke-width="${stroke}" stroke-linecap="round"`,
      '    stroke-linejoin="round" aria-hidden="true">',
      `    <path d="${d}" />`,
      '  </svg>',
      '</template>',
      '',
    ].join('\n')
  }

  const shape = importShape(importerBody, spec)
  const lines = [
    '/**',
    ` * ${why}`,
    ' */',
    'type Props = {',
    '  size?: number | string;',
    '  color?: string;',
    '  className?: string;',
    '  [key: string]: any;',
    '};',
    '',
    `export function ${name}({ size = ${w}, color = 'currentColor', className, ...rest }: Props) {`,
    '  return (',
    `    <svg width={size} height={${height}} viewBox="${box}"`,
    `      fill="none" stroke={color} strokeWidth="${stroke}" strokeLinecap="round" strokeLinejoin="round"`,
    '      className={className} aria-hidden="true" {...rest}>',
    `      <path d="${d}" />`,
    '    </svg>',
    '  );',
    '}',
    '',
  ]
  /*
   * Every name the importer asked for, aliased to the one component.
   *
   * A file that imports `{ EmptyCartIcon, EmptyBagIcon }` from one module needs
   * both to exist, and drawing them differently would invent a difference the
   * importer never stated.
   *
   * The default export is written every time, including when the importer asked
   * only for named ones. An unused default costs nothing; a missing one is the
   * same revert one round later, and the importer is not the only file that will
   * reach for this module once it exists.
   */
  for (const n of shape?.named ?? []) if (n !== name) lines.push(`export const ${n} = ${name};`)
  lines.push(`export default ${name};`)
  lines.push('')
  return lines.join('\n')
}
