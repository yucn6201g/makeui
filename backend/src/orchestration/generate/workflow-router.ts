import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'
import { logger } from '../../utils/logger.js'
import { FRAMEWORKS } from '../../config/frameworks.js'
import { createBedrockClient } from '../../config/bedrock-client.js'
import { readProjectFiles } from '../../tools/project/project-transport.js'
import { detectKind } from '../../tools/project/framework-compile.js'
import { firstJsonObject } from '../../utils/model-json.js'
import { recordTokens, recordUnreportedCall } from '../../services/token-ledger.js'

/**
 * Chooses the agent workflow from what the user actually asked for.
 *
 * The design phase used to be a fixed four-specialist chain on every request.
 * That is the wrong shape at both ends: a single login form paid 288 seconds for
 * specialists it did not need, while nothing existed to spend *more* on a brief
 * that genuinely warranted it. Editing was worse — every instruction, from
 * "make the button red" to "add a whole category screen", took the identical
 * single pass.
 *
 * So the workflow is composed per request. Routing is one cheap model call with
 * a strict schema, and every failure path falls back to deterministic rules:
 * a router that cannot answer must never be able to fail a generation.
 */

const client = createBedrockClient()

/** Specialists the design phase can be composed from, in canonical order. */
const DESIGN_SPECIALISTS = [
  'layout-architect',
  'interaction-designer',
  'style-expert',
  'content-strategist',
  'design-critic',
] as const

export type DesignSpecialist = (typeof DESIGN_SPECIALISTS)[number]

type ModifyScope = 'visual' | 'content' | 'structural' | 'behaviour'

/** One thing the user asked for, when they asked for several at once. */
interface ModifyPart {
  /** The request in the user's own words, trimmed to the one thing it asks. */
  text: string
  scope: ModifyScope
}

interface ModifyPlan {
  scope: ModifyScope
  /**
   * The request broken into the things it actually asks for.
   *
   * A single-part request yields one entry, so callers have one shape to
   * handle. It exists because a request like 「在庫画面を追加して、遷移も付けて、
   * ボタンの色も変えて、CSVエクスポートも」 was carried through every stage as one
   * thing: one scope, one specification, one file plan, and then each file was
   * handed the WHOLE instruction — so the file that only had to change a colour
   * token also read "add CSV export".
   *
   * Free to produce: this classification call already ran, and the decomposition
   * is the same reading of the same sentence.
   */
  parts: ModifyPart[]
  /**
   * Whether to spec the change with the interaction designer before editing.
   * Worth a minute for "add a screen"; wasted on "make the button red".
   */
  needsDesignPass: boolean
  reason: string
  routed: boolean
}

/** Bounded hard: routing must be a rounding error against the work it schedules. */
/*
 * Raised from 400 when the modify router began returning the request's parts as
 * well as its scope. Four parts of Japanese plus the JSON wrapper does not fit
 * in 400, and a truncated reply is not a smaller answer — it is unparsable JSON
 * and a fall back to keyword matching. 900 against an edit that costs twenty
 * thousand is still the rounding error this bound exists to keep it.
 */
const ROUTER_MAX_TOKENS = 900

async function classify(modelId: string, system: string, user: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await client.send(new InvokeModelCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: ROUTER_MAX_TOKENS,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    }))
    const body = JSON.parse(new TextDecoder().decode(res.body))
    /*
     * Small, frequent, and until now invisible.
     *
     * `ROUTER_MAX_TOKENS` is 900 and the comment above calls the cost a rounding
     * error — which it is, per call. But it is one call on every `auto`
     * generation and one on every edit, and none of them were reported, so the
     * claim that it rounds to nothing was an assertion rather than a reading.
     * It is a line of code to make it a reading.
     *
     * `recordTokens` is a no-op outside a run's ledger, so this is safe on the
     * paths that call the classifier before one is open.
     */
    if (body.usage && typeof body.usage.input_tokens === 'number') {
      recordTokens(body.usage.input_tokens, body.usage.output_tokens ?? 0, 'router:classify')
    } else {
      recordUnreportedCall('router:classify')
    }
    const text: string = body.content?.[0]?.text ?? ''
    // Models wrap JSON in prose or fences no matter how firmly told not to,
    // and prose on either side used to take the object with it.
    return firstJsonObject<Record<string, unknown>>(text)
  } catch (e) {
    recordUnreportedCall('router:classify')
    logger.warn('Workflow router call failed; using deterministic fallback', { error: String(e) })
    return null
  }
}

type ModelTier = 'haiku' | 'sonnet' | 'opus'

/** Cheapest first. The order the ladder is read in. */
const ALL_TIERS: readonly ModelTier[] = ['haiku', 'sonnet', 'opus']

interface ModelSelection {
  tier: ModelTier
  /** One line in Japanese, shown in the chat so the choice is visible, not magic. */
  reason: string
  /** True when the classifier answered; false when the keyword rules decided. */
  routed: boolean
}

/** How each tier is described to the classifier. */
const TIER_BRIEF: Record<ModelTier, string> = {
  haiku: `  haiku   Fast and cheap. One screen, a small form, a minor variation, or an
          explicitly rough or throwaway mock.`,
  sonnet: `  sonnet  The default. A few screens with real navigation and actions — the
          overwhelming majority of product briefs land here.`,
  opus: `  opus    Slowest and most expensive. Reserve for briefs that are genuinely large
          or subtle: many screens with cross-screen state, a rich or unusual
          domain, an explicit demand for production quality or fine craft, or a
          detailed specification the build must follow closely.`,
}

/** A newline, named, because a template literal cannot hold an escaped one
 *  inside a `join()` without the escape being eaten somewhere on the way in. */
const NL = '\n';

/**
 * The prompt, over the tiers this deployment can actually invoke.
 *
 * Built rather than fixed, because a tier can be withdrawn — the account's Opus
 * throughput allocation is zero, see config/withdrawn.ts — and the list used to
 * name all three regardless. The classifier would then choose `opus`, the clamp
 * downstream would turn it into Sonnet, and the sentence shown to the user was
 * the classifier's: 「品質重視の依頼と判断し、最高品質のモデルを選びました
 * （管理者の設定により sonnet に制限）」. Every clause of that is wrong. No
 * administrator set anything, the model chosen was not the highest quality, and
 * the person reading it would go looking at a setting with nothing to do with it.
 *
 * A choice that cannot be honoured is not worth asking for. Naming only what can
 * be run makes the reason honest without a second message to explain the first.
 */
const modelRouterSystem = (offered: readonly ModelTier[]): string => {
  const list = (['haiku', 'sonnet', 'opus'] as ModelTier[]).filter((t) => offered.includes(t));
  const top = list[list.length - 1] ?? 'sonnet';
  const has = (t: ModelTier) => list.includes(t);
  return `You choose which model tier should build a UI from the user's request.

Tiers:
${list.map((t) => TIER_BRIEF[t]).join(NL)}

Rules:
- Default to "${has('sonnet') ? 'sonnet' : top}". Choose another tier only when the brief clearly earns it.
- Length alone is not complexity. A long but repetitive brief is still "${has('sonnet') ? 'sonnet' : top}".
- A request to make something "properly", "for a client", "production-grade", or
  naming a high bar is a signal for "${top}".${has('haiku') ? `
- "ざっくり", "とりあえず", "簡単な", "下書き" and similar are signals for "haiku".` : ''}

Reply with ONLY this JSON:
{"tier":"${list.join('|')}","reason":"<one short sentence in Japanese>"}`;
}

/**
 * Keyword rules for when the classifier is unavailable.
 *
 * Lands on sonnet unless the brief is unambiguous, because the cost of guessing
 * wrong is asymmetric: a too-small model produces a mock the user has to redo,
 * while a too-large one only costs money.
 */
function fallbackModelSelection(
  prompt: string,
  offered: readonly ModelTier[] = ALL_TIERS
): ModelSelection {
  const p = prompt.toLowerCase()
  const has = (t: ModelTier) => offered.includes(t)
  const list = ALL_TIERS.filter((t) => has(t))
  const top = list[list.length - 1] ?? 'sonnet'
  if (has('haiku') && /(ざっくり|とりあえず|簡単な|下書き|ドラフト|draft|rough|quick)/.test(p)) {
    return { tier: 'haiku', reason: '簡易的な依頼と判断し、最速のモデルを選びました', routed: false }
  }
  if (/(本番|プロダクション|作り込|production|高品質|作り込んで)/.test(p)) {
    /*
     * The reason names the tier it landed on rather than 「最高品質」.
     *
     * With Opus withdrawn the top of the list is Sonnet, and calling Sonnet the
     * highest-quality model would be a claim the menu contradicts. The signal in
     * the brief is still read the same way; only the sentence changes.
     */
    return {
      tier: top,
      reason: top === 'opus'
        ? '品質重視の依頼と判断し、最高品質のモデルを選びました'
        : '品質重視の依頼と判断し、利用できる中で最も品質の高いモデルを選びました',
      routed: false,
    }
  }
  return has('sonnet')
    ? { tier: 'sonnet', reason: '標準的な依頼と判断し、バランス型のモデルを選びました', routed: false }
    : { tier: top, reason: '依頼内容から自動で選択しました', routed: false }
}

/**
 * Which model tier the brief actually warrants.
 *
 * This exists because Bedrock's Intelligent Prompt Routing cannot serve it. The
 * default Anthropic prompt router in this region routes between Claude 3 Haiku and
 * Claude 3.5 Sonnet (2024-06-20), and `CreatePromptRouter` rejects every 4.x model
 * with `ValidationException: Prompt routing is not supported for the specified
 * model identifier` — verified against Haiku 4.5 + Sonnet 4.6 and Sonnet 4.6 +
 * Opus 4.8, with a Claude 3 pair as the control to prove the request shape was
 * fine. Routing through it would move generation two model generations backwards,
 * onto a pair this codebase's prompts, audits and presets were never tuned for.
 *
 * So the selection is made here, over the models actually configured. The decision
 * is the same one the workflow router already makes about complexity — but it has
 * to happen BEFORE a model is resolved, so it runs as its own call rather than
 * reusing that one.
 */
/**
 * Picks a tier for `model: 'auto'`.
 *
 * `classifierModelId` is the cheapest configured model, never the one being
 * chosen — the decision has to be made before a generation model exists, and
 * paying Opus rates to decide whether to use Opus would defeat the point.
 */
export async function selectModelForPrompt(
  prompt: string,
  classifierModelId: string,
  /**
   * The tiers this deployment can invoke. Defaults to all three.
   *
   * Passed in rather than read here, because "what is withdrawn" is a fact about
   * the deployment that config/model-config.ts already owns, and two places
   * deciding it is how they come to disagree.
   */
  offered: readonly ModelTier[] = ALL_TIERS
): Promise<ModelSelection> {
  const parsed = await classify(classifierModelId, modelRouterSystem(offered), prompt.slice(0, 4000))
  const tier = parsed?.tier
  // Against what is offered, not against the three names: a classifier that
  // answers `opus` anyway is answering a question it was not asked, and honouring
  // it would put the clamp back.
  if (tier !== 'haiku' && tier !== 'sonnet' && tier !== 'opus') {
    return fallbackModelSelection(prompt, offered)
  }
  if (!offered.includes(tier)) {
    return fallbackModelSelection(prompt, offered)
  }
  const reason = typeof parsed?.reason === 'string' && parsed.reason.trim()
    ? parsed.reason.trim()
    : '依頼内容から自動で選択しました'
  return { tier, reason, routed: true }
}

/**
 * The generate router was here, and it never once composed anything.
 *
 * It asked a model which of the five design specialists to run. Measured over 14
 * days and 33 generations: **all five, every time.** That is not a wiring fault —
 * its own guidance said so. `layout-architect is ALWAYS included`, `style-expert:
 * include on essentially every brief`, `content-strategist: include when the UI
 * carries substantial content`, `design-critic: include for "standard" and
 * "complex"`, and `interaction-designer: omit only for a single static screen
 * with no behaviour` — while the request handed to it always read
 * `Output: multi-screen ... application`. It was asked to cut and told, in the
 * same breath, that nothing this product generates qualifies for cutting.
 *
 * So it cost a classify call per run to return a constant, and wrote a log line —
 * 「Workflow routed」 with a reason in Japanese — that reads like a decision to
 * anyone reading these logs afterwards. That is the expensive part. A measurement
 * taken from this pipeline has to be able to tell a choice from a formality.
 *
 * The chain is passed directly now. Composing it for real is a quality change and
 * an unmeasured one: no run has ever gone out with fewer than five, so there is
 * nothing to compare a cut against. It needs its own measurement — the design
 * phase is 18.3% of a generation's tokens, so the question is worth asking, and
 * asking it means running the shorter chain on purpose rather than hoping a
 * router does it by accident.
 *
 * The MODIFY router below is untouched: that one does cut.
 */
export const GENERATE_SPECIALISTS: readonly DesignSpecialist[] = DESIGN_SPECIALISTS

/**
 * Deterministic fallback for edits.
 *
 * Keyword rules are weak, but the cost of being wrong is asymmetric: skipping a
 * needed design pass produces a broken screen, while running an unnecessary one
 * only costs time. So anything that looks structural gets the pass.
 */
const STRUCTURAL_HINTS =
  /(画面|ページ|スクリーン|タブ|セクション|機能|フロー|ステップ)\s*(を)?\s*(追加|作成|新設|増や|作って|足して)|(add|create|new)\s+(screen|page|tab|section|view|flow)/i
const BEHAVIOUR_HINTS =
  /(動作|挙動|動くように|機能するように|遷移|バリデーション|検証|状態|保存|送信|フィルタ|並び替え|ソート|検索)/i

function fallbackModifyPlan(instruction: string): ModifyPlan {
  const structural = STRUCTURAL_HINTS.test(instruction)
  const behaviour = !structural && BEHAVIOUR_HINTS.test(instruction)
  const scope: ModifyScope = structural ? 'structural' : behaviour ? 'behaviour' : 'visual'
  return {
    scope,
    // Undecomposed rather than guessed at. Splitting Japanese on 「、」 would cut
    // 「赤、青、緑のボタン」 into three requests, and a wrong decomposition is
    // worse than none: it would send each file a fragment of a sentence.
    parts: [{ text: instruction, scope }],
    needsDesignPass: structural || behaviour,
    reason: 'ルーティングを利用できないため語句から判定しました',
    routed: false,
  }
}

const MODIFY_ROUTER_SYSTEM = `You classify an edit request against an existing UI.

scope:
  visual      colour, spacing, typography, sizing, imagery — no new behaviour
  content     wording, labels, seed data — no new behaviour
  structural  adds or removes a screen, section, tab or feature
  behaviour   makes something work, or changes what an action does

needsDesignPass: true when the change adds screens or behaviour that must be
specified before it can be built correctly (new controls, new state, new
navigation, validation rules). False for visual and content edits — those are
applied directly and a design pass would only add latency.

parts: the request broken into the separate things it asks for. One request in,
one entry out — do NOT invent parts. Split only where the user genuinely asked
for more than one change ("画面を追加して、ボタンの色も変えて" is two). Keep each
part in the user's own words, trimmed to the one thing it asks, and give each
its own scope. Ordering follows the request.

scope at the top level is the WIDEST of the parts, in the order
visual < content < behaviour < structural.

Reply with ONLY this JSON:
{"scope":"visual|content|structural|behaviour","needsDesignPass":true|false,
 "parts":[{"text":"<the user's words>","scope":"visual|content|structural|behaviour"}],
 "reason":"<one short sentence in Japanese>"}`

export async function planModifyWorkflow(
  instruction: string,
  modelId: string,
  documentSummary: string
): Promise<ModifyPlan> {
  const raw = await classify(
    modelId,
    MODIFY_ROUTER_SYSTEM,
    `Existing UI: ${documentSummary}\n\nEdit request: "${instruction}"`
  )
  if (!raw) return fallbackModifyPlan(instruction)

  const scope = (['visual', 'content', 'structural', 'behaviour'] as const).includes(raw.scope as ModifyScope)
    ? (raw.scope as ModifyScope)
    : 'visual'
  const parts = readParts(raw.parts, instruction, scope)

  /*
   * Trust the classification of scope over the flag: a structural edit always
   * needs the pass regardless of what the model said about it.
   *
   * And a request that asks for several different KINDS of thing gets one too.
   * The specification is the only thing that carries the parts to the per-file
   * editors coherently — without it each file sees the instruction and its own
   * fragment and nothing that relates them, which is how 「画面を追加して、遷移も、
   * 色も、エクスポートも」 becomes three of four parts applied. Several parts of
   * the SAME kind do not qualify: three colour changes need no specification,
   * they need three edits.
   */
  const mixedKinds = new Set(parts.map((p) => p.scope)).size > 1
  const needsDesignPass =
    scope === 'structural' || scope === 'behaviour' || mixedKinds ? true : raw.needsDesignPass === true

  /*
   * Which rule decided, not just what was decided.
   *
   * `needsDesignPass: true` on a structural edit says nothing about whether the
   * mixed-kinds rule works, because structural forces the pass on its own — a
   * run measured against it could only ever confirm the rule that was already
   * there. Recording the three inputs separately is what makes the new one
   * measurable at all.
   */
  logger.info('Modify routing decided', {
    scope,
    partCount: parts.length,
    partScopes: [...new Set(parts.map((p) => p.scope))],
    mixedKinds,
    routerSaidNeedsDesignPass: raw.needsDesignPass === true,
    needsDesignPass,
  })

  return {
    scope,
    parts,
    needsDesignPass,
    reason: typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim() : '指示内容から判定しました',
    routed: true,
  }
}

/** How wide a set of parts reaches, for the single scope callers still read. */
const SCOPE_WIDTH: Record<ModifyScope, number> = { visual: 0, content: 1, behaviour: 2, structural: 3 }

/**
 * The decomposition, read defensively.
 *
 * A router that returns nothing usable must degrade to the behaviour that
 * existed before parts did — the whole instruction as one part — rather than to
 * an empty list, which would leave every downstream reader with nothing to act
 * on. Same principle as the fallback plan: no decomposition is safe, a wrong one
 * is not.
 */
function readParts(raw: unknown, instruction: string, fallbackScope: ModifyScope): ModifyPart[] {
  if (!Array.isArray(raw)) return [{ text: instruction, scope: fallbackScope }]
  const parts: ModifyPart[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const text = String((entry as any).text ?? '').trim()
    if (!text) continue
    const s = (entry as any).scope
    parts.push({
      text: text.slice(0, 400),
      scope: (['visual', 'content', 'structural', 'behaviour'] as const).includes(s) ? s : fallbackScope,
    })
  }
  /*
   * A single part is the same thing as no decomposition, so it is normalised to
   * the instruction itself. The model paraphrasing a one-part request would
   * otherwise replace what the user wrote with what the router thought it meant.
   */
  if (parts.length <= 1) return [{ text: instruction, scope: fallbackScope }]
  return parts.slice(0, 8)
}

/** The widest scope among the parts. Used where one label is still wanted. */
export function widestScope(parts: ModifyPart[], fallback: ModifyScope): ModifyScope {
  return parts.reduce<ModifyScope>(
    (widest, p) => (SCOPE_WIDTH[p.scope] > SCOPE_WIDTH[widest] ? p.scope : widest),
    fallback
  )
}

/**
 * A short, cheap description of the document for the modify router.
 *
 * Read through the transport, not through the `<script type="text/jsx">`
 * attribute this used to test for. That attribute disappeared when components
 * carrying their own `<script>` forced the move to line fences, so the test was
 * false for every document — and this told the edit router that a 40-file Vue
 * application was "a single HTML document with 0 screens". The router then
 * classified every structural request against a description of something else.
 */
export function summariseDocument(html: string): string {
  const files = readProjectFiles(html)
  const kind = detectKind(files.keys())
  if (!kind) {
    const screens = new Set([...html.matchAll(/data-screen="([\w-]+)"/g)].map((m) => m[1])).size
    return `single HTML document, ${screens} screen(s), ${html.length} chars`
  }
  const fw = FRAMEWORKS[kind]
  const screens = [...files.keys()].filter((p) => fw.screenFile.test(p)).length
  const components = [...files.keys()].filter((p) => p.startsWith('src/components/')).length
  return `${fw.label} project, ${files.size} files, ${screens} screen(s), ${components} component(s), ${html.length} chars`
}
