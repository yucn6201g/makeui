/**
 * The plan mode: a proposal and a design specification instead of a document,
 * which an approved build then works from.
 */
import { resolveModelForPrompt, type ModelChoice } from '../../config/model-config.js'
import { getPresetConfig } from '../../config/agentcore-config.js'
import { withTokenLedger, logLedger, type TokenLedger } from '../../services/token-ledger.js'
import { revisePlan } from '../edit/plan-revision.js'
import { logger } from '../../utils/logger.js'
import { extractRequirements, designRequirementsBlock, type Requirement } from './requirements.js'
import { imageCaptionNote } from '../../utils/image-input.js'
import { prepareSuppliedImages } from './supplied-images.js'
import { parseAttachment, attachmentDirective, type RawAttachment } from '../../utils/data-attachment.js'
import { appendJobEvent, tokenHeartbeat, updateJobStream } from '../../services/job-service.js'
import { allowedModelsForRun } from '../../services/token-usage.js'
import { diagnoseForChange } from '../edit/change-diagnosis.js'
import { FRAMEWORKS } from '../../config/frameworks.js'
import { resolveUserDesignSystem, getPresetSpec } from '../presets/design-presets.js'
import { DEFAULT_OUTPUT_KIND, type OutputKind } from '../../config/frameworks.js'
import {
  getRunDesignSwarm,
  STREAM_FLUSH_MS,
  stripFences,
  invokeModel,
  invokeVision,
  routerModelId,
} from './model-calls.js'

export interface PlanUIOptions {
  prompt: string
  userId: string
  preset?: string
  model?: ModelChoice
  outputKind?: OutputKind
  jobId?: string
  /** Present when planning a change to an existing document rather than a build. */
  html?: string
  /** The user's reference image, so the proposal describes what they attached. */
  image?: string
  /**
   * The pictures for the UI itself.
   *
   * Planning needs them for the same reason it needs the data file: an approved
   * plan REPLACES the design phase in /generate, so a plan written without
   * knowing which pictures exist commits the build to screens with nowhere to
   * put them — and the user approves a proposal that does not mention the
   * photographs they attached.
   */
  images?: string[]
  /** What each picture shows, when the user said so. Aligned with `images`. */
  imageCaptions?: string[]
  /**
   * The user's data file. Planning needs it because an approved plan REPLACES
   * the design phase in /generate — a plan written without the record count
   * commits the build to the wrong screen, and the attachment then looks
   * ignored even though the build received it.
   */
  attachment?: RawAttachment
  /**
   * The proposal this request amends, when the user answers a plan with a change
   * to it rather than approving it. `prompt` is then the change.
   */
  revision?: PlanRevision
}

export interface PlanRevision {
  /** The design specification behind the proposal being amended. */
  spec: string
  /** The proposal as the user read it. */
  plan: string
  /** The request that proposal answered. */
  prompt: string
}

export interface PlanUIResult {
  /** Readable proposal, shown to the user for approval. */
  plan: string
  /**
   * What the plan actually cost, as the models reported it.
   *
   * Planning runs the design phase, which is most of a generation's cost, and it
   * used to be recorded as `prompt.length / 4` in and the proposal's length out —
   * the two smallest quantities in the whole operation.
   */
  tokenUsage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  /**
   * The design specification behind it, handed back to /generate on approval so
   * the build is of the plan that was reviewed. Empty when planning a change,
   * which the modify path re-specs against the live document anyway.
   */
  spec: string
  /**
   * Which tier actually ran, and the design system it was bound to.
   *
   * A proposal is model output like any other reply, and the thread says what
   * produced each one. Without this a plan would be the only message in the
   * history that cannot answer the question.
   */
  modelTier: 'haiku' | 'sonnet' | 'opus'
  preset: string
}

/**
 * Produce a proposal without building anything.
 *
 * The expensive part of a run is the design phase, and it is also the part whose
 * decisions the user most often wants to redirect — the shape of the app, which
 * screens exist, what the visual direction is. Building first and asking after
 * means every correction costs a full rebuild. So plan mode runs exactly that
 * phase, shows what it decided, and keeps the specification: approving it starts
 * a build that skips straight to code, so the review is free rather than a
 * duplicated cost.
 */
export async function planUI(options: PlanUIOptions): Promise<PlanUIResult> {
  return withTokenLedger(async (ledger) => {
    // The running total for the progress transcript — see tokenHeartbeat.
    const heartbeat = options.jobId ? tokenHeartbeat(options.jobId, () => ledger.inputTokens + ledger.outputTokens) : null
    if (heartbeat) ledger.onRecord = heartbeat.notify
    try {
      return await runPlan(options, ledger)
    } finally {
      if (heartbeat) await heartbeat.flush()
      // Written in `finally` so a failed run still says what it spent. A run
      // that dies after the design phase is exactly the one worth costing.
      logLedger(ledger, { run: 'runPlan' })
    }
  })
}

export async function runPlan(options: PlanUIOptions, ledger: TokenLedger): Promise<PlanUIResult> {
  const { prompt, userId, preset, model: modelChoice, outputKind = DEFAULT_OUTPUT_KIND, jobId, html } = options
  const dataContext = attachmentDirective(parseAttachment(options.attachment))
  const requestId = crypto.randomUUID()
  // Planning has to see the reference too: the proposal the user approves is what
  // /generate is handed, so a plan written blind commits the build to the wrong thing.
  // And the pictures to place — see supplied-images.ts for why this was missing.
  const supplied = await prepareSuppliedImages({
    image: options.image,
    images: options.images,
    imageCaptions: options.imageCaptions,
    prompt,
    invoke: async (system, content, maxTokens) =>
      invokeVision(await routerModelId(), system, content, maxTokens, 'images:caption'),
    context: { requestId, run: 'plan' },
  })
  const imageInput = supplied.reference
  const userSystem = await resolveUserDesignSystem(preset, userId, requestId)
  const { presetName } = await getPresetConfig(userSystem ?? preset)
  const selectedModel = await resolveModelForPrompt(
    modelChoice,
    prompt,
    await allowedModelsForRun(userId)
  )
  const modelId = selectedModel.modelId
  const presetSpec = presetName === 'none' ? '' : getPresetSpec(presetName)

  let lastWrite = 0
  let inFlight = false
  let phase = ''
  const push = (full: string) => {
    if (!jobId) return
    const now = Date.now()
    if (inFlight || now - lastWrite < STREAM_FLUSH_MS) return
    lastWrite = now
    inFlight = true
    updateJobStream(jobId, full, full.length, phase).catch(() => {}).finally(() => { inFlight = false })
  }
  // Announced immediately, so a step that emits nothing still shows in the
  // transcript. Chained for the ordering reason explained on generateUI's setPhase.
  let phaseWrites: Promise<unknown> = Promise.resolve()
  const setPhase = (label: string) => {
    phase = label
    lastWrite = 0
    if (jobId) phaseWrites = phaseWrites.then(() => updateJobStream(jobId, '', 0, label)).catch(() => {})
  }

  // Planning a change is a different question — what would this edit touch — and
  // the modify path already has a specialist for it.
  if (html) {
    setPhase('変更内容を検討中')
    if (jobId) appendJobEvent(jobId, 'routing', 'completed').catch(() => {})
    const { specifyChange } = await import('./strands-design.js')
    /*
     * What the project says about itself — see change-diagnosis.ts. Asked
     * 「画像が出てないんだけどどうすべき？」 without it, this path returned four
     * questions for the user and no plan.
     */
    const diagnosis = diagnoseForChange(html, prompt)
    const spec = await specifyChange({
      instruction: prompt,
      html,
      presetName,
      presetSpec,
      modelId,
      image: imageInput,
      // The data file and the pictures to place, which this path used to leave behind.
      dataContext: `${dataContext}${supplied.contentContext}${imageInput ? imageCaptionNote(supplied.referenceCaption) : ''}`,
      facts: diagnosis.text,
      onDelta: push,
    })
    logger.info('Change plan specified', {
      requestId,
      specChars: spec.length,
      factChars: diagnosis.text.length,
      problemReport: diagnosis.problemReport,
      aboutImages: diagnosis.aboutImages,
    })
    const readable = await invokeModel(modelId, PLAN_CHANGE_WRITER_SYSTEM,
      `変更指示: "${prompt}"${diagnosis.text}\n\n設計内容:\n${spec.slice(0, 20000)}`, 4000, null, 'plan:write-change')
    return { plan: stripFences(readable), spec: '', modelTier: selectedModel.tier, preset: presetName || 'none', tokenUsage: { inputTokens: ledger.inputTokens, outputTokens: ledger.outputTokens, cacheReadTokens: ledger.cacheReadTokens, cacheWriteTokens: ledger.cacheWriteTokens } }
  }

  /*
   * An answer to a proposal, not a new brief — see `revisePlan`.
   */
  if (options.revision && options.revision.spec.trim()) {
    setPhase('プランを修正中')
    if (jobId) appendJobEvent(jobId, 'routing', 'completed').catch(() => {})
    const revised = await revisePlan(options.revision, prompt, (system, user) =>
      invokeModel(modelId, system, user, 6000, null, 'plan:revise'), PLAN_WRITER_SYSTEM)
    logger.info('Plan revised', {
      requestId,
      specChars: options.revision.spec.length,
      revisionChars: revised.revisions.length,
      planChars: revised.plan.length,
      rewrote: revised.rewrote,
    })
    // The reply carries the rewritten proposal; only a reply that lost its
    // markers costs the second call.
    const plan = revised.rewrote
      ? revised.plan
      : stripFences(await invokeModel(modelId, PLAN_WRITER_SYSTEM,
          `ユーザーの依頼: "${options.revision.prompt}"\n追加の指示: "${prompt}"\n出力形式: ${FRAMEWORKS[outputKind].label} アプリ（複数画面・状態管理あり）\nデザインプリセット: ${presetName}\n\n設計仕様:\n${revised.spec.slice(0, 24000)}`,
          4000, null, 'plan:write'))
    return { plan, spec: revised.spec, modelTier: selectedModel.tier, preset: presetName || 'none', tokenUsage: { inputTokens: ledger.inputTokens, outputTokens: ledger.outputTokens, cacheReadTokens: ledger.cacheReadTokens, cacheWriteTokens: ledger.cacheWriteTokens } }
  }

  const { GENERATE_SPECIALISTS } = await import('./workflow-router.js')
  const specialists = [...GENERATE_SPECIALISTS]
  logger.info('Plan mode design chain', { requestId, specialists })
  if (jobId) appendJobEvent(jobId, 'routing', 'completed').catch(() => {})

  setPhase('デザインを設計中')
  /*
   * An approved plan skips the design phase at generation, so the plan is the
   * only design phase that approved build ever gets — it has to hear the
   * requirements here or not at all. Fail-open like every extraction.
   */
  const [runDesignSwarm, { agentLabel }, planRequirements] = await Promise.all([
    getRunDesignSwarm(),
    import('./strands-design.js'),
    Promise.race([
      extractRequirements(prompt),
      new Promise<Requirement[]>((resolve) => setTimeout(() => resolve([]), 15_000)),
    ]),
  ])
  const spec = await runDesignSwarm({
    prompt,
    userId,
    presetName,
    presetSpec,
    outputKind,
    modelId,
    image: imageInput,
    imageCaption: supplied.referenceCaption,
    contentImages: supplied.contentContext,
    dataContext,
    requirements: designRequirementsBlock(planRequirements),
    specialists,
    onDelta: push,
    onFocus: (id) => setPhase(agentLabel(id)),
    onAgent: (id, p) => {
      if (p === 'started') setPhase(agentLabel(id))
      if (jobId) appendJobEvent(jobId, id, p).catch(() => {})
    },
  })

  setPhase('プランをまとめ中')
  const readable = await invokeModel(modelId, PLAN_WRITER_SYSTEM,
    `ユーザーの依頼: "${prompt}"\n出力形式: ${FRAMEWORKS[outputKind].label} アプリ（複数画面・状態管理あり）\nデザインプリセット: ${presetName}\n\n設計仕様:\n${spec.slice(0, 24000)}`,
    4000, null, 'plan:write')

  logger.info('Plan produced', { requestId, specChars: spec.length, planChars: readable.length })
  return { plan: stripFences(readable), spec, modelTier: selectedModel.tier, preset: presetName || 'none', tokenUsage: { inputTokens: ledger.inputTokens, outputTokens: ledger.outputTokens, cacheReadTokens: ledger.cacheReadTokens, cacheWriteTokens: ledger.cacheWriteTokens } }
}

/**
 * Turns the machine-facing design specification into something worth reading.
 *
 * The specification is JSON running to tens of thousands of characters; nobody
 * approves that. What the user needs is the handful of decisions they might want
 * to change, stated plainly enough to disagree with.
 */
export const PLAN_WRITER_SYSTEM = `あなたはUI設計の提案を書きます。読み手は非エンジニアを含むレビュアーで、
この提案を読んで「この方針で作ってよい」と判断できることがゴールです。

日本語のMarkdownで、次の見出し構成で書いてください（該当しない見出しは省略）:

## 作るもの
1〜2文。何のためのUIで、誰が使うのか。

## 画面構成
各画面を1行で「画面名 — 何ができるか」。遷移の関係がわかるように並べる。

## デザインの方向性
ドメイン、アクセントカラー（16進数）、ニュートラルの傾向、書体、角丸と余白の密度。
それぞれ「なぜそう決めたか」を半文添える。

## 主な動作
実際に動くようにする操作を箇条書き。ボタンを押したら何が起きるかがわかる粒度で。

## 含めないもの
今回スコープ外にした判断があれば書く。無ければこの見出しごと省略。

## 前提にしたこと
依頼に書かれていなかった点で、こちらで決めたこと（件数、対象ユーザー、画面の数など）。
無ければこの見出しごと省略。

制約:
- 500〜900字。長い提案は読まれません。
- 画面構成は、各画面に「何が表示されるか（主な項目・一覧の列・ボタン）」まで書く。
  「商品一覧 — 商品を見られる」ではなく「商品一覧 — 写真・商品名・価格のカードを3列で表示、
  カテゴリと価格で絞り込み、カードを押すと詳細へ」の粒度で。
- 実装の話（ファイル構成、フレームワーク、CSSの書き方）は書かない。
- 絵文字は使わない。コードブロックも使わない。
- 「〜します」「〜にします」と、これから作る人の言葉で書く。
- 利用者に質問を返さない。決めきれない点は最も妥当な解釈を選び、「前提にしたこと」に書く。
  質問だけで終わる提案は、承認できる提案になっていません。`

/**
 * The plan for a change to something that already exists.
 *
 * The writer above is for a product that does not exist yet — 作るもの,
 * 画面構成, デザインの方向性 — and it was the writer for changes too. Handed
 * 「画像が出てないんだけどどうすべき？」 and a specification that was itself a
 * list of questions, it returned the questions, formatted.
 *
 * A change plan answers different questions: what is wrong now and why, what
 * will be changed where, and what the user will see afterwards. It is handed
 * the same PROJECT FACTS the designer was, so the cause it states is measured
 * rather than guessed.
 */
export const PLAN_CHANGE_WRITER_SYSTEM = `あなたは既存UIへの変更の提案を書きます。読み手は非エンジニアを含むレビュアーで、
この提案を読んで「この変更をしてよい」と判断できることがゴールです。

入力には、現在のソースから測った PROJECT FACTS（画面・データ・既存の指摘・画像の状況など）と、
変更の設計内容が含まれます。FACTS は推測ではなく事実です。そのまま根拠に使ってください。

日本語のMarkdownで、次の見出し構成で書いてください:

## 現状
今どうなっているか、なぜそうなっているか。FACTS から原因を具体的に書く
（例:「商品データに写真の項目が無く、12件のどれにも画像が設定されていません。一覧のカードは
写真の代わりに装飾の図形を描いています」）。依頼が「〜できない」「どうすべき？」のような
相談でも、ここで原因を特定して書く。

## 変更内容
画面・部品ごとに、何をどう変えるかを箇条書きで。「商品一覧のカード」「商品詳細の画像」のように
利用者に見える名前で書く。データの項目を追加する場合は、その項目と値の入れ方も書く。

## 変更後
利用者から見て何が変わるかを1〜3行で。

## 変更しないもの
触らない画面や機能があれば書く。無ければ省略。

## 前提にしたこと
依頼に書かれていなかった点で、こちらで決めたことがあれば書く。無ければ省略。

制約:
- 400〜900字。
- 利用者に質問を返さない。FACTS で答えられることは答え、決めきれない点は最も妥当な解釈を選んで
  「前提にしたこと」に書く。質問だけで終わる提案は、承認できる提案になっていません。
- コードやファイルの中身は書かない（ファイル名を補足として添えるのは可）。
- 絵文字、コードブロックは使わない。
- 「〜します」と、これから変更する人の言葉で書く。`

/**
 * Extracts the design decisions worth remembering from a finished document.
 *
 * Read out of the artefact rather than asked of a model: the CSS is what was
 * actually shipped, so it cannot drift from the truth, and it costs nothing.
 */
export function summariseDesignDecisions(input: {
  prompt: string
  presetName: string
  outputKind: OutputKind
  html: string
  score: number
}): string {
  const { prompt, presetName, outputKind, html, score } = input

  // Most-used colours, which in practice are the palette that was committed to.
  const counts = new Map<string, number>()
  for (const m of html.matchAll(/#([0-9a-f]{6})\b/gi)) {
    const hex = `#${m[1].toUpperCase()}`
    counts.set(hex, (counts.get(hex) ?? 0) + 1)
  }
  const palette = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([hex]) => hex)

  // Generated projects declare their scale as custom properties and then use
  // them everywhere, so reading declarations literally recorded `Type:
  // var(--font-base)` and no radius at all — true statements that tell the next
  // design phase nothing. Resolve through the variables to the actual values.
  const props = new Map<string, string>()
  for (const m of html.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)/g)) {
    if (!props.has(m[1])) props.set(m[1], m[2].trim())
  }
  const resolve = (value: string, depth = 0): string => {
    const v = value.trim()
    if (depth > 4) return v
    const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^()]+))?\)$/.exec(v)
    if (!m) return v
    return resolve(props.get(m[1]) ?? m[2] ?? '', depth + 1)
  }

  let font = ''
  for (const m of html.matchAll(/font-family\s*:\s*([^;{}]+)/gi)) {
    const first = resolve(m[1]).replace(/["']/g, '').split(',')[0].trim()
    // Keep looking if this declaration only pointed at another unresolved token.
    if (first && !first.startsWith('var(') && !first.startsWith('--')) {
      font = first
      break
    }
  }

  const radii = new Set<number>()
  for (const m of html.matchAll(/border-radius\s*:\s*([^;{}]+)/gi)) {
    for (const part of resolve(m[1]).split(/[\s/]+/)) {
      const px = /^([\d.]+)px$/.exec(part)
      const rem = /^([\d.]+)rem$/.exec(part)
      if (px) radii.add(Math.round(Number(px[1])))
      else if (rem) radii.add(Math.round(Number(rem[1]) * 16))
    }
  }
  const sorted = [...radii].filter((n) => n > 0).sort((a, b) => a - b)
  const radius = sorted.length ? `${sorted[0]}-${sorted[sorted.length - 1]}px` : ''

  const shadowed = /box-shadow\s*:\s*(?!none)\S/i.test(html)
  /**
   * Screens counted the way all three frameworks write them.
   *
   * This read `components/(\w+)(?:Screen|Page)\.tsx`, which is wrong twice: the
   * extension is React's, and the folder is not where screens live — the
   * contract puts them in `src/screens/`. So the record said nothing about
   * screens for a Vue or Svelte project, and nothing for a React one either
   * unless it had happened to file a screen under components.
   *
   * `data-screen` still counts: that is how a single-page HTML document names
   * its screens, and stored documents in that format are still read back.
   */
  const screens = new Set(
    [...html.matchAll(/data-screen="([\w-]+)"|(?:screens|components)\/(\w+)(?:Screen|Page)\.(?:tsx|jsx|vue)/g)]
      .map((m) => m[1] || m[2])
  ).size

  return [
    `Product: ${prompt.slice(0, 160)}`,
    `Preset: ${presetName}`,
    `Output: ${outputKind}`,
    palette.length ? `Palette: ${palette.join(', ')}` : '',
    font ? `Type: ${font}` : '',
    radius ? `Radius: ${radius}` : '',
    `Elevation: ${shadowed ? 'subtle shadows' : 'borders only'}`,
    screens ? `Screens: ${screens}` : '',
    `Quality: ${score}`,
  ].filter(Boolean).join('\n')
}

