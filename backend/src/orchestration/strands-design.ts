import { Agent, Graph, tool } from '@strands-agents/sdk'
import { BedrockModel } from '@strands-agents/sdk/models/bedrock'
import { z } from 'zod'
import { searchDesignSystem, searchSharedBestPractices } from '../tools/knowledge-base-tool.js'
import { retrieveUserPreferences } from '../tools/memory-tool.js'
import { logger } from '../utils/logger.js'
import { imageDirective, isEmbeddable, type ImageInput } from '../utils/image-input.js'
import { stockImageBrief } from '../tools/stock-images.js'
import type { DesignSpecialist } from './workflow-router.js'
import { recordTokens, recordUnreportedCall, usageFromStrandsResult } from '../services/token-ledger.js'
import { FRAMEWORKS, type OutputKind } from '../config/frameworks.js';
import { readProjectFiles } from '../tools/project-transport.js';
import { detectKind } from '../tools/framework-compile.js';

/**
 * Design phase built on the Strands multi-agent primitives.
 *
 * The previous implementation was a single model call that had to hold layout,
 * visual language and content decisions at once, which is where generic output
 * comes from. Here four specialists work the brief in a fixed sequence (Graph),
 * each able to pull real reference material out of the KnowledgeBase and the
 * user's design memory (Agents-as-Tools).
 *
 * The code-assembler stays on the raw Bedrock path deliberately: it streams its
 * output into the job record so the chat can show the response being written,
 * and that streaming contract is not expressible through the Agent façade here.
 */

/**
 * A full four-screen specification lands around 45k characters, and a Swarm
 * variant of this phase failed outright at 8000 with "Model reached maximum
 * token limit". Kept generous so no specialist is truncated mid-section.
 */
const DESIGN_MAX_TOKENS = 32000

/**
 * Agents-as-Tools: the design specialists can look up implementation recipes
 * instead of inventing them. The preset is bound here rather than left to the
 * model to pass correctly.
 *
 * The user was bound here too, for the per-user corpus lookup below. Nothing
 * can write to that corpus now, so nothing distinguishes one caller from
 * another and the parameter went with the query.
 */
function makeDesignTools(presetName: string) {
  const lookupDesignSystem = tool({
    name: 'lookup_design_system',
    description:
      'Retrieve concrete component and layout recipes for the design system in use. ' +
      'Call this before deciding component structure, spacing or states.',
    inputSchema: z.object({
      query: z.string().describe('What you need, e.g. "data table with status badges"'),
    }),
    callback: async ({ query }) => {
      /*
       * The preset corpus, and no longer a per-user one beside it.
       *
       * A user's own uploads used to be retrieved first and labelled as
       * overriding these. Nothing can put a document in that corpus any more —
       * the upload endpoint went with the panel that called it — so the branch
       * ranked, labelled and merged a list that is empty for every user, at the
       * cost of a second vector query on every lookup the design phase makes.
       */
      const preset = await searchDesignSystem(query, { preset: presetName, maxResults: 4 })
      if (preset.length === 0) return 'No reference found. Rely on the binding spec.'
      return ('Preset reference:\n' + preset.map((h) => h.content).join('\n\n---\n\n')).slice(0, 8000)
    },
  })

  const lookupPatterns = tool({
    name: 'lookup_interaction_patterns',
    description:
      'Retrieve shared interaction and accessibility patterns (routing, state-driven ' +
      'rendering, modals, form validation, ARIA). Call this when planning behaviour.',
    inputSchema: z.object({
      query: z.string().describe('The behaviour you are planning, e.g. "add to cart"'),
    }),
    callback: async ({ query }) => {
      const hits = await searchSharedBestPractices(query, 3)
      if (hits.length === 0) return 'No shared pattern found.'
      return hits.map((h) => h.content).join('\n\n---\n\n').slice(0, 6000)
    },
  })

  return [lookupDesignSystem, lookupPatterns]
}

/**
 * The heading each specialist's work is filed under in the assembled spec.
 *
 * The chain used to end with "emit the complete specification, carrying every
 * earlier specialist's decisions through verbatim", and the build then read the
 * concatenation of every node's text. Both halves of that were wrong, and
 * together they threw most of the design away:
 *
 *   - The last node had to re-transcribe four predecessors from memory. A
 *     specification is not a thing a model reproduces losslessly, so the more
 *     the earlier specialists wrote, the more of it quietly did not survive.
 *   - The concatenation put that final restatement LAST, and the build truncated
 *     its input. A measured run produced 68,308 characters and the assembler read
 *     20,000 — so what reached the build was the intermediate working notes, and
 *     what was cut was the finished specification itself.
 *
 * Now each specialist writes only its own section and code assembles them. No
 * model re-transcribes another's work, and nothing depends on a node being last.
 */
const SECTION_TITLE: Record<DesignSpecialist, string> = {
  'layout-architect': 'SCREENS AND INFORMATION ARCHITECTURE',
  'interaction-designer': 'INTERACTION INVENTORY',
  'style-expert': 'VISUAL LANGUAGE AND COMPOSITION',
  'content-strategist': 'CONTENT',
  'design-critic': 'CORRECTIONS',
}

/**
 * Told to every specialist. The point is that nobody restates anybody else:
 * every section reaches the build intact, so repeating a predecessor buys
 * nothing and costs the fidelity of the copy.
 */
const SECTION_CONTRACT = `
YOUR OUTPUT IS ONE SECTION OF A LARGER SPECIFICATION.
Write your section and nothing else. Do NOT restate, summarise or reproduce what
an earlier specialist decided — every section is delivered to the build intact
alongside yours, so a restatement is only a second, worse copy. Refer to their
decisions by name (a screen id, a control, a token) and build on them.
Be specific and complete within your own remit: what you leave out, nobody else
supplies.`

export interface DesignPhaseInput {
  prompt: string
  userId: string
  presetName: string
  presetSpec: string
  outputKind: OutputKind
  modelId: string
  /**
   * The user's reference image, already parsed. Null when none was attached.
   *
   * This was `imageProvided: boolean`, and the boolean was all the specialists ever
   * received: the system prompt said an image had been supplied while the brief that
   * reached the model was text only. Passing the parsed image instead makes the claim
   * and the content the same fact.
   */
  image?: ImageInput | null
  /** What the user said `image` shows, when they said it. Empty otherwise. */
  imageCaption?: string
  /**
   * The block describing pictures the user supplied for the UI itself, already
   * rendered by `contentImageDirective`.
   *
   * Text rather than the images, and that is the whole design: the specialists
   * decide WHERE a picture goes, which a caption answers, and looking at five
   * photographs across five specialists costs more than the run they belong to.
   * Empty string when there are none, so the prompt stays byte-identical for
   * every request that supplies no images.
   */
  contentImages?: string
  /**
   * Photographs available to this build, so screens are composed around them.
   *
   * The design phase used not to know these existed — they were chosen after it
   * finished and handed only to the assembler, which could do nothing better
   * than fit a picture into a layout drawn without one.
   */
  stockImages?: { description: string; width: number; height: number; aspect: number }[]
  /**
   * The user's own data, sampled — see utils/data-attachment.ts.
   *
   * The design phase needs it more than the build does. The build fills a screen
   * with records; the design phase decides WHICH screen, and a list of six rows
   * and a list of four thousand are different designs. Handed only to the build,
   * the six-row screen comes back full of real values, which looks right and is
   * the wrong screen.
   */
  dataContext?: string
  /**
   * The checkable requirements the user stated, rendered by
   * `designRequirementsBlock`. Empty when there are none, so the brief stays
   * byte-identical for a request with nothing to check.
   */
  requirements?: string
  /** Which specialists to run, in order. Chosen by the workflow router. */
  specialists: DesignSpecialist[]
  /** Receives the design phase text as it is written, so the chat shows it live. */
  onDelta?: (fullText: string) => void
  /** Announces which specialist currently holds the brief. */
  onAgent?: (agentId: string, phase: 'started' | 'completed') => void
  /**
   * The specialist whose text `onDelta` now carries changed without one starting
   * — the shown one finished while others were still writing. The caller should
   * relabel the step. See `focusedStream`.
   */
  onFocus?: (agentId: string) => void
}

/** Chat-facing names; the agent ids are internal. */
const AGENT_LABELS: Record<string, string> = {
  'layout-architect': '画面構成を設計中',
  'interaction-designer': '操作の挙動を設計中',
  'style-expert': 'ビジュアル設計中',
  'content-strategist': 'コンテンツを作成中',
  'design-critic': '設計をレビュー中',
}

export function agentLabel(id: string): string {
  return AGENT_LABELS[id] ?? id
}

/**
 * A model that stopped writing and started repeating, cut back to where it did.
 *
 * Measured 2026-09-18 on a Vue storefront: `layout-architect` wrote its screens
 * and then emitted 「 ← 」 several thousand times until it hit the model's token
 * ceiling, at which point the SDK failed the node — 「Model reached maximum token
 * limit. This is an unrecoverable state that requires intervention.」 The user
 * saw a progress transcript of nothing but arrows, and the 34,349 characters
 * that reached the build carried hundreds of them.
 *
 * A repetition is not content and must not be treated as either. It is spotted
 * on the TAIL, because that is where a degenerate loop lives: everything before
 * it is the specialist's real work and is kept.
 *
 * Two steps, because this runs on every delta. The cheap test is how many
 * distinct characters the last 200 hold — prose in any language holds dozens, a
 * loop holds two or three — and only when that fires does the precise one run.
 */
const RUNAWAY_UNIT = 12
const RUNAWAY_REPEATS = 30
const RUNAWAY_WINDOW = 4000
/**
 * How long a run has to be before it is a loop rather than decoration.
 *
 * A rule under a heading, a markdown table divider and a dotted leader are all
 * one short unit repeated, and all of them fit on a line. A model that has
 * stopped writing does not stop at a line: the measured one ran to the token
 * ceiling. Two hundred characters is past every legitimate case in the corpus
 * and far short of the failure.
 */
const RUNAWAY_MIN_CHARS = 200

/** Whether the tail looks like a loop rather than like writing. */
function tailIsMonotonous(text: string): boolean {
  const tail = text.slice(-400).replace(/\s+/g, '').slice(-100)
  return tail.length >= 40 && new Set(tail).size <= 3
}

/** `text` with a trailing run of one short repeated unit removed. */
export function withoutRunaway(text: string): { text: string; cut: number } {
  if (!tailIsMonotonous(text)) return { text, cut: 0 }
  const tail = text.slice(-RUNAWAY_WINDOW).replace(/\s+$/, '')
  const m = new RegExp(`(.{1,${RUNAWAY_UNIT}}?)\\1{${RUNAWAY_REPEATS - 1},}$`, 's').exec(tail)
  if (!m) return { text, cut: 0 }
  const at = text.length - text.slice(-RUNAWAY_WINDOW).length + m.index
  const kept = text.slice(0, at).replace(/\s+$/, '')
  const cut = text.length - kept.length
  return cut >= RUNAWAY_MIN_CHARS ? { text: kept, cut } : { text, cut: 0 }
}

/**
 * The live stream of a graph whose specialists run at the same time, as one
 * specialist's text at a time.
 *
 * The transcript shows one running step under one label. The graph's deltas used
 * to be appended to a single string in arrival order, and once layout, visual
 * language and content ran in parallel that string was their tokens interleaved:
 * 「severity: 15 + 12 = 39px → 44px に統一 ### カラーコントラスト検 'warning',」
 * under 「コンテンツを作成中」, read back from a saved transcript. Reported as the
 * progress text being garbled.
 *
 * So only the FOCUSED node's own text is forwarded — the one that started most
 * recently, which is also the one whose label the caller put up. When it finishes
 * while others are still writing, focus moves to the latest of those and
 * `onFocus` says so, so the label changes with the text rather than after it.
 */
export function focusedStream(
  byNode: Map<string, string>,
  onDelta?: (fullText: string) => void,
  onFocus?: (agentId: string) => void
) {
  const running: string[] = []
  let focus: string | null = null
  return {
    started(id: string) {
      if (!running.includes(id)) running.push(id)
      focus = id
    },
    delta(id: string, text: string) {
      byNode.set(id, (byNode.get(id) ?? '') + text)
      if (focus === null) {
        focus = id
        onFocus?.(id)
      }
      // A loop is not progress: the transcript keeps the last thing the
      // specialist actually wrote rather than filling with its repetition.
      if (id === focus) onDelta?.(withoutRunaway(byNode.get(id)!).text)
    },
    completed(id: string) {
      const at = running.indexOf(id)
      if (at !== -1) running.splice(at, 1)
      if (id !== focus) return
      focus = running[running.length - 1] ?? null
      if (focus === null) return
      onFocus?.(focus)
      const text = byNode.get(focus)
      if (text) onDelta?.(text)
    },
  }
}

/**
 * Runs the specialist graph and returns the design specification the
 * code-assembler consumes. Throws so the caller can fall back to the
 * single-call path rather than failing the whole generation.
 */
/** A line as a repeat would be recognised: no list markers, no punctuation, no case. */
function normalisedLines(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of text.split('\n')) {
    const line = raw
      .replace(/^[\s>*#\-・\d.)]+/, '')
      .replace(/[\s`*_「」『』（）()、。,.:：;；|]/g, '')
      .toLowerCase()
    // Short lines are headings and labels that legitimately recur everywhere.
    if (line.length >= 12) out.add(line)
  }
  return out
}

/**
 * The share of each fan-out specialist's lines that restate another's.
 *
 * Exported for the test; logged once per design phase.
 */
export function specOverlap(byNode: Map<string, string>): {
  fromArchitect: Record<string, number>
  pairwise: Record<string, number>
} {
  const lines = new Map([...byNode].map(([id, body]) => [id, normalisedLines(body)]))
  const architect = lines.get('layout-architect') ?? new Set<string>()
  const round = (x: number) => Math.round(x * 1000) / 1000
  const fromArchitect: Record<string, number> = {}
  const others = [...lines.keys()].filter((id) => id !== 'layout-architect')
  for (const id of others) {
    const own = lines.get(id)!
    if (own.size === 0) continue
    fromArchitect[id] = round([...own].filter((l) => architect.has(l)).length / own.size)
  }
  const pairwise: Record<string, number> = {}
  for (let i = 0; i < others.length; i++) {
    for (let j = i + 1; j < others.length; j++) {
      const a = lines.get(others[i])!, b = lines.get(others[j])!
      const union = new Set([...a, ...b]).size
      if (union === 0) continue
      pairwise[`${others[i]}|${others[j]}`] = round([...a].filter((l) => b.has(l)).length / union)
    }
  }
  return { fromArchitect, pairwise }
}

function logSpecOverlap(byNode: Map<string, string>): void {
  if (byNode.size < 2) return
  logger.info('Design spec overlap', specOverlap(byNode))
}

export async function runDesignSwarm(input: DesignPhaseInput): Promise<string> {
  const { prompt, userId, presetName, presetSpec, outputKind, modelId, image, imageCaption, contentImages, stockImages, dataContext, requirements, specialists, onDelta, onAgent, onFocus } = input

  /**
   * `auto` puts a cache point after the tool definitions and after the last user
   * message — not after the system prompt, which the SDK leaves alone.
   *
   * That is the half of the caching that costs nothing to take here. Each
   * specialist is told to call `lookup_design_system` and
   * `lookup_interaction_patterns` before deciding, so a specialist is a
   * multi-turn conversation: the tool definitions and everything said before the
   * last tool result are re-sent on every turn of it, and those bytes are
   * identical by construction.
   *
   * The system prompt is the larger prize and is NOT taken, because the shared
   * contract sits after the role sentence — 「You are a product architect. …」 —
   * so it is not a prefix, and Bedrock matches from the first byte. Reordering
   * the four specialists' prompts to put the contract first is a change to the
   * prompts of the phase the output quality comes from; it belongs to a measured
   * change of its own, not to a billing one.
   */
  const model = new BedrockModel({
    modelId,
    maxTokens: DESIGN_MAX_TOKENS,
    temperature: 0.4,
    region: process.env.AWS_REGION || 'ap-northeast-1',
    cacheConfig: { strategy: 'auto' },
  })

  const tools = makeDesignTools(presetName)

  // Same test the build applies, so the specification never promises a picture
  // the substitution step will not be able to put on the page.
  const canEmbedImage = isEmbeddable(image ?? null)

  /**
   * Memory speaks only when nothing else is dictating the visuals.
   *
   * Every field a record holds — palette, type, radius, elevation — is a value a
   * binding design system already fixes, so under a preset memory can only repeat
   * the preset or contradict it, and it contradicted it: retrieval ranks by
   * prompt similarity alone, so for one user the three closest hits to a prompt
   * were a `digital-agency` run, a preset-less run and a `product` run — three
   * different systems' palettes, handed over together as "this user's preferences"
   * directly beneath a design system declared absolute.
   *
   * Blank-line separated: each record is itself multi-line, so joining with a
   * single newline ran `Quality: 99` straight into the next record's `Product:`
   * and the whole thing read as one contradictory design.
   */
  const memory = presetSpec
    ? ''
    : await retrieveUserPreferences(userId, prompt, { preset: presetName })
        .then((p: any[]) => p.map((x) => x.content).join('\n\n').slice(0, 1200))
        .catch(() => '')

  const systemShared = `
${presetSpec
    ? `BINDING DESIGN SYSTEM — every value below is absolute:\n${presetSpec}`
    : `No preset is imposed. Commit to ONE accent drawn from the product's domain and a single
neutral ramp. Never default to indigo/violet (#6366f1, #8b5cf6) — that palette is the
clearest tell of machine-generated work.`}
${memory
      ? `\nWhat this user chose on earlier preset-free work. This is context, not an
instruction — a record of what they did before, with nothing in it that binds this
design. Where it fits this product, following it makes their work feel consistent;
where it does not, the product's own domain wins and you ignore it outright.
${memory}`
      : ''}
${imageDirective(image ?? null, canEmbedImage, imageCaption ?? '')}${contentImages ?? ''}
${stockImageBrief(stockImages ?? [])}

Target output: a multi-screen ${FRAMEWORKS[outputKind].label} application.
The result must be a working mock: 3-5 screens, real navigation, and actions that
change state (add to cart, create a record, filter a list) — not a static picture.
Use lookup_design_system and lookup_interaction_patterns before you decide; do not
invent conventions the design system already defines.

LANGUAGE: write your reasoning and every piece of prose in Japanese. It is streamed
to the user as the run progresses, so English narration reads as someone else's
working notes. Structural identifiers stay English — screen ids, CSS property
names, hex values — but everything a person reads is Japanese.
${SECTION_CONTRACT}`

  const layoutArchitect = new Agent({
    id: 'layout-architect',
    name: 'layout-architect',
    systemPrompt: `You are a product architect. ${systemShared}

Your job: decide the SCREENS and the INFORMATION ARCHITECTURE.
Name each screen, what it is for, what it shows, and how the user moves between
them (including list -> detail with an id). Decide what state the app holds and
which actions mutate it. Name the screen shown when no route is set.
Say which screens the top navigation lists: only those that make sense with
nothing selected and nothing done yet. A detail, a checkout, a confirmation or a
完了 screen is reached from the action that makes it meaningful, not from the menu.

${presetSpec
      ? `The design system above has a COMPOSITION section describing how screens are
built in it — the shell, and the shape of a list, a detail and a form. That is a
contract, not a suggestion, and it is YOUR section: it decides the layout you are
choosing right now. Follow it, and say for each screen which archetype it uses.
A design system applied only as colours and radii to a layout you picked yourself
is the failure this section exists to prevent.`
      : `Choose a shell and a screen shape the product's domain actually calls for —
an operations console and a storefront are not the same page with different colours.
Say which shape each screen takes and why the domain wants it.`}

Your output is passed to the interaction designer, then the visual designer, then
the content designer. Be complete: what you leave out, they cannot recover.`,
    model,
    tools,
    printer: false,
  })

  // Added because "make the buttons work" as prose was not enough: the code
  // assembler needs an explicit, itemised contract to build against, and an
  // auditor needs one to check against.
  const interactionDesigner = new Agent({
    id: 'interaction-designer',
    name: 'interaction-designer',
    systemPrompt: `You are an interaction designer. ${systemShared}

Your job: produce the INTERACTION INVENTORY — the contract the build is held to.
Walk each screen from layout-architect and enumerate EVERY control it carries:
nav items, buttons, tabs, filters, sort controls, search inputs, table rows, cards,
icon buttons, form fields, modal triggers and their close controls.

For each control write one line: where it lives, what the user does, and exactly
what changes as a result — which state key is written and which screens re-render.
Include the reverse paths too: back navigation, cancelling a form, closing a modal,
clearing a filter, and the empty state each list shows when nothing matches.

Rules you are enforcing:
- No control may be decorative. If it cannot be given real behaviour, cut it.
- Confirmation is a modal in the UI, never window.confirm.
- An unrecognised or empty route falls back to the first screen.
- A screen that needs something first (a selection, a cart with items, a placed
  order) is not a nav item. The control that leads there is disabled while that
  is false, and the screen, opened without it, shows one line of explanation and
  a link back — never an empty form, never a blank page.
Call lookup_interaction_patterns before deciding how a pattern should behave.
Your output is passed to the visual designer and then the content designer.`,
    model,
    tools,
    printer: false,
  })

  /**
   * Two different jobs behind one id, because a bound design system changes what
   * visual design *is* on this brief.
   *
   * Without a system, the token decisions are the work. With one, the tokens are
   * already settled — and the router used to drop this specialist entirely on that
   * basis ("デザインシステム既存のため視覚設計は不要"). That was a quality regression:
   * a preset says which blue, never which element is biggest, how dense the page
   * is, or where the eye goes first. Those decisions are the whole difference
   * between on-system and designed, so the role is redefined rather than removed.
   */
  const styleExpert = new Agent({
    id: 'style-expert',
    name: 'style-expert',
    systemPrompt: `You are a visual designer. ${systemShared}

${presetSpec
      ? `The palette, type scale, radii and elevation are ALREADY DECIDED by the bound
design system above. Do not re-choose them and do not restate the token list.

Your job is COMPOSITION — the decisions the system does not make:
- For each screen, name the ONE element that dominates, and say what makes it
  dominate (size, weight, position, isolation). A screen where everything is the
  same weight reads as a spreadsheet.
- Assign a step from the system's type scale to every text role on every screen.
  Say which pairs of steps sit next to each other, so the contrast is deliberate.
- Set the density: row height, cell padding, gap between sections, page margin.
  Pick from the system's spacing scale and state the actual values.
- Decide where the single accent appears on each screen — it is one job per screen,
  the primary action. Name what it is on each, and confirm nothing else uses it.
- Decide what separates regions: hairline, whitespace, or a surface shift. Prefer
  in that order, and hold one answer across the app.
- Say which of the system's elevation levels each floating thing uses, and confirm
  nothing that does not float has one.
- Decide the layout rhythm across the set of screens: which are wide and open,
  which are dense and tabular. Identical composition on every screen is the tell.`
      : `Your job: decide the VISUAL LANGUAGE — palette (exact hex), type scale, spacing
rhythm, radius, elevation and motion, AND the composition that deploys them.

- Hierarchy comes from size, weight and spacing, not from boxes and colour. For
  each screen name the one element that dominates and why.
- ONE accent, drawn from the product's domain, on the primary action only.
  Indigo-violet defaults (#6366f1, #8b5cf6, #7c3aed) are banned — they are the
  clearest tell of machine-generated work.
- One neutral ramp, consistently warm or cool. Never mix ramps.
- A real type scale with tight tracking on display sizes and a 60-75ch measure.
  Assign a step to every text role, and say which steps sit adjacent.
- Restraint: hairline borders before shadows, shadows barely visible, motion
  120-180ms on opacity and transform only.
- Density suited to the domain: a console is dense, a marketing page is not.
  State the actual row heights, paddings and gaps.
- Vary the rhythm across screens; identical composition everywhere is the tell.
Name specific values so they can be applied verbatim.`}

Also specify the IMAGERY, since there is no image source and every graphic is
hand-drawn SVG: which screens carry artwork, what each piece depicts, and at what
size. Empty states get a line drawing of the missing thing; content slots get a
geometric composition from the palette, different per item; data gets a real chart
driven by real numbers. Never a grey rectangle.`,
    model,
    tools,
    printer: false,
  })

  const contentStrategist = new Agent({
    id: 'content-strategist',
    name: 'content-strategist',
    systemPrompt: `You are a content designer. ${systemShared}

Your job: write the REAL CONTENT — screen titles, labels, table rows with
plausible records, empty states, validation messages, button text. Japanese unless
the brief is in another language. No lorem, no "Feature One", no marketing filler.

Write it per screen, using the screen ids layout-architect named, so the build can
place every string without guessing. Every list gets enough rows to look real —
a table with two rows reads as a placeholder. Give the empty state of each list
its own copy, and every validation rule the interaction inventory names its own
message.`,
    model,
    tools,
    printer: false,
  })

  /**
   * Reviews the assembled specification before it costs a code generation.
   *
   * Every other specialist adds; none subtracts or checks. A thin or contradictory
   * spec therefore travelled straight into the build, where it became a thin page
   * — and by then the only remedy is a repair pass over a finished document, which
   * is both more expensive and more destructive than fixing the spec.
   *
   * It rewrites rather than comments, because a list of complaints appended to a
   * specification is something the code assembler has to reconcile, and it will
   * reconcile it by ignoring one side.
   */
  const designCritic = new Agent({
    id: 'design-critic',
    name: 'design-critic',
    systemPrompt: `You are a design director reviewing a specification before it is built.

You correct by EDITING IN PLACE, never by commenting. A list of complaints
appended to a specification is something the build has to reconcile, and it
reconciles it by ignoring one side.

Two forms, and nothing else:

### FIX: <SECTION NAME>
<<<FIND
（直したい箇所を、仕様から一字一句そのまま引用する）
<<<REPLACE
（直したあとの文）
<<<END

### ADD: <SECTION NAME>
（そのセクションの末尾に足す内容。抜けている画面・戻り経路・空状態はこの形で足す）
<<<END

Valid section names: ${Object.values(SECTION_TITLE).filter((x) => x !== 'CORRECTIONS').join(' / ')}
If everything passes, reply with exactly: NO CORRECTIONS

WHY THIS FORM: you were previously asked to re-emit whole corrected sections,
and measured across real runs you shortened them instead — one replacement came
back at 1,019 characters for a 10,327 character section, and three of four were
rejected for losing most of their content. Writing only the part that changes
removes that failure entirely: what you do not quote cannot be lost.

FIND must be copied EXACTLY from the specification, including punctuation. If it
does not match character-for-character the fix is dropped, so quote a short and
distinctive span rather than a long approximate one. Most real corrections are
ADD — something missing — rather than FIX.

Check against this rubric and fix what fails:
1. COMPLETENESS — every screen the brief implies exists, and every screen has its
   own content. Any screen described only as a name is a stub; write it out.
2. DEAD CONTROLS — every control in the inventory names the state it writes and
   what re-renders. Any control without one is either given behaviour or removed.
3. REVERSE PATHS — back, cancel, close, clear, and the empty state of anything
   that can be empty. These are the ones most often missing.
4. HIERARCHY — each screen names its dominant element. A screen where everything
   is equal weight is unfinished; decide what leads.
5. CONTRADICTIONS — two specialists disagreeing about a value, a screen id, or a
   control's behaviour. Resolve it, and prefer the more specific answer.
6. GENERIC CONTENT — copy that could belong to any product ("ようこそ", "詳細を見る",
   "Item 1"), placeholder rows, or data that is not plausible for this domain.
   Replace it with content this specific product would really carry.
7. IMAGERY — every empty state, content slot and data view names the SVG artwork
   that fills it. A grey placeholder is a defect; specify a drawing instead.
8. AUTHENTICATION — if there is a login, the demo credentials are specified and
   shown on the screen. A reviewer with no account must be able to get in.
9. REQUIREMENTS — when the brief lists requirements the user stated, every one is
   in the specification: each string verbatim and in the place named, each key on
   a named control, each screen under the user's name for it. A missing one is
   ADDed; a string written differently is FIXed to the exact string.

Do not add screens or features the brief did not ask for. Do not restyle anything
the design system fixed. Your job is to make the specification buildable and
specific, not larger.`,
    model,
    tools,
    printer: false,
  })

  /**
   * A Graph, not a Swarm — and composed per request.
   *
   * With a Swarm, whether a specialist runs is the previous agent's decision,
   * and it showed: two consecutive runs of the same brief produced a 46,244-char
   * specification (all four ran) and a 1,718-char one (the chain stopped after
   * two). Design depth should not vary because a model felt finished.
   *
   * A Graph fixes the order in the topology instead, and the caller decides
   * which specialists are in it. That keeps the run deterministic while letting a
   * login form cost less than a six-screen inventory app — a fixed chain could
   * only ever be right for one of them.
   */
  const byId: Record<DesignSpecialist, Agent> = {
    'layout-architect': layoutArchitect,
    'interaction-designer': interactionDesigner,
    'style-expert': styleExpert,
    'content-strategist': contentStrategist,
    'design-critic': designCritic,
  }
  const requested: DesignSpecialist[] = specialists.filter((s) => byId[s])
  if (requested.length === 0) requested.push('layout-architect')

  /**
   * The critic runs after the graph, not inside it, and this is a correctness
   * requirement rather than a tidiness one.
   *
   * Its whole job is to quote a span of the specification and replace it. What it
   * can quote is whatever the graph handed it as a node input; what the edit is
   * applied to is `sections`, assembled here out of `structuredOutput.message`
   * or the node's content blocks, trimmed. Those are two different strings, and
   * nothing keeps them equal — so a quote that the model copied perfectly can
   * still fail to match. Measured across eight runs: 37 of 47 quoted fixes were
   * dropped as no-match, and the failures came in whole sections at a time, which
   * is the signature of a text mismatch rather than of a careless quote. One run
   * landed eight fixes in a row in a single section, so the model can copy
   * exactly when what it copies from is what gets searched.
   *
   * Running it here means it is shown the assembled text verbatim. It also stops
   * the critic being the node the graph's wall-clock budget cuts off, which was
   * the other way this stage silently produced nothing.
   */
  const wantsCritic = requested.includes('design-critic')
  const chain: DesignSpecialist[] = requested.filter((s) => s !== 'design-critic')
  if (chain.length === 0) chain.push('layout-architect')

  /**
   * The specialists after the first run at the same time, not one after another.
   *
   * They were a strict chain, and measured that cost 225 to 341 seconds of a run
   * the user is waiting through — four specialists at roughly two minutes each,
   * added up. But only the first dependency is real. Every specialist needs the
   * screen list: you cannot write the interactions, the visual language or the
   * copy for screens nobody has named yet. None of them needs each other. The
   * interaction inventory does not change the type scale, and the type scale does
   * not change the words.
   *
   * So the layout architect is the source and the rest hang off it. Wall clock
   * becomes layout plus the slowest of the others rather than the sum of all
   * four — around four minutes instead of eight, on the same work.
   *
   * What this gives up is real and worth naming: in a chain each specialist saw
   * everything written before it, and now they see only the screens. The critic
   * is what covers that seam, and it reads the assembled result — which is
   * exactly the arrangement it needs to quote from anyway.
   */
  const edges: [string, string][] = chain.slice(1).map((id) => [chain[0], id])

  const graph = new Graph({
    id: 'design-graph',
    nodes: chain.map((id) => byId[id]),
    edges,
    sources: [chain[0]],
    /**
     * Sized to the chain rather than fixed.
     *
     * A flat ten minutes was marginal by construction: five specialists at the
     * two minutes each they actually take is exactly ten minutes, so whether the
     * chain finished came down to variance. Measured on the same shape of brief,
     * one run took 296s and two took the full 600s and were cut off — and what
     * gets cut is always the tail, which is the content designer and the critic.
     * Losing precisely those two is the failure this phase was rebuilt to stop.
     *
     * Three minutes a specialist gives the same headroom whatever the router
     * picked. The overrun is survivable now (the finished sections are used), so
     * this is about not truncating the chain in the ordinary case rather than
     * about avoiding a catastrophe.
     *
     * Kept sized to the specialist COUNT even though they now run in parallel.
     * The budget is not a schedule — it is the point at which a stuck run is
     * abandoned — and buying back minutes here would only trade the saved wall
     * clock for a tighter deadline on the same work.
     */
    timeout: Math.max(10 * 60_000, chain.length * 3 * 60_000),
    nodeTimeout: 4 * 60_000,
    /**
     * Carried into AgentCore Observability's traces. Without these, a slow run
     * shows only that "the design phase" took four minutes; with them it shows
     * which specialist, on which preset, for which composition — which is the
     * difference between a trace you can act on and one you can only read.
     */
    traceAttributes: {
      'makeui.preset': presetName,
      'makeui.output_kind': outputKind,
      'makeui.specialists': chain.join(','),
      'makeui.specialist_count': chain.length,
    },
  })
  // The critic is listed separately because it is no longer a node — reading
  // `specialists` as the whole design phase would now under-report it.
  logger.info('Design graph composed', { specialists: chain, critic: wantsCritic, preset: presetName })
  const started = Date.now()

  // Streamed rather than invoked: the design phase can run for minutes, and
  // without this the chat sat silent for the whole of it. Each node's text is
  // forwarded as it arrives so the user sees the specialists thinking.
  const briefText = `Design this product: "${prompt}"${dataContext ?? ''}${requirements ?? ''}\n\nWork through structure, then visual language, then content.`
  // A Graph accepts the same content blocks an Agent does, so the reference image
  // travels with the brief to the first specialist and through the shared context
  // that follows it. Plain string when there is none — identical to before.
  const brief = image
    ? [
        { image: { format: image.format, source: { bytes: Buffer.from(image.base64, 'base64') } } },
        { text: briefText },
      ]
    : briefText
  let result: Awaited<ReturnType<typeof graph.invoke>> | null = null

  /**
   * Each node's own text, captured as it streams.
   *
   * The graph has a wall-clock budget, and when it runs out the SDK throws —
   * taking everything the completed specialists produced with it. Measured on
   * two real user runs: the graph spent its full ten minutes, threw, and the
   * pipeline started over on the single-call fallback. Ten minutes of finished
   * layout, interaction and visual work was discarded because the last
   * specialist had not returned.
   *
   * A partial specification from three real specialists beats a whole one from
   * a single call, so the deltas are filed per node on the way past and the
   * assembly can proceed from whatever arrived.
   */
  const streamedByNode = new Map<string, string>()
  /** Usage already recorded per node from the stream's metadata events. */
  const streamedUsage = new Map<string, { input: number; output: number; read: number; write: number }>()
  const live = focusedStream(streamedByNode, onDelta, onFocus)
  let timedOut = false

  if (onDelta || onAgent) {
    const iterator = graph.stream(brief)
    try {
      let step = await iterator.next()
      while (!step.done) {
        const ev: any = step.value
        if (ev?.type === 'beforeNodeCallEvent') {
          live.started(ev.nodeId)
          onAgent?.(ev.nodeId, 'started')
        } else if (ev?.type === 'afterNodeCallEvent') {
          // The specialist's spend is already in the ledger: it is recorded from
          // the stream's metadata events as each call ends (below).
          onAgent?.(ev.nodeId, 'completed')
          live.completed(ev.nodeId)
        } else if (ev?.type === 'nodeStreamUpdateEvent' && ev.inner?.source === 'agent') {
          const inner = ev.inner.event
          if (inner?.type === 'modelStreamUpdateEvent' && inner.event?.type === 'modelContentBlockDeltaEvent') {
            const delta = inner.event.delta
            if (delta?.type === 'textDelta' && typeof delta.text === 'string') {
              /**
               * Filed under the node the event names, not under whichever node
               * started most recently.
               *
               * The chain made those the same thing, so a mutable "current node"
               * was correct by accident. Three specialists running at once makes
               * it wrong in the worst way: the deltas still all arrive, so
               * nothing looks broken, and the visual language ends up filed as
               * content because the content strategist happened to start last.
               */
              if (ev.nodeId) live.delta(ev.nodeId, delta.text)
            }
          } else if (inner?.type === 'modelStreamUpdateEvent' && inner.event?.type === 'modelMetadataEvent' && inner.event.usage && ev.nodeId) {
            /*
             * Each model call's usage, as it ends — see the reconciliation
             * after the graph returns, which records only what this missed.
             */
            const u = inner.event.usage
            const id = String(ev.nodeId)
            const was = streamedUsage.get(id) ?? { input: 0, output: 0, read: 0, write: 0 }
            const now = {
              input: was.input + (u.inputTokens ?? 0),
              output: was.output + (u.outputTokens ?? 0),
              read: was.read + (u.cacheReadInputTokens ?? 0),
              write: was.write + (u.cacheWriteInputTokens ?? 0),
            }
            streamedUsage.set(id, now)
            recordTokens(u.inputTokens ?? 0, u.outputTokens ?? 0, `design:${id}`, {
              read: u.cacheReadInputTokens ?? 0,
              write: u.cacheWriteInputTokens ?? 0,
            })
          }
        }
        step = await iterator.next()
      }
      result = step.value
    } catch (e) {
      // Only a budget overrun is survivable this way — anything else means the
      // graph never really ran, and there is nothing captured to fall back on.
      if (!/wall-clock|timeout/i.test(String(e)) || streamedByNode.size === 0) throw e
      timedOut = true
      logger.warn('Design graph exceeded its budget — assembling from the specialists that finished', {
        preset: presetName,
        finished: [...streamedByNode.keys()].join(','),
        chars: [...streamedByNode.values()].reduce((n, t) => n + t.length, 0),
      })
    }
  } else {
    result = await graph.invoke(brief)
  }

  /**
   * Where the work lands.
   *
   * A Graph node answers normally, so its substance is in `NodeResult.content` —
   * unlike a Swarm, where routing goes through structured output and `content`
   * holds only a preamble. Both are read, in that order, so this survives either
   * primitive: every node's contribution is kept, not just the last one's
   * restatement of it.
   */
  const textOf = (blocks: readonly any[] | undefined): string =>
    (blocks ?? [])
      .map((b) => (typeof b?.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim()

  /**
   * What the graph actually spent.
   *
   * This function returns a string, so until now the result object — the only
   * place the six specialists' usage is reported — was read for its text and
   * dropped. The design phase is the single most expensive stage in the
   * pipeline and it was costing the ledger nothing, which is why turning it off
   * in 節約 mode appeared to save nothing.
   *
   * Reported even when the graph timed out: the specialists that finished were
   * paid for, and their work is being used.
   */
  const graphUsage = usageFromStrandsResult(result)

  /*
   * Per specialist, when the SDK says so.
   *
   * The design graph is the single largest stage — 34% of a run, measured — and
   * until now it was one number, so "which specialist costs that" had no
   * answer. Two routes were tried before and both failed on measurement:
   * `AfterNodeCallEvent.result` does not exist, and `AfterNodeCallEvent.state.
   * usage` reads 0 through every node. The third is the one that works, and it
   * was in the SDK's own types all along: each `NodeResult` carries its own
   * `usage`.
   *
   * The residual matters as much as the split. Recording per node and stopping
   * there would silently drop whatever the nodes do not account for — the
   * critic's retries, the orchestrator's own calls — and a stage total that
   * quietly shrinks is worse than one that is merely coarse. So the nodes are
   * recorded under their own names and the difference against the aggregate is
   * filed under `design:graph (residual)`, where it can be seen and explained.
   */
  const nodeUsages = (result?.results ?? [])
    .map((r: any) => ({ id: String(r.nodeId ?? 'unknown'), usage: r.usage }))
    .filter((n: any) => n.usage && typeof n.usage.inputTokens === 'number')

  /*
   * Recorded as it was spent where the stream said so, reconciled here.
   *
   * Each model call's usage arrives in the stream as it ends and was recorded
   * then (above), so the progress transcript can price each specialist's step.
   * What is left for this point is only what the stream did not carry: per node,
   * the node's own figure less what was already recorded for it; overall, the
   * graph's figure less both. The totals are the ones the SDK reports, as before
   * — the stream moves WHEN they land, not how much.
   */
  const streamedIn = [...streamedUsage.values()].reduce((n, u) => n + u.input, 0)
  const streamedOut = [...streamedUsage.values()].reduce((n, u) => n + u.output, 0)
  if (nodeUsages.length > 0) {
    let attributedIn = 0
    let attributedOut = 0
    const seen = new Set<string>()
    for (const { id, usage } of nodeUsages) {
      const s = streamedUsage.get(id) ?? { input: 0, output: 0, read: 0, write: 0 }
      seen.add(id)
      attributedIn += Math.max(usage.inputTokens, s.input)
      attributedOut += Math.max(usage.outputTokens ?? 0, s.output)
      const restIn = Math.max(0, usage.inputTokens - s.input)
      const restOut = Math.max(0, (usage.outputTokens ?? 0) - s.output)
      if (restIn > 0 || restOut > 0) {
        recordTokens(restIn, restOut, `design:${id}`, {
          read: Math.max(0, (usage.cacheReadInputTokens ?? 0) - s.read),
          write: Math.max(0, (usage.cacheWriteInputTokens ?? 0) - s.write),
        })
      }
    }
    // A node the stream charged and the result does not list (it failed) is
    // still spent, and already recorded.
    for (const [id, s] of streamedUsage) {
      if (seen.has(id)) continue
      attributedIn += s.input
      attributedOut += s.output
    }
    const restIn = Math.max(0, (graphUsage?.inputTokens ?? 0) - attributedIn)
    const restOut = Math.max(0, (graphUsage?.outputTokens ?? 0) - attributedOut)
    if (restIn > 0 || restOut > 0) recordTokens(restIn, restOut, 'design:graph (residual)')
  }

  /*
   * What each specialist wrote, in characters.
   *
   * Belt and braces for the line above: `NodeResult.usage` is optional in the
   * SDK's types, and the two earlier routes into per-node usage both read zero.
   * Character counts need nothing from the SDK beyond the content that is
   * already being assembled, so if the usage figures come back empty this still
   * says which specialist is writing the bulk of the output.
   */
  if (result?.results?.length) {
    logger.info('Design graph nodes', {
      preset: presetName,
      nodes: (result.results as any[]).map((r) => ({
        id: r.nodeId,
        ms: Math.round(r.duration ?? 0),
        chars: textOf(r.content).length,
        in: r.usage?.inputTokens ?? null,
        out: r.usage?.outputTokens ?? null,
      })),
    })
  } else if (graphUsage) {
    const restIn = Math.max(0, graphUsage.inputTokens - streamedIn)
    const restOut = Math.max(0, graphUsage.outputTokens - streamedOut)
    if (restIn > 0 || restOut > 0) recordTokens(restIn, restOut, 'design:graph')
  } else if (streamedUsage.size === 0) {
    recordUnreportedCall('design-graph')
  }

  /*
   * Why the stream, and not the node events.
   *
   * The progress transcript prices each step by differencing the run's total at
   * step boundaries, so a specialist's spend has to reach the ledger while its
   * step is current. The SDK's result reports usage only when the whole graph
   * returns, and two routes into per-node usage during the run failed on
   * measurement: `AfterNodeCallEvent.result` does not exist, and
   * `AfterNodeCallEvent.state.usage` read 0 through every node (0 / 0 / 0 across
   * the design steps, then 95,887 landing on the code step).
   *
   * The model's own stream does carry it: Bedrock ends every call with a
   * metadata event holding that call's usage, and it arrives inside the node's
   * stream update, named with the node. That is recorded as it comes, and the
   * figures above only settle what it missed.
   */


  // Each node's own contribution, filed under its id. `results` is in completion
  // order, which for this topology is chain order, but keying by nodeId means the
  // assembly does not depend on that.
  const byNode = new Map<string, string>()
  for (const r of result?.results ?? []) {
    const structured = (r.structuredOutput as { message?: string } | undefined)?.message
    const body = (structured || textOf(r.content)).trim()
    if (body) byNode.set(r.nodeId, body)
  }
  // On a budget overrun there is no result to read, so the streamed capture is
  // the only record of what the specialists wrote. It also backfills any node
  // the result object happened not to carry.
  for (const [id, text] of streamedByNode) {
    if (byNode.has(id)) continue
    /*
     * The streamed text is what a FAILED node leaves behind, and a node that
     * failed on the token ceiling failed because it was repeating itself. Kept
     * only for what it wrote before that.
     */
    const { text: usable, cut } = withoutRunaway(text.trim())
    if (cut > 0) {
      logger.warn('A specialist repeated itself until it ran out of tokens', {
        node: id, kept: usable.length, cut,
      })
    }
    if (usable.length > 100) byNode.set(id, usable)
  }

  /**
   * A specialist that produced nothing is asked again, once, on its own.
   *
   * The graph's other three nodes hang off the layout architect, so when a node
   * fails the run does not lose one section — it loses every section downstream
   * of it, and the assembly below simply omits them. Nothing said so: `partial`
   * reported the wall-clock budget and nothing else, so an incomplete
   * specification was logged, built from, and reported to the user as a finished
   * design phase.
   *
   * Measured over 60 days, 353 design phases: 313 produced all four sections and
   * 39 did not — 11%. Eighteen of those 39 carried the architect's section
   * ALONE. The failures are the ordinary ones a shared account meets — 「Too many
   * requests」, 「Too many tokens per day」 — plus the token ceiling a repeating
   * model hits, and all of them are per-node rather than per-run. The build then
   * has no INTERACTION INVENTORY, which is the section that says what every
   * control does, and the result is the complaint this pipeline exists to
   * prevent: a mock whose buttons do nothing.
   *
   * Asking again is cheap and specific. These agents are ordinary Agents — the
   * critic is already invoked directly a few lines below for its own reasons —
   * and what the graph would have handed a downstream node is the source node's
   * output, which is in hand. One attempt each, in parallel, and only for what
   * is missing: a run where everything succeeded does not reach this at all.
   *
   * The pause is for the commonest cause. A throttle clears in seconds; a daily
   * quota does not, and that attempt is lost rather than retried further.
   */
  const source = chain[0]
  const sourceText = (byNode.get(source) ?? '').trim()
  const absent = chain.filter((id) => id !== source && !(byNode.get(id) ?? '').trim())
  if (absent.length > 0 && sourceText.length > 200) {
    logger.warn('Specialists produced nothing; asking them directly', {
      missing: absent.join(','),
      from: source,
      sourceChars: sourceText.length,
    })
    await new Promise((resolve) => setTimeout(resolve, 5_000))
    await Promise.all(
      absent.map(async (id) => {
        onAgent?.(id, 'started')
        onFocus?.(id)
        const retryStarted = Date.now()
        try {
          const solo = await byId[id].invoke(
            `${briefText}\n\n══ ${SECTION_TITLE[source]} ══\n${sourceText}`
          )
          const usage = usageFromStrandsResult(solo)
          if (usage) recordTokens(usage.inputTokens, usage.outputTokens, `design:${id}`)
          else recordUnreportedCall(`design:${id}`)
          const { text: body } = withoutRunaway(textOf(solo.lastMessage?.content).trim())
          if (body.length > 100) {
            byNode.set(id, body)
            logger.info('A specialist recovered on its own', { node: id, chars: body.length, durationMs: Date.now() - retryStarted })
          } else {
            logger.warn('A specialist asked again still produced nothing', { node: id, chars: body.length })
          }
        } catch (e) {
          recordUnreportedCall(`design:${id}`)
          logger.warn('A specialist asked again failed', { node: id, error: String(e), durationMs: Date.now() - retryStarted })
        }
        onAgent?.(id, 'completed')
      })
    )
  }

  /*
   * How much the specialists repeat each other.
   *
   * The spec is the most expensive prose in a run — a median 49,336 characters,
   * written as output and then read again by the build — and three of the four
   * specialists are fanned out from the same layout-architect text, so each may
   * restate its screen list and component names. Whether a terser spec format is
   * worth trying depends on how much of that is repetition, and nothing measured
   * it. Logged here from the texts already in hand, at no model cost.
   *
   * Exact normalised lines, so this is a FLOOR on redundancy: a paraphrased
   * screen list does not count. If even the floor is large the case is made; if
   * it is small, it says repetition is not where the characters go.
   */
  logSpecOverlap(byNode)

  const sections = new Map<string, string>()
  for (const id of chain) {
    if (id === 'design-critic') continue
    const body = byNode.get(id)
    if (body) sections.set(SECTION_TITLE[id], body)
  }

  /**
   * The critic sees exactly the text its edits will be applied to.
   *
   * Assembled from `sections` — the same map `applyCriticEdits` searches — so a
   * FIND copied from what it was shown is a FIND that matches. The section
   * banners are the only thing added, and they are outside every body, so no
   * quote can straddle one.
   */
  let criticText = ''
  if (wantsCritic && sections.size > 0) {
    onAgent?.('design-critic', 'started')
    const criticStarted = Date.now()
    try {
      const brief = [
        `Design brief: "${prompt}"${requirements ?? ''}`,
        '',
        'This is the assembled specification, exactly as the build will receive it.',
        'Anything you put in a FIND must be copied from between these banners,',
        'character for character.',
        '',
        ...[...sections.entries()].map(([title, body]) => `══ ${title} ══\n${body}`),
      ].join('\n')
      const criticResult = await byId['design-critic'].invoke(brief)
      criticText = textOf(criticResult.lastMessage?.content).trim()
      /*
       * The critic is billed like every other call, because it is one.
       *
       * It runs OUTSIDE the graph — after `usageFromStrandsResult(result)` has
       * already been taken above — so it appeared in neither the per-node split,
       * nor the residual, nor `unreported`. The ledger therefore reported full
       * coverage of a run it had not seen all of, and since `recordUsage` bills
       * from the ledger, its tokens were charged to nobody: absent from the
       * user's month, from the group's, and from the admin panel.
       *
       * The input is the whole assembled specification — the largest text the
       * run produces — so this is not a rounding error. This is the same defect
       * the ledger's own header describes for the four specialists, still open
       * for the fifth: a stage that costs money and reports none is exactly the
       * stage a cost control cannot see.
       */
      const criticUsage = usageFromStrandsResult(criticResult)
      if (criticUsage) {
        recordTokens(criticUsage.inputTokens, criticUsage.outputTokens, 'design:design-critic')
      } else {
        recordUnreportedCall('design-critic')
      }
    } catch (e) {
      // A review is an improvement, never a gate: the specification the
      // specialists produced is already usable.
      //
      // Counted as unreported rather than ignored: a call that threw may still
      // have spent its input, and the total is meant to be a floor with a known
      // gap rather than a sum that quietly omits one.
      recordUnreportedCall('design-critic')
      logger.warn('Design critic failed; keeping the specification as assembled', {
        error: String(e),
        durationMs: Date.now() - criticStarted,
      })
    }
    onAgent?.('design-critic', 'completed')
  }

  const corrections = applyCriticEdits(sections, criticText)

  let text = [...sections.entries()]
    .map(([title, body]) => `══ ${title} ══\n${body}`)
    .join('\n\n')
    .trim()

  // Nothing filed: fall back to the aggregate rather than failing a run that did
  // produce work in a shape this did not anticipate.
  if (text.length < 200) text = textOf(result?.content)

  if (text.length < 200) {
    throw new Error(
      `design graph produced no usable specification (status=${result?.status ?? 'timeout'}, nodes=${result?.results?.length ?? 0}, chars=${text.length})`
    )
  }

  /*
   * Partial means the specification is short of a section, not merely that the
   * clock ran out. Reporting only the timeout is what let 39 runs in 60 days
   * record `partial: false` while carrying one section of four.
   */
  const stillMissing = chain.filter((id) => !sections.has(SECTION_TITLE[id]))
  logger.info('Design graph completed', {
    durationMs: Date.now() - started,
    specChars: text.length,
    preset: presetName,
    sections: [...sections.keys()].join(','),
    corrections: corrections.join(',') || 'none',
    nodes: result?.results?.map((r) => `${r.nodeId}:${r.status}`).join(',') ?? 'partial',
    partial: timedOut || stillMissing.length > 0,
    missing: stillMissing.join(',') || 'none',
  })
  return text
}

/**
 * Locates a quoted span, tolerating whitespace but nothing else.
 *
 * An exact match is tried first. Failing that, the quote is retried with every
 * run of whitespace allowed to match any run of whitespace — a model that
 * reflows a line while copying it has still identified the right span, whereas
 * one that paraphrases has not, and only the first is forgiven here.
 */
function findQuote(
  body: string,
  needle: string
): { kind: 'one' | 'no-match' | 'ambiguous'; at: number; length: number; loose: boolean } {
  const exact = body.indexOf(needle)
  if (exact >= 0) {
    return body.indexOf(needle, exact + 1) >= 0
      ? { kind: 'ambiguous', at: -1, length: 0, loose: false }
      : { kind: 'one', at: exact, length: needle.length, loose: false }
  }
  const pattern = needle
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+')
  if (!pattern) return { kind: 'no-match', at: -1, length: 0, loose: false }
  const re = new RegExp(pattern, 'g')
  const hits = [...body.matchAll(re)]
  if (hits.length === 0) return { kind: 'no-match', at: -1, length: 0, loose: false }
  if (hits.length > 1) return { kind: 'ambiguous', at: -1, length: 0, loose: false }
  return { kind: 'one', at: hits[0].index!, length: hits[0][0].length, loose: true }
}

/**
 * Applies the design critic's edits to the assembled sections, in place.
 *
 * It used to re-emit whole corrected sections, and measured across real runs
 * it shortened them instead: one replacement came back at 1,019 characters for
 * a 10,327 character section, and three of four were rejected by the length
 * guard. The guard was right, but a pass whose output is discarded three times
 * out of four is a pass that is not working.
 *
 * Editing in place removes the failure rather than catching it — what the
 * critic does not quote cannot be lost, so there is no length to defend. The
 * old whole-section REPLACE is still honoured, with its guard, in case the
 * model reaches for the shape it was previously taught.
 */
export function applyCriticEdits(sections: Map<string, string>, criticText: string): string[] {
  const corrections: string[] = []
  /**
   * These are different facts and the log used to show both as "none": a critic
   * that read the specification and judged it sound, versus one that returned
   * nothing at all. The first is a pass; the second is a specialist whose whole
   * turn was wasted, and telling them apart is the difference between leaving
   * the stage alone and rebuilding it.
   */
  if (!criticText.trim()) return ['silent']
  if (/^NO CORRECTIONS/im.test(criticText)) return ['no-corrections']
  {
    /**
     * Whether the critic used a shape we recognise — not whether an edit landed.
     *
     * These differ, and conflating them was a bug the tests caught: a FIX whose
     * quote did not match was dropped (correctly), `touched` stayed false, and
     * the critic's whole raw output was then filed as a section. The build would
     * have received a blob of half-parsed edit syntax as if it were design. A
     * critic that used the right form and quoted badly has been understood; only
     * one that used no recognised form at all needs keeping verbatim.
     */
    let recognised = false

    for (const [, rawTitle, find, replace] of criticText.matchAll(
      /^###\s*FIX:\s*(.+?)\s*$\s*<<<FIND\s*$([\s\S]*?)^<<<REPLACE\s*$([\s\S]*?)^<<<END\s*$/gim
    )) {
      const title = rawTitle.trim().toUpperCase()
      const body = sections.get(title)
      const needle = find.trim()
      if (!body || !needle) {
        corrections.push(`${title}:fix-unknown-section`)
        recognised = true
        continue
      }
      const hit = findQuote(body, needle)
      if (hit.kind !== 'one') {
        /**
         * Dropped rather than guessed at. A fuzzy match would edit a span the
         * critic did not mean, and the whole point of quoting is to be sure.
         *
         * The reason is logged because I do not know it. Measured on the first
         * run of this format, thirteen of thirteen FIX blocks failed to match
         * and there was nothing in the log to say why — the same "it broke" with
         * no cause that cost three rounds on the browser WebSocket. `kind` says
         * whether whitespace was the difference or the quote was simply wrong,
         * which is the fact needed to decide what to do next.
         */
        corrections.push(`${title}:fix-${hit.kind}`)
        recognised = true
        continue
      }
      sections.set(title, body.slice(0, hit.at) + replace.trim() + body.slice(hit.at + hit.length))
      corrections.push(`${title}:fixed${hit.loose ? '-loose' : ''}`)
      recognised = true
    }

    for (const [, rawTitle, addition] of criticText.matchAll(
      /^###\s*ADD:\s*(.+?)\s*$([\s\S]*?)^<<<END\s*$/gim
    )) {
      const title = rawTitle.trim().toUpperCase()
      const body = sections.get(title)
      const extra = addition.trim()
      if (!body || extra.length < 20) {
        corrections.push(`${title}:add-skipped`)
        recognised = true
        continue
      }
      sections.set(title, `${body}

${extra}`)
      corrections.push(`${title}:added(${extra.length})`)
      recognised = true
    }

    // The shape it was taught before. Kept, with the guard that made it safe.
    for (const [, rawTitle, rawBody] of criticText.matchAll(
      /^###\s*REPLACE:\s*(.+?)\s*$([\s\S]*?)^###\s*END\s*$/gim
    )) {
      const title = rawTitle.trim().toUpperCase()
      const body = rawBody.trim()
      const original = sections.get(title)
      if (!original) {
        corrections.push(`${title}:unknown-section`)
        recognised = true
        continue
      }
      if (body.length < original.length * 0.67) {
        corrections.push(`${title}:rejected-too-short(${body.length}/${original.length})`)
        recognised = true
        continue
      }
      sections.set(title, body)
      corrections.push(`${title}:replaced`)
      recognised = true
    }

    /**
     * The critic wrote something in none of the shapes it was given. Its review
     * is still worth more to the build than nothing, so it is filed as its own
     * section rather than dropped.
     */
    if (!recognised) {
      sections.set(SECTION_TITLE['design-critic'], criticText)
      corrections.push('unparsed:kept-as-section')
    }
  }

  return corrections
}

export interface ChangeSpecInput {
  instruction: string
  html: string
  presetName?: string
  presetSpec: string
  modelId: string
  /** A reference image attached to the edit request, if any. */
  image?: ImageInput | null
  /**
   * The user's data file, sampled — see utils/data-attachment.ts.
   *
   * The change designer needs it for the same reason the build designer does:
   * the record count decides whether "replace the mock data" is a values change
   * or a screen that now needs search and paging.
   */
  dataContext?: string
  /**
   * What the project says about itself — see change-diagnosis.ts.
   *
   * This designer was handed the screen NAMES and the instruction and nothing
   * of the project it was specifying a change to. Asked 「画像が出てないんだけど
   * どうすべき？」, it could only ask four questions back, every one of them
   * answerable from the source.
   */
  facts?: string
  onDelta?: (fullText: string) => void
}

/**
 * Specifies an edit before it is built.
 *
 * Structural and behavioural edits are the ones that used to ship broken — a new
 * screen with no route, a button wired to nothing. Generation solved that with
 * an interaction inventory the build is held to; this gives edits the same
 * contract, scoped to the change rather than the whole product.
 *
 * A single agent, not a graph: there is one question to answer here, and the
 * work is bounded by the instruction.
 */
export async function specifyChange(input: ChangeSpecInput): Promise<string> {
  const { instruction, html, presetName, presetSpec, modelId, image, dataContext, facts, onDelta } = input

  const model = new BedrockModel({
    modelId,
    maxTokens: 8000,
    temperature: 0.3,
    region: process.env.AWS_REGION || 'ap-northeast-1',
  })

  /**
   * What the change designer is actually looking at.
   *
   * The test here was the <script type="text/jsx"> attribute — the transport
   * React projects travelled in before line fences — so it was false for every
   * document this product now produces. The designer was told it was specifying
   * a change to a single HTML page with no screens, and specified accordingly.
   */
  const existingFiles = readProjectFiles(html)
  const existingKind = detectKind(existingFiles.keys())
  const isReact = existingKind === 'react'
  const screens = existingKind
    ? [...existingFiles.keys()]
        .filter((p) => FRAMEWORKS[existingKind].screenFile.test(p))
        .map((p) => (p.split('/').pop() ?? '').replace(/[.][a-z]+$/, ''))
    : [...new Set([...html.matchAll(/data-screen="([a-zA-Z0-9_-]+)"/g)].map((m) => m[1]))]

  const agent = new Agent({
    id: 'change-designer',
    name: 'change-designer',
    systemPrompt: `You are an interaction designer specifying a change to an existing UI.
${presetSpec ? `\nBINDING DESIGN SYSTEM — anything you add must use these values only:\n${presetSpec}` : ''}
${image ? '\nAn image is attached. It is the reference for this change: read the layout, palette, type and component patterns the user is asking for off the image, and specify them concretely (hex values, sizes, structure) so the build can reproduce it without seeing the image.' : ''}

The build is checked against your specification, so be exact and be complete.

You are given PROJECT FACTS measured from the current source when they are
available. A request that describes a problem or asks what to do is a request to
find the cause and fix it: name the cause from the facts, then specify the fix.
Never answer with questions for the user. Where something is genuinely
ambiguous, choose the most reasonable reading and state it as an assumption
(「〜と判断しました」).

Produce, for this change only:
1. SCREENS — any screen added or altered. For a new one: its id, where it is
   reached from, and what it shows. It must be added to the route table — and to
   the navigation only when it makes sense with nothing selected (a detail,
   checkout or 完了 screen is reached from its action) — and an unknown route must
   still fall back to the first screen.
2. CONTROLS — every control involved, one line each: where it lives, what the
   user does, and exactly what changes as a result (which state key is written,
   which screens re-render).
3. STATE — any new state, its shape, and which existing state it must stay
   consistent with.
4. REVERSE PATHS — back navigation, cancel, close, clear, and the empty state of
   anything that can be empty.
5. CONTENT — the real labels and seed data to use. Japanese unless the existing
   UI is in another language.

Rules you are enforcing: no control may be decorative; confirmation is a modal,
never window.confirm; NO EMOJI anywhere — icons are inline SVG or nothing.
Do not restate parts of the UI the change does not touch. Be concise: this is a
build contract, not a document.

LANGUAGE: write your reasoning and every piece of prose in Japanese. It is streamed
to the user while the edit runs. Structural identifiers stay English — screen ids,
state keys, CSS property names, hex values.`,
    model,
    tools: makeDesignTools(presetName || 'digital-agency'),
    printer: false,
  })

  const briefText = `Existing UI: ${isReact ? 'TypeScript React project' : 'single HTML document'}, screens: ${screens.join(', ') || '(none detected)'}

Edit request: "${instruction}"${dataContext ?? ''}${facts ?? ''}

Specify this change.`
  const brief = image
    ? [
        { image: { format: image.format, source: { bytes: Buffer.from(image.base64, 'base64') } } },
        { text: briefText },
      ]
    : briefText

  let text = ''
  /*
   * Kept from both branches so the bill is taken once, below.
   *
   * This agent is the modify path's design phase and it carries tools, so a
   * single `specifyChange` is several model turns reading the whole edit brief.
   * None of it reached the ledger: `runModify` opens one and every raw call
   * reports into it, but a Strands agent reports into its own result object and
   * nothing was reading that here. So the modify path measured 4 calls and 32k
   * tokens at the median while its largest stage was not among them — which is
   * why "the modify path is cheap" was never a safe thing to conclude.
   *
   * `accumulatedUsage` rather than a per-turn sum: the tool loop's turns are
   * what it accumulates, and they are exactly the ones a per-call reading here
   * would miss.
   */
  let agentResult: any = null
  if (onDelta) {
    const iterator = agent.stream(brief)
    let step = await iterator.next()
    while (!step.done) {
      const ev: any = step.value
      if (ev?.type === 'modelStreamUpdateEvent' && ev.event?.type === 'modelContentBlockDeltaEvent') {
        const delta = ev.event.delta
        if (delta?.type === 'textDelta' && typeof delta.text === 'string') {
          text += delta.text
          onDelta(text)
        }
      }
      step = await iterator.next()
    }
    const final: any = step.value
    agentResult = final
    if (!text) {
      text = (final?.content ?? [])
        .map((c: any) => (typeof c?.text === 'string' ? c.text : ''))
        .join('\n')
        .trim()
    }
  } else {
    const result: any = await agent.invoke(brief)
    agentResult = result
    text = (result?.content ?? [])
      .map((c: any) => (typeof c?.text === 'string' ? c.text : ''))
      .join('\n')
      .trim()
  }

  const changeUsage = usageFromStrandsResult(agentResult)
  if (changeUsage) {
    recordTokens(changeUsage.inputTokens, changeUsage.outputTokens, 'design:change-designer')
  } else {
    recordUnreportedCall('change-designer')
  }

  // After the ledger, deliberately: a specification too short to use was still
  // paid for, and a run that throws here should still say what it spent.
  if (text.trim().length < 80) throw new Error(`change specification too short (${text.length} chars)`)
  return text.trim()
}
