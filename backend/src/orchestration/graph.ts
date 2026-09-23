import { InvokeModelCommand, InvokeModelWithResponseStreamCommand } from '@aws-sdk/client-bedrock-runtime'
import { resolveModelForPrompt, nextModelDown, type ModelChoice } from '../config/model-config.js'
import { getPresetConfig } from '../config/agentcore-config.js'
import { saveOutput } from '../services/output-storage.js'
import { saveDesignMemory } from '../tools/memory-tool.js'
import { searchDesignSystem } from '../tools/knowledge-base-tool.js'
import { createBedrockClient } from '../config/bedrock-client.js'
import { withTokenLedger, recordTokens, recordUnreportedCall, logLedger, type TokenLedger } from '../services/token-ledger.js'
import { systemField, type SystemPrompt } from './prompt-cache.js'
import { revisePlan } from './plan-revision.js'
import { RepairBudget, REPAIR_FLOOR } from './repair-budget.js'
import { applyDeterministicFixes, clampDecorativeShadows } from './deterministic-fixes.js'
import { weightedCount } from './defect-weight.js'
import { worthRepairing } from './repair-yield.js'

import { buildProjectFiles } from './build-files.js'
import { readProjectFiles, stylesheetOf, spliceStylesheet } from '../tools/project-transport.js'
import { detectKind } from '../tools/framework-compile.js'
import { auditSeedData } from './seed-data-audit.js'
import {
  fixupProject,
  salvageUnparsableStyles,
  stubUnbuildableComponents,
  unbuildableFiles,
} from '../tools/framework-fixups.js'
/**
 * Progress reporting, and what a finished generation is.
 *
 * Both types used to live in files that existed only to declare them.
 * `schemas/index.ts` was 146 lines of Zod defining nine schemas, of which one
 * produced a type through `z.infer` and none was ever `.parse()`d — a validation
 * layer that validated nothing. `plugins.ts` was 161 lines of plugin factories
 * that nothing constructed, keeping one type alive. Declared here, next to the
 * function that returns and accepts them.
 */
export interface ProgressEvent {
  type: 'agent-start' | 'agent-complete' | 'progress' | 'error'
  agent?: string
  message?: string
  timestamp: string
}

export type ProgressCallback = (event: ProgressEvent) => void

export interface FinalOutput {
  html: string
  /**
   * The chat message for this build: what was made, in the model's own words.
   *
   * `description` sat beside this and held `UI generated for: <prompt>` — the
   * request echoed back, in English, on every result. Nothing read it: the chat
   * renders `plan`, and the only other `description` in the codebase belongs to
   * the reverse-engineer result, which has its own type. Deleted rather than
   * rewritten, because a second description of the same build is a second thing
   * to keep true.
   */
  plan?: string
  qualityScore: number
  metadata: {
    generatedAt: string
    /*
     * `model` used to sit here holding the literal string
     * 'multi-agent-pipeline' — a description of the pipeline in a field named
     * for a model. Nothing read it except recordUsage, which wrote it straight
     * into the ledger's model column: 361 of 417 rows there name no model.
     *
     * The field is gone rather than corrected. `modelTier` below has always
     * carried the true answer, and a second field for the same question is how
     * the wrong one gets picked.
     */
    refinementCount: number
    /**
     * Defects the pipeline found, planned a fix for, and did not spend a call
     * on — because the run's repair budget was gone, or the file had already
     * resisted two rewrites. See repair-budget.ts.
     *
     * Carried because a defect the pipeline chose not to fix is not the same as
     * one it never found, and a result that does not say which is a result that
     * looks like the pipeline's best answer without being it. Nothing renders it
     * yet; the number exists so that showing it is a client change rather than
     * another round trip through the pipeline.
     */
    unrepairedDefects?: number
    /** `qualityScore`, decomposed — see scoring.ts `ScoreBreakdown`. */
    scoreParts?: ScoreParts
    /**
     * The request's checklist and the findings left open, as numbers.
     *
     * Both were in the reply text and nowhere else, so following quality across
     * versions meant reading chat bubbles or the log. Carried here so the version
     * row can store them — see version-history.ts.
     */
    requirements?: { total: number; met: number; unmet: number; unverified: number }
    openFindings?: number
    agentsUsed: string[]
    memoryUpdated: boolean
    knowledgeBaseHits: number
    /**
     * Where the document was archived for the measurement corpus.
     *
     * Nothing downstream reads it, which is exactly why the write it names
     * was once removed as dead. See services/output-storage.ts: the object
     * carries the preset and the score in its S3 metadata, and
     * `scripts/score-items.mjs` has no other way to know what a stored
     * document was built for.
     */
    outputKey?: string
    /**
     * What the run spent, in the four kinds it is billed in.
     *
     * The cache halves used to stop at the ledger: `token-ledger.ts` has always
     * kept them apart, and nothing carried them to `recordUsage`, so 12.8% of
     * the tokens this account is billed for over 44 runs were spent and never
     * counted against anybody's limit.
     */
    tokenUsage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
    /** Set only when the user chose `auto`: which tier ran, and why. */
    autoModel?: { tier: 'haiku' | 'sonnet' | 'opus'; reason: string }
    /**
     * Which tier actually ran, always.
     *
     * `autoModel` answers it only when the user picked `auto`, which is exactly
     * the case where the client cannot work it out for itself — and the chat
     * thread wants to say what was used on every reply, not most of them.
     * Recording "自動" against a run is not an answer to "which model built
     * this".
     */
    modelTier: 'haiku' | 'sonnet' | 'opus'
    /**
     * Set when the chosen model could not be invoked and the run continued on
     * another one.
     *
     * Separate from `modelTier`, which stays the tier that was ASKED for. The
     * two answer different questions — what the mode promised, and what built
     * this — and collapsing them would make a substituted run indistinguishable
     * from one that got what it asked for, which is the whole thing worth
     * reporting.
     */
    modelUnavailable?: { asked: string; used: string }
    /** The design system the run was bound to, or 'none'. */
    preset: string
    /**
     * Which stages this build was allowed to run.
     *
     * Reported for the same reason as the tier: a reply that skipped the design
     * phase and the repair loop looks like a worse model rather than a cheaper
     * setting, and the chat is where someone would go looking for why.
     */
    effort: Effort
    /**
     * Whether the score includes what a render measured.
     *
     * Without this the number lies by omission. Every runtime deduction — dead
     * controls, empty containers, unreachable screens, contrast, mobile overflow
     * — is skipped when there are no browser facts, so a build that never
     * rendered cannot lose points for any of them. Measured on the same brief:
     * economy scored 76 and standard 52, and the cheap one was not better. It was
     * unexamined. Two numbers on different scales in one thread would say the
     * opposite of the truth, so the client is told which scale it is holding.
     */
    scoreVerified: boolean
    /**
     * What the browser measured, for the client to show.
     *
     * The screenshot is deliberately not here: it is ~40KB of base64 against a
     * 400KB DynamoDB item, and the numbers are what a user can act on. Absent
     * when the page was never rendered, which the UI must distinguish from
     * "rendered and found nothing" — one is a missing check, the other a pass.
     */
    verification?: {
      screens: { id: string; fill: number }[]
      emptyBoxes: number
      consoleErrors: number
      /** The first few of them in words — the count says a page failed, this says how. */
      consoleErrorTexts?: string[]
      deadNav: number
      /** Buttons inside a screen that were pressed and did nothing. */
      deadActions: number
      /** Controls that raised an exception when pressed. */
      throwingControls: number
      /** Form controls that rendered too small to use. */
      smallFields: number
      /**
       * Files the pipeline replaced with a placeholder because they would not
       * build.
       *
       * The heaviest runtime deduction there is — twenty points each, up to
       * sixty — and until now the only one that was scored and never reported.
       * A document could lose forty points here and show a clean set of facts:
       * no console errors, no dead controls, nothing unreachable. Measured on a
       * Svelte result that scored 50 against 89 for the same source, where the
       * whole gap was invisible in the record.
       */
      stubbedComponents: number
      unreachable: string[]
      /** Text measured below the WCAG AA floor on the rendered page. */
      contrast: { text: string; ratio: number; required: number; overImage?: boolean }[]
      /** Sideways scroll at 390px width, in pixels. 0 when there is none. */
      mobileOverflowPx: number
      /**
       * How many screens the document said it had.
       *
       * `screens` above is what the walk opened, and the difference between the
       * two is the reach term — worth 18 points of award and up to 45 more of
       * deduction below half. Without the denominator, "screens 6" cannot be
       * read as good or bad.
       */
      declaredScreens: number
      /**
       * Whether the walk finished.
       *
       * Without it, "nothing was unreachable" and "the walk ran out of time
       * to find out" are the same record — and one is a fact about the app
       * while the other is a fact about the probe.
       */
      truncated: boolean
      /**
       * Findings still open when the pipeline stopped repairing.
       *
       * Carried out to the client because the quality score cannot say what to
       * fix: it is a proportion of a checklist, so it can read 66 without ever
       * naming which check failed. These name them.
       */
      defects: { id: string; note: string }[]
    }
  }
}
import { logger } from '../utils/logger.js'
import { replyWithOutcome, projectFileCounts } from './reply-text.js'
import { extractRequirements, checkRequirements, requirementDefects, requirementsBlock, designRequirementsBlock, summarizeRequirements, type Requirement } from './requirements.js'
import {
  parseImageInput,
  userContentWithImage,
  embedUserImage,
  imageDirective,
  imageCaptionNote,
  isEmbeddable,
  MAX_EMBEDDED_IMAGE_CHARS,
  USER_IMAGE_TOKEN,
  type ImageInput,
} from '../utils/image-input.js'
import {
  parseContentImages,
  contentImageDirective,
  splitByRole,
  embedContentImages,
  stripContentImageTokens,
} from '../utils/content-images.js'
import { captionImages } from './image-captions.js'
import { prepareSuppliedImages, singleImageCaption } from './supplied-images.js'
import { parseAttachment, attachmentDirective, type RawAttachment } from '../utils/data-attachment.js'
import { appendJobEvent, tokenHeartbeat, updateJobStream } from '../services/job-service.js'
import { allowedModelsForRun } from '../services/token-usage.js'
import {
  auditInteractivity,
  auditShellContract,
  declaredScreenIds,
  screenLabels,
  specScreenTitle,
  type InteractionDefect,
} from './interaction-audit.js'
import { diagnoseForChange } from './change-diagnosis.js'
import { auditRuntime, navigatedToInCode, pageFrozenDefect, summariseRuntime, runtimeRegressions } from './runtime-audit.js'
import { critiqueScreenshot } from './visual-critic.js'
import { verifyInBrowser, type VerifyFailure } from '../tools/browser-verify.js'
import {
  toRunnableDocument,
  normalizeReactExtensions,
  addMissingBarrels,
  moduleDefects,
  unresolvedComponentDefects,
  destructuredKeyDefects,
  missingItemKeyDefects,
  conditionalHookDefects,
  truncatedDocumentDefects,
  rootPropsNeverPassedDefects,
  requiredPropNeverPassedDefects,
  frameworkConfusionDefects,
  normalizeRouterLinks,
  missingExports,
} from '../tools/react-bundle.js'
import { keepRejectedCandidate } from '../utils/rejected-candidate.js'
import { repairSyntax, syntaxDefects } from './syntax-repair.js'
import { effortProfile, type Effort } from '../config/effort.js'
import { FRAMEWORKS } from '../config/frameworks.js'
import { pickStockImages, stockImageInstructions, hasStockLibrary, repairStockUrls } from '../tools/stock-images.js'
import { assignItemImages } from '../tools/assign-images.js'
import { resolveSubjects } from '../tools/subject-resolve.js'
import { auditAiTells } from './design-audit.js'
import { auditDesignSystem } from './design-system-audit.js'
import { snapRadii, snapMotion } from './preset-conformance.js'
import { shellRequirement } from './preset-composition.js'
import { applyPresetFoundation, snapFontFamilies, snapComponentSizes, measureComponentDrift, foundationPromptBlock, presetFoundation, presetScaleNote, withoutTokenDeclarations } from './preset-foundation.js'
// Loaded on demand: pulls in the Strands SDK, which the Lambda fallback path never needs.
const getRunDesignSwarm = () => import('./strands-design.js').then((m) => m.runDesignSwarm)

/** Minimum gap between in-flight stream writes to DynamoDB. */
/** The multi-agent design phase is only affordable where there is no 900s ceiling. */
const DESIGN_SWARM_ENABLED = process.env.DESIGN_SWARM_ENABLED === '1'
/**
 * Rendering the document costs a browser session and roughly 30 seconds per
 * check, and the repair path runs it twice. Behind a flag so it can be turned
 * off without a deploy if it ever misbehaves in front of users — the same
 * treatment the design graph gets.
 */
const BROWSER_VERIFY_ENABLED = process.env.BROWSER_VERIFY_ENABLED === '1'

const STREAM_FLUSH_MS = 900

/**
 * Remove markdown code fences wherever they appear.
 *
 * Stripping only at position 0 stopped working once the model began writing a
 * plan before the document: the fence then sits mid-text, so it survived into the
 * plan shown in the chat.
 */
export function stripFences(text: string): string {
  return text
    .replace(/^[ 	]*```[a-zA-Z]*[ 	]*$/gm, '')   // fence on its own line
    .replace(/```[a-zA-Z]*/g, '')                   // any stragglers
    .trim()
}

const bedrockClient = createBedrockClient()

/**
 * How much of the document the repair passes are shown.
 *
 * The repair re-emits the whole document, so anything past this point is simply
 * dropped. It is named rather than inlined because the acceptance test has to use
 * the same number: a repair is only judged against the length it was given.
 */
const REPAIR_INPUT_LIMIT = 120000

/**
 * How many times the defect repair may run.
 *
 * One pass was measured fixing 3 defects out of 4 and stopping there, with the
 * fourth shipping. Repair has real feedback — it is told exactly what is still
 * wrong and the result is re-measured — so repeating it converges, which is the
 * difference between this and "regenerate until the score is high enough".
 * That has no feedback at all: the same prompt, resampled, until a number comes
 * up. Measured over 16 runs, 90+ came up 37.5% of the time, so it is a bounded
 * loop only in the sense that a coin toss is.
 *
 * Three is where the loop stops paying: a pass costs a model call plus two
 * renders, around 140 seconds.
 *
 * The count now comes from the effort profile rather than from here — three is
 * what `standard` uses, the cheap profiles use none, and `thinking` uses five.
 * Raising the ceiling is safe because the loop already stops on the first pass
 * that fails to improve; it does not spend what it is given.
 */

/**
 * No repair pass may START after this much of the run has gone.
 *
 * The client stops polling at 30 minutes and shows "Generation timed out", so a
 * pipeline that runs past it destroys the whole generation rather than shipping
 * an imperfect one. Generation itself takes 9-12 minutes; this leaves room for a
 * pass to finish well inside the window.
 */
const REPAIR_BUDGET_MS = 20 * 60_000

/**
 * How many single-file reverts a breaking repair pass may try — see
 * `revertSuspects`. A browser run is six to eight seconds; four is under a
 * minute in the worst case, and the suspects are ordered so the first is
 * usually the one.
 */
const MAX_SINGLE_REVERTS = 4

/**
 * The first sentence of a repair instruction, for showing to the user.
 *
 * Instructions are written for the model that has to act on them — several
 * sentences, often naming files. The first one says what is wrong; the rest say
 * how to fix it, which is not the user's job.
 */
/**
 * What a defect says in the chat: its own wording where it has one.
 *
 * `note` is written for a reader; `instruction` is written for the repair model
 * and is only clipped to fit. The fallback stays because most instructions read
 * perfectly well as findings — see the note field's own comment.
 */
function readerNote(d: { id: string; instruction: string; note?: string }): string {
  return d.note ?? shortNote(d.instruction)
}

function shortNote(instruction: string): string {
  const first = instruction.split(/(?<=。)/)[0].trim()
  const head = first.length > 90 ? `${first.slice(0, 89)}…` : first

  /*
   * Keep the first piece of evidence, where there is one.
   *
   * Several instructions open with a generic sentence and then list what was
   * actually measured. Taking only the first sentence stores
   * 「ページを実行するとJavaScriptエラーが発生します。」 and drops the error — so a
   * blank render is recorded with nothing that explains it. Measured: diagnosing
   * one took a second browser session to recover a line the run already had.
   */
  const evidence = /\n\s*-\s*(.+)/.exec(instruction)?.[1]?.trim()
  if (!evidence) return head
  const clipped = evidence.length > 120 ? `${evidence.slice(0, 119)}…` : evidence
  return `${head} ${clipped}`
}

/**
 * Model ids this container has proved it cannot invoke, and what it used instead.
 *
 * A run picks one model and then makes about thirty-five calls with it. When the
 * account cannot invoke that model, the first of those throws
 * `AccessDeniedException` and the whole generation ends with nothing — which is
 * what 思考モード does today, because it asks for Opus and no Opus this account
 * can reach is permitted to the runtime role.
 *
 * Retrying does not help and neither does waiting: the answer is identical every
 * time, which is exactly why `failure-message.ts` refuses to suggest a retry for
 * this class. The only useful response is to build the UI on the next model down
 * and say so.
 *
 * The map is per-container rather than per-run because the fact is not about the
 * run. A model the ACCOUNT cannot invoke is unusable for every request that
 * container serves, and re-learning it costs each of them a failed call.
 *
 * It is deliberately not seeded from configuration. A guessed list goes stale in
 * the quiet direction — it would have to be edited on the day access is granted,
 * by someone who has no reason to look here — whereas a list learned from the
 * refusal is empty exactly when there is nothing to avoid.
 */
const unusableModels = new Map<string, string>()

/** Whether a run's chosen model was swapped out, so the metadata can report it. */
export function modelSubstitution(modelId: string): string | undefined {
  return unusableModels.get(modelId)
}

/** Bedrock refusing the model itself, as opposed to refusing this request. */
function isModelRefusal(e: unknown): boolean {
  const name = (e as { name?: string })?.name ?? ''
  const message = e instanceof Error ? e.message : String(e)
  return (
    (name === 'AccessDeniedException' || /AccessDeniedException/.test(message)) &&
    /model|inference.profile/i.test(message)
  )
}

/**
 * Run a Bedrock call, and if the model itself is refused, run it again on the
 * next model down.
 *
 * Both invoke paths go through here so the streaming one cannot be forgotten —
 * it is the single call that assembles the whole document, so a fallback that
 * covered only the non-streaming path would recover every step of a run except
 * the one that produces the UI.
 *
 * One step, not a ladder. Two refusals in a row means something is wrong with
 * the configuration rather than with one model, and quietly walking down to
 * Haiku would answer 思考モード with the cheapest thing in the building.
 */
async function withModelFallback<T>(
  modelId: string,
  where: string,
  call: (id: string) => Promise<T>
): Promise<T> {
  const known = unusableModels.get(modelId)
  if (known) return call(known)
  try {
    return await call(modelId)
  } catch (e) {
    if (!isModelRefusal(e)) throw e
    const down = await nextModelDown(modelId)
    if (!down) throw e
    unusableModels.set(modelId, down)
    logger.warn('The chosen model cannot be invoked; the run continues on the next one down', {
      modelId,
      using: down,
      where,
      error: e instanceof Error ? e.message : String(e),
    })
    return call(down)
  }
}

/**
 * Same contract as invokeModel, but consumes the response as a stream and reports
 * the text as it arrives. Used for the long code-assembler step so the client can
 * show the response being written instead of a spinner.
 *
 * onDelta is throttled by the caller — it is not called per token.
 */
async function invokeModelStreaming(
  modelId: string,
  systemPrompt: string | SystemPrompt,
  userMessage: string,
  onDelta: (fullText: string) => void,
  maxTokens = 64000,
  image: ImageInput | null = null,
  /**
   * Which stage is spending this.
   *
   * Defaulted rather than required so no call site is forced to be updated in
   * the same change, and every one that is not shows up in the ledger under
   * `unattributed` — which is a gap you can see and act on, unlike the single
   * total this replaces.
   */
  where = 'unattributed'
): Promise<string> {
  const response = await withModelFallback(modelId, where, (id) =>
    bedrockClient.send(new InvokeModelWithResponseStreamCommand({
      modelId: id,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: maxTokens,
        system: systemField(systemPrompt),
        messages: [{ role: 'user', content: userContentWithImage(userMessage, image) }],
      }),
    })))

  let text = ''
  let stopReason: string | undefined
  /**
   * Usage arrives in two places on a stream: the input count with
   * `message_start`, the output count with the final `message_delta`. Reading
   * only one of them is how a streamed call ends up billed at zero.
   */
  let cacheRead = 0
  let cacheWrite = 0
  let inputTokens = 0
  let outputTokens = 0
  for await (const event of response.body ?? []) {
    const bytes = event.chunk?.bytes
    if (!bytes) continue
    let payload: any
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      continue
    }
    if (payload.type === 'message_start') {
      inputTokens = payload.message?.usage?.input_tokens ?? 0
      outputTokens = payload.message?.usage?.output_tokens ?? 0
      cacheRead = payload.message?.usage?.cache_read_input_tokens ?? 0
      cacheWrite = payload.message?.usage?.cache_creation_input_tokens ?? 0
    } else if (payload.type === 'content_block_delta' && typeof payload.delta?.text === 'string') {
      text += payload.delta.text
      onDelta(text)
    } else if (payload.type === 'message_delta') {
      if (payload.delta?.stop_reason) stopReason = payload.delta.stop_reason
      if (typeof payload.usage?.output_tokens === 'number') outputTokens = payload.usage.output_tokens
    }
  }

  if (inputTokens || outputTokens) recordTokens(inputTokens, outputTokens, where, { read: cacheRead, write: cacheWrite })
  else recordUnreportedCall(`invokeModelStreaming:${where}`)

  if (stopReason === 'max_tokens' && text) {
    logger.warn('Model output truncated at max_tokens, using partial output', { modelId, outputLength: text.length })
  }
  return text
}

async function invokeModel(
  modelId: string,
  systemPrompt: string | SystemPrompt,
  userMessage: string,
  maxTokens = 64000,
  image: ImageInput | null = null,
  where = 'unattributed'
): Promise<string> {
  const response = await withModelFallback(modelId, where, (id) =>
    bedrockClient.send(new InvokeModelCommand({
      modelId: id,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: maxTokens,
        system: systemField(systemPrompt),
        messages: [{ role: 'user', content: userContentWithImage(userMessage, image) }],
      }),
    })))
  const body = JSON.parse(new TextDecoder().decode(response.body))
  const text = body.content?.[0]?.text ?? ''
  if (typeof body.usage?.input_tokens === 'number') {
    recordTokens(body.usage.input_tokens, body.usage.output_tokens ?? 0, where, {
      read: body.usage.cache_read_input_tokens ?? 0,
      write: body.usage.cache_creation_input_tokens ?? 0,
    })
  } else {
    recordUnreportedCall(`invokeModel:${where}`)
  }
  if (body.stop_reason === 'max_tokens' && text) {
    logger.warn('Model output truncated at max_tokens, using partial output', { modelId, outputLength: text.length })
  }
  return text
}

/**
 * The same call, for the one stage that sends more than one image.
 *
 * `invokeModel` takes a single `ImageInput` and builds its content through
 * `userContentWithImage`, which is the right shape for the reference image and
 * cannot express several. Rather than widen a signature every other call site
 * uses, this takes the content blocks already assembled.
 *
 * Its only caller is the captioner. Everything else in the pipeline reads the
 * captions rather than the pictures — see `utils/content-images.ts` — so if a
 * second caller ever appears here, the question to ask first is whether it
 * really needs to look.
 *
 * The usage recording is a copy of `invokeModel`'s deliberately: a call that
 * reports nothing is spend nobody can see, and this file has already paid for
 * that lesson four times over.
 */
async function invokeVision(
  modelId: string,
  systemPrompt: string,
  content: Array<Record<string, unknown>>,
  maxTokens: number,
  where: string
): Promise<string> {
  const response = await withModelFallback(modelId, where, (id) =>
    bedrockClient.send(new InvokeModelCommand({
      modelId: id,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content }],
      }),
    })))
  const body = JSON.parse(new TextDecoder().decode(response.body))
  if (typeof body.usage?.input_tokens === 'number') {
    recordTokens(body.usage.input_tokens, body.usage.output_tokens ?? 0, where, {
      read: body.usage.cache_read_input_tokens ?? 0,
      write: body.usage.cache_creation_input_tokens ?? 0,
    })
  } else {
    recordUnreportedCall(`invokeVision:${where}`)
  }
  return body.content?.[0]?.text ?? ''
}

/*
 * The presets and the imported-system registry live in `design-presets.ts`.
 *
 * They were 741 lines here — six specification documents and their
 * signatures — sitting between the model plumbing above and the scoring
 * below, and shared nothing with either. Re-exported rather than merely
 * imported so that every existing `from './graph.js'` keeps working: this is
 * a move, not a change of surface.
 */
export {
  resolveUserDesignSystem,
  getPresetSpec,
  presetRadii,
  presetMotion,
  presetConformance,
} from './design-presets.js'
import {
  resolveUserDesignSystem,
  getPresetSpec,
  presetRadii,
  presetMotion,
  presetConformance,
} from './design-presets.js'

/**
 * Re-exported so the many callers that already import from here keep working.
 * `auto` lets the brief pick the tier — see `resolveModelForPrompt`. Every other
 * value names a tier directly. Defined once, in model-config.
 */
export type { ModelChoice }

/** 'html' = a single static page. 'react' = a multi-file React app with routing and state. */
/**
 * The frameworks a project can be generated in. HTML is gone: it was one
 * self-contained file, which shared none of the machinery the project formats
 * share, and every path carried an "or else it is HTML" branch for it.
 */
export type { OutputKind } from '../config/frameworks.js'
import { DEFAULT_OUTPUT_KIND, type OutputKind } from '../config/frameworks.js'

/**
 * How much of the design specification the build is allowed to see.
 *
 * This was a bare `designPlan.slice(0, 20000)`, and it was the single largest
 * quality leak in the pipeline. A measured five-specialist run produced a 68,308
 * character specification; the assembler read 20,000 of it. Everything the
 * visual designer decided about composition, everything the content designer
 * wrote, and every correction the critic made was cut off before the build —
 * which is exactly the material that separates a designed page from a generic
 * one, and exactly what the design phase was spending minutes to produce.
 *
 * The ceiling now sits where a real constraint is. A 120k-character
 * specification is roughly 60-80k tokens of Japanese against a 200k context that
 * also carries a ~30k character system prompt, so this bounds a runaway spec
 * without touching any specification the phase has ever actually produced.
 *
 * And when it does bite, it says so. A silent slice is how this survived: the
 * logs showed a large spec produced and a build running, with nothing anywhere
 * recording that most of the first never reached the second.
 */
const SPEC_BUILD_LIMIT = 120_000

/**
 * The routers run on the cheapest model, whatever the build runs on.
 *
 * They return one JSON object — which specialists to use, which files a defect
 * belongs to. That is a classification, and the model router next door has
 * always been classified by Haiku for exactly this reason: choosing Opus is not
 * a decision worth Opus. These two were the exception, so a brief that routed to
 * Opus paid Opus rates to have a list of specialist names put in order.
 *
 * One of the two — the specialist router — is gone entirely; it returned a
 * constant. The other, the file-repair planner, named this function in its
 * justification and then called the generation model anyway for 67 calls a
 * fortnight. It calls this now.
 *
 * Not a token saving — the calls are small either way — but a direct one in
 * money, and there is nothing on the other side of the trade.
 */
async function routerModelId(): Promise<string> {
  const { getModelConfig } = await import('../config/agentcore-config.js')
  return (await getModelConfig()).haikuId
}

function specForBuild(spec: string, requestId: string): string {
  if (spec.length <= SPEC_BUILD_LIMIT) return spec
  logger.warn('Design specification truncated for the build', {
    requestId,
    specChars: spec.length,
    limit: SPEC_BUILD_LIMIT,
    droppedChars: spec.length - SPEC_BUILD_LIMIT,
  })
  return spec.slice(0, SPEC_BUILD_LIMIT)
}

export interface GenerateUIOptions {
  prompt: string
  userId: string
  preset?: string
  model?: ModelChoice
  image?: string
  /**
   * Pictures to put IN the UI, as opposed to `image` above, which is the one
   * attachment the design phase and the build actually look at.
   *
   * These are never shown to a model. Each is captioned once and the captions
   * travel as text; see `utils/content-images.ts` for the arithmetic that
   * decides it. Base64, same shapes `image` accepts.
   */
  images?: string[]
  /**
   * What each picture shows, when the user said so.
   *
   * Aligned with `images` by index. A described picture is never sent to the
   * captioner — see utils/content-images.ts — so a fully described attachment
   * set costs no vision call at all.
   */
  imageCaptions?: string[]
  jobId?: string
  outputKind?: OutputKind
  /**
   * A design specification the user already reviewed and accepted in plan mode.
   * Supplied here it replaces the design phase outright, so the build is of the
   * plan they approved rather than a fresh and possibly different reading of the
   * same prompt.
   */
  approvedPlan?: string
  /**
   * A data file the user attached — the records the screens should actually be
   * built from, rather than records the model invents. Distilled to a sample
   * before it reaches any prompt; see utils/data-attachment.ts.
   */
  attachment?: RawAttachment
  /**
   * How much time and money this build may spend. See config/effort.ts for what
   * each profile turns off. Absent means `standard`, which is what every build
   * did before the setting existed.
   */
  effort?: Effort
  onProgress?: ProgressCallback
  /**
   * Switches for a measured comparison, set only by a direct Runtime invocation —
   * the API strips the field before dispatch.
   *
   * `requirementBriefing: false` withholds the checklist from the design phase
   * and the named screens from the build, as generation ran before 2026-09-14,
   * while still extracting and checking the requirements so both arms report
   * the same numbers. It exists for one question: whether stating requirements
   * to the design phase is what cost the inventory brief 20 points on three runs.
   */
  experiment?: { requirementBriefing?: boolean }
}

export { FORM_CONTROL_SIZING } from './prompt-contracts.js'
import { FORM_CONTROL_SIZING } from './prompt-contracts.js'

/*
 * The assembler's prompt documents live in `prompt-contracts.ts` — 754 lines
 * of prose the pipeline hands to a model and never reasons about. Re-exported
 * so every existing `from './graph.js'` keeps working: this is a move.
 */
export { SCREEN_COMPLETENESS, stylesheetContract, projectContract } from './prompt-contracts.js'
import { outputSpecFor, stylesheetContract, projectContract, SCREEN_COMPLETENESS } from './prompt-contracts.js'

/*
 * The scorers live in `scoring.ts` — 597 lines that read nothing this file
 * declares. Re-exported so every existing `from './graph.js'` keeps working.
 */
export { scoreHtml, isRoutingFile, withoutRoutingChanges, withoutFiles, revertSuspects, type ScoreRuntime } from './scoring.js'
import { scoreBreakdown, withoutRoutingChanges, withoutFiles, revertSuspects } from './scoring.js'
import type { ScoreParts } from './scoring.js'
import { isModelUnavailable } from '../utils/failure-message.js'

/**
 * Main UI generation pipeline using Strands Agents SDK patterns:
 *
 * 1. **Graph** (DAG): Main pipeline with parallel fan-out, fan-in, conditional branching, cycles
 * 2. **Swarm**: Component Designer (4 sub-agents with autonomous handoffs)
 * 3. **Swarm**: Review phase (A11y + Quality reviewers collaborate)
 * 4. **Agents-as-Tools**: Meta-orchestrator uses specialist agents as callable tools
 */
/**
 * Establishes the token ledger, then runs the build inside it.
 *
 * Split in two so the ledger's lifetime is exactly one generation. Every model
 * call made anywhere below this line — including inside the Strands design
 * graph, which is a separate module — reports into it without being passed
 * anything.
 */
export async function generateUI(options: GenerateUIOptions): Promise<FinalOutput> {
  return withTokenLedger(async (ledger) => {
    // The running total for the progress transcript — see tokenHeartbeat.
    const heartbeat = options.jobId ? tokenHeartbeat(options.jobId, () => ledger.inputTokens + ledger.outputTokens) : null
    if (heartbeat) ledger.onRecord = heartbeat.notify
    try {
      return await runGeneration(options, ledger)
    } finally {
      if (heartbeat) await heartbeat.flush()
      // Written in `finally` so a failed run still says what it spent. A run
      // that dies after the design phase is exactly the one worth costing.
      logLedger(ledger, { run: 'runGeneration' })
    }
  })
}

async function runGeneration(options: GenerateUIOptions, ledger: TokenLedger): Promise<FinalOutput> {
  const { prompt, userId, preset, model: modelChoice, image, images, imageCaptions, jobId, outputKind = DEFAULT_OUTPUT_KIND, approvedPlan, attachment, effort, experiment } = options
  const requestId = crypto.randomUUID()
  const briefRequirements = experiment?.requirementBriefing !== false
  if (!briefRequirements) logger.info('Experiment: requirements withheld from design and screen names from the build', { requestId })
  const startTime = Date.now()
  const userSystem = await resolveUserDesignSystem(preset, userId, requestId)
  const { presetName } = await getPresetConfig(userSystem ?? preset)

  /**
   * The stages this build is allowed to run.
   *
   * The environment flags stay as a separate gate rather than being folded in:
   * they say what this deployment *can* do, and the profile says what this
   * request *wants*. Both have to agree, so a profile asking for verification on
   * a deployment with no browser configured simply does not get it, and nothing
   * has to know about the other's reasons.
   */
  const profile = effortProfile(effort)
  const useDesignGraph = DESIGN_SWARM_ENABLED && profile.designGraph
  const useBrowserVerify = BROWSER_VERIFY_ENABLED && profile.browserVerify
  logger.info('Build effort', {
    requestId,
    effort: effort ?? 'standard',
    designGraph: useDesignGraph,
    browserVerify: useBrowserVerify,
    repairPasses: profile.repairPasses,
    visualCritic: profile.visualCritic,
  })

  const log = (agent: string) => {
    logger.info('Agent started', { requestId, agent })
    if (jobId) appendJobEvent(jobId, agent, 'started').catch(() => {})
  }
  const done = (agent: string, t: number) => {
    logger.info('Agent completed', { requestId, agent, duration: Date.now() - t })
    if (jobId) appendJobEvent(jobId, agent, 'completed').catch(() => {})
  }

  // Retrieve shared context upfront.
  //
  // Memory is deliberately NOT fetched here. It is consumed by the design phase
  // (`runDesignSwarm`), which retrieves it itself; the copy that used to be
  // fetched on this line was assigned to a variable nothing read, so every
  // generation paid for a retrieval it threw away.
  // Retrieval is cheap to call and not cheap to carry: the result becomes prompt
  // input on every later call in the run, so the economy profile skips it.
  const designDocs = profile.knowledgeBase
    ? await searchDesignSystem(`UI design patterns for: ${prompt}`, {
        preset: presetName,
        maxResults: 5,
      }).catch(() => [] as any[])
    : ([] as any[])
  const designSystemDocs = designDocs.map((d: any) => d.content).join('\n---\n')

  // === Get model configs ===
  // `auto` classifies the brief on the cheapest model and picks a tier from it.
  /**
   * The administrator's ceiling is applied here, not at the API edge.
   *
   * Every path that generates — the API, the worker fallback, the Runtime —
   * arrives at this line, and only this line knows both the user and the model
   * about to be used. Clamping at the edge would have to be repeated on each
   * route and would be one refactor away from being skipped on a new one.
   *
   * The user's, and nobody else's. Three of the four old modes overrode this —
   * see the note at the end of config/effort.ts — which made the mode menu and
   * the model picker two controls for one decision, with one of them silently
   * winning. A mode now decides how much checking runs and nothing else.
   *
   * `auto` still reaches the brief-reading router, and the permitted set still
   * clamps the result, so a choice cannot hand out a model the user may not
   * use.
   */
  const selectedModel = await resolveModelForPrompt(
    modelChoice,
    prompt,
    await allowedModelsForRun(userId)
  )
  const modelId = selectedModel.modelId
  if (selectedModel.autoReason) {
    logger.info('Auto-selected model', {
      requestId,
      tier: selectedModel.tier,
      modelId,
      reason: selectedModel.autoReason,
    })
  }

  const presetSpec = presetName === 'none' ? '' : getPresetSpec(presetName)
  /*
   * The request as a checklist, started now and awaited just before the build.
   *
   * Concurrent with the design phase, which takes minutes, so on the checked
   * profile it adds no wall-clock at all; the one Haiku call is long finished by
   * the time the build needs it. See orchestration/requirements.ts for why it is
   * a model call and why the checking is not.
   */
  const requirementsPromise = extractRequirements(prompt)
  let requirements: Requirement[] = []

  /**
   * The attachment, parsed once and sent with the calls that can act on it.
   *
   * `imageContext` used to be the ONLY thing the image produced: a sentence saying
   * a reference image had been provided, added to prompts whose messages carried no
   * image at all. So the model was told to take layout and palette from something it
   * could not see, and filled the gap by inventing one — output that looks like it
   * followed a reference while ignoring it. The sentence is now derived from whether
   * the bytes actually attached, so the prompt cannot claim more than the request holds.
   */
  let imageInput = parseImageInput(image)
  if (image && !imageInput) {
    logger.warn('Attached image could not be parsed and was dropped', { requestId })
  }
  /**
   * An attachment can mean two different things, and only the prompt says which.
   *
   * "この画像のデザインを踏襲して" is a reference: read the design off it.
   * "この商品画像を使って" is content: the image itself belongs on the screen.
   * Nothing in the request distinguishes them, but the model has both the words and
   * the picture, so it decides — and gets a marker to place when the answer is
   * "content". The marker is substituted for the real data URI after the build,
   * because a data URI is base64 and a model copying one out is both ruinously
   * expensive and one mistyped character away from a silently broken image.
   */
  let canEmbedImage = isEmbeddable(imageInput)
  if (imageInput && !canEmbedImage) {
    logger.info('Image too large to embed; using it as a design reference only', {
      requestId,
      chars: imageInput.base64.length,
      limit: MAX_EMBEDDED_IMAGE_CHARS,
    })
  }
  /*
   * The pictures the user wants ON the screen, which is a different job from
   * the reference above.
   *
   * Captioned on Haiku regardless of the tier this run is on: describing a
   * photograph is not the task the model was chosen for, and this is the only
   * call in the pipeline that carries image bytes — see the note in
   * `utils/content-images.ts` for why it is also the only one that needs to.
   */
  const { images: contentImages, dropped: droppedImages } = parseContentImages(images, imageCaptions)
  if (droppedImages.length > 0) {
    logger.info('Some supplied images were not accepted', {
      requestId,
      accepted: contentImages.length,
      dropped: droppedImages.map((d) => `${d.at}:${d.reason}`),
    })
  }
  /*
   * Only parsed here. The captioning call is below, once `setPhase` exists, so
   * the user sees a step rather than a silent pause on a request with eight
   * photographs attached.
   */
  let contentContext = ''
  // A lone picture's description; replaced by the caption of a promoted picture below.
  let referenceCaption = singleImageCaption(images, imageCaptions)
  let imageContext = imageDirective(imageInput, canEmbedImage, referenceCaption)
  const kbContext = designSystemDocs ? `\n\nAdditional design system context:\n${designSystemDocs.slice(0, 1500)}` : ''
  /**
   * The user's own data, sampled.
   *
   * It goes to the design phase as well as the build, because the record count
   * changes what the screen IS — a list of six rows and a list of four thousand
   * are different designs, and only the design phase decides that. Handing it
   * only to the build would produce the six-row screen filled with real values,
   * which looks right and is the wrong screen.
   */
  const dataAttachment = parseAttachment(attachment)
  if (attachment && !dataAttachment) {
    logger.warn('Attached data file could not be read and was dropped', { requestId, name: attachment.name })
  }
  const dataContext = attachmentDirective(dataAttachment)
  if (dataAttachment) {
    logger.info('Data attachment sampled for the prompts', {
      requestId,
      name: dataAttachment.name,
      kind: dataAttachment.kind,
      totalRecords: dataAttachment.totalRecords,
      shownRecords: dataAttachment.shownRecords,
      excerptChars: dataAttachment.excerpt.length,
    })
  }

  logger.info('Pipeline starting', { requestId, userId, preset: presetName })
  /**
   * What this run spends, as the models report it.
   *
   * Every model call in the pipeline — the design graph, the assembler, the
   * critics, each repair — lands here through the AsyncLocalStorage ledger, so
   * nothing has to be threaded through the call sites and nothing is left out by
   * forgetting to. This replaced seven `text.length / 4` estimates that between
   * them measured the output document and missed the design phase entirely.
   */

  // Step 0: Analyzing request
  let t = Date.now()
  log('analyzing')
  done('analyzing', t)

  // Step 1: Design plan
  t = Date.now()
  log('design-analyst')

  /**
   * Throttled writer for whatever step is currently producing text.
   *
   * Every phase shares one writer so the chat shows a continuous stream instead
   * of going silent between steps — the design phase alone can run for minutes.
   */
  let lastStreamWrite = 0
  let streamInFlight = false
  let streamPhase = ''
  const pushStream = (full: string) => {
    if (!jobId) return
    const now = Date.now()
    if (streamInFlight || now - lastStreamWrite < STREAM_FLUSH_MS) return
    lastStreamWrite = now
    streamInFlight = true
    updateJobStream(jobId, full, full.length, streamPhase)
      .catch(() => {})
      .finally(() => { streamInFlight = false })
  }
  /**
   * Announce the step, then let its output flow.
   *
   * The label used to be recorded only when the *next* stream write happened, so
   * any step that finished without emitting tokens — routing, or a build that
   * skips design because a plan was approved — never appeared in the transcript
   * at all. Writing it immediately makes every step visible, whether or not it
   * has anything to say.
   *
   * The writes are chained rather than fired in parallel. Two consecutive steps
   * can be microseconds apart (finalize hands straight to the preset check), and
   * two unawaited UpdateItem calls on the same key have no ordering guarantee —
   * so the earlier label could land last and strand the transcript on a step that
   * had already finished. Observed exactly that before chaining them.
   */
  let phaseWrites: Promise<unknown> = Promise.resolve()
  const setPhase = (label: string) => {
    streamPhase = label
    lastStreamWrite = 0 // let the new phase's first token through immediately
    if (jobId) phaseWrites = phaseWrites.then(() => updateJobStream(jobId, '', 0, label)).catch(() => {})
  }

  // Opening label, so the transcript is populated from the first poll rather than
  // sitting empty through the seconds before the first step produces text.
  setPhase('依頼内容を解析中')

  /*
   * Describe the supplied pictures, once.
   *
   * On Haiku regardless of the tier this run is on: describing a photograph is
   * not the task the model was chosen for. This is the only call in the pipeline
   * that carries image bytes — `utils/content-images.ts` has the arithmetic for
   * why it is also the only one that needs to.
   *
   * `contentContext` is appended to `imageContext` rather than threaded
   * separately, so the two places that already read it — the single-call design
   * fallback and the build — receive it with no second wiring to keep in step.
   * The Strands design phase builds its own directive and is handed
   * `contentContext` directly.
   */
  let placeableImages = contentImages
  if (contentImages.length > 0) {
    setPhase('画像を確認中')
    const captionModelId = await routerModelId()
    await captionImages(contentImages, prompt, (system, content, maxTokens) =>
      invokeVision(captionModelId, system, content, maxTokens, 'images:caption'))
    /*
     * One of them may be a reference, if the user asked for one.
     *
     * The captioner decides this from the prompt, in the call it was already
     * making — it has the words and the pictures in front of it, so a role per
     * image costs a few output tokens and no extra input. It defaults to
     * content and only says otherwise when the request asked in so many words.
     *
     * A promoted image LEAVES the content list. It is handled from here by the
     * reference path, which already offers both readings through the bare
     * `{{USER_IMAGE}}` marker — so "use this as the reference and also show it"
     * still works, and no picture is described in two places at once.
     *
     * An explicit `image` on the request wins: it is the slot the caller
     * deliberately filled, and overwriting it from a guess about the prompt
     * would make the request mean something the caller did not write. In
     * practice the composer sends one or the other, never both.
     */
    const split = splitByRole(contentImages)
    if (split.demoted.length > 0) {
      logger.info('More than one image was read as a reference; keeping the first', {
        requestId,
        kept: split.reference?.index,
        demotedToContent: split.demoted,
      })
    }
    if (split.reference && !imageInput) {
      imageInput = split.reference
      referenceCaption = split.reference.caption
      canEmbedImage = isEmbeddable(imageInput)
      placeableImages = split.content
      logger.info('An attached image is being used as the design reference', {
        requestId,
        index: split.reference.index,
        caption: split.reference.caption || '(none)',
        placing: placeableImages.length,
      })
    } else if (split.reference) {
      logger.info('Ignoring a reference role: the request already carries a reference image', {
        requestId,
        ignored: split.reference.index,
      })
    }
    /*
     * Built AFTER the split, so the reference is not also listed as something to
     * place, and rebuilt from `imageInput` because the promotion may have filled
     * a slot that was empty when the directive was first composed.
     */
    contentContext = contentImageDirective(placeableImages)
    imageContext = imageDirective(imageInput, canEmbedImage, referenceCaption) + contentContext
  }

  const designAnalystSystem = presetSpec
    ? `You are a world-class UI/UX designer at a top design agency. You create pixel-perfect designs that match real production apps like those on Dribbble, Awwwards, and Apple.com.

════════════════════════════════════════════════════
MANDATORY DESIGN SYSTEM — COPY THESE VALUES EXACTLY:
════════════════════════════════════════════════════
${presetSpec}
════════════════════════════════════════════════════

STRICT RULES:
- colorScheme: COPY the EXACT hex values from the design system above verbatim. Do NOT invent new colors.
- typography: COPY the EXACT font family, sizes, and weights specified above.
- spacing/border-radius/shadows: COPY the EXACT values from the design system.
- Example: If the design system says "Primary #0017C1", your colorScheme.primary MUST be "#0017C1".
- Example: If the design system says font "Noto Sans JP", typography.fontFamily MUST include "Noto Sans JP".

Output a comprehensive JSON design specification. ALL design token values MUST come directly from the design system above — do NOT override, reinterpret, or simplify them.`
    : `You are a world-class UI/UX designer and creative director (Figma, Linear, Vercel, Stripe, Apple level). You design interfaces that win Awwwards Site of the Day and appear on Dribbble's popular page.

Your design philosophy:
- Design for THIS product and THIS audience. The fastest way to look machine-made
  is to reach for the same template every time.
- Visual hierarchy comes from size, weight and spacing — not from colour or boxes
- Generous whitespace reads considered; cramped layouts read amateur
- ONE accent colour, chosen from the product's domain, used for the primary action
  only. Everything else is a neutral ramp. Never default to indigo/violet (#6366f1,
  #8b5cf6) — that palette is the single clearest tell of generated work.
- Depth from 1px hairlines first; reserve real elevation for things that float
- Typography does the heavy lifting: a genuine scale, tight tracking on display
  sizes, a 60-75 character measure for body copy
- Restraint over decoration. No gradient headline text, no blurred colour blobs,
  no glassmorphism, no glow shadows, no animated gradient buttons — unless the
  brief specifically calls for that language.
- Motion is functional: opacity and transform, short durations, no infinite loops
- Content density where it earns its place: a real table has 8-10 rows of plausible
  data, not three rows of "Item 1"

Composition:
- Choose the sections THIS product actually needs, and order them by what the
  visitor needs to know first. Avoid the stock skeleton (hero → 3 feature cards →
  stats strip → 2 testimonials → CTA banner) — vary the rhythm with wide editorial
  rows, two-column splits and dense grids.
- Reference shapes by page type, to adapt rather than copy:
  Landing/marketing: a clear statement of what it is, evidence it works, a way in
  Dashboard: the metric that matters, then the working surface, then supporting detail
  E-commerce: product-first browsing, honest filtering, trustworthy detail
  SaaS: the problem, the mechanism, proof, pricing, objection handling
- Give the primary content region visual dominance.

Output a comprehensive JSON design specification.`

  // Preferred path: a graph of design specialists, composed for this request and
  // able to pull real recipes out of the KnowledgeBase. It costs minutes, which
  // is only affordable on the AgentCore Runtime — hence the flag rather than an
  // unconditional call.
  /**
   * The photographs the brief itself suggests, chosen before anything is designed.
   *
   * They used to be chosen after the design phase and handed only to the code
   * assembler, which meant every layout was composed without knowing a picture
   * existed and then had one fitted into it. That is the difference between a
   * hero band drawn at the height of its photograph and a hero band drawn for
   * text with a photograph squeezed in — and it is visible in the output.
   *
   * The list is topped up from the finished plan below, never replaced: a
   * specification that says "the warehouse shelves photograph goes here" must
   * still be able to find that photograph in the assembler's list.
   */
  const briefImages = await pickStockImages(prompt, profile.stockImages)

  let designPlan = ''
  // An approved plan is the design phase — re-running it would spend minutes
  // producing a specification the user has already rejected the alternatives to.
  if (approvedPlan) {
    designPlan = approvedPlan
    setPhase('承認済みのプランで構築中')
    logger.info('Building from an approved plan', { requestId, specChars: approvedPlan.length })
    if (jobId) appendJobEvent(jobId, 'routing', 'completed').catch(() => {})
  }
  if (!designPlan && useDesignGraph) {
    try {
      const [runDesignSwarm, { agentLabel }, { GENERATE_SPECIALISTS }] = await Promise.all([
        getRunDesignSwarm(),
        import('./strands-design.js'),
        import('./workflow-router.js'),
      ])

      /*
       * The whole chain, without asking. Measured over 14 days: the router that
       * used to stand here returned all five on 33 of 33 runs, because its own
       * guidance told it to — see the note where it was. The call is gone; the
       * chain it always chose is not.
       */
      const specialists = [...GENERATE_SPECIALISTS]
      logger.info('Design chain', { requestId, specialists })
      if (jobId) appendJobEvent(jobId, 'routing', 'completed').catch(() => {})

      setPhase('デザインを設計中')
      /*
       * The checklist, before the phase that decides the screens and the copy.
       *
       * It was awaited only before the build, so the specialists wrote a
       * specification without it and the build was told to follow that
       * specification closely — the requirement then had to win against the
       * spec in the build's prompt. One Haiku call, a few seconds against a
       * design phase of minutes; bounded the same way as the build's wait, and
       * the build re-awaits the same promise, so a slow extraction still
       * reaches the build.
       */
      requirements = await Promise.race([
        requirementsPromise,
        new Promise<Requirement[]>((resolve) => setTimeout(() => resolve([]), 15_000)),
      ])
      designPlan = await runDesignSwarm({
        prompt,
        userId,
        presetName,
        presetSpec,
        outputKind,
        modelId,
        image: imageInput,
        imageCaption: referenceCaption,
        contentImages: contentContext,
        stockImages: briefImages,
        dataContext,
        requirements: briefRequirements ? designRequirementsBlock(requirements) : '',
        specialists,
        onDelta: pushStream,
        // A specialist running alongside the finished one is now the text on screen.
        onFocus: (id) => setPhase(agentLabel(id)),
        onAgent: (id, phase) => {
          if (phase === 'started') setPhase(agentLabel(id))
          if (jobId) appendJobEvent(jobId, id, phase).catch(() => {})
        },
      })
      logger.info('Design phase used the Strands graph', { requestId, specChars: designPlan.length })
    } catch (e) {
      logger.warn('Design swarm failed, falling back to single-call design', {
        requestId,
        error: (e as Error).message,
      })
      designPlan = ''
    }
  }

  if (!designPlan) designPlan = await invokeModel(modelId,
    `${designAnalystSystem}

JSON structure (be extremely detailed and specific):
{
  "pageTitle": "exact page title text in appropriate language",
  "pageType": "dashboard|landing|form|list|detail|auth|pricing|portfolio|blog|ecommerce|settings",
  "visualStyle": "describe the overall aesthetic: modern-minimal, corporate-clean, playful-bold, elegant-luxury, tech-forward, etc.",
  "components": [
    {
      "name": "ComponentName",
      "type": "hero|nav|sidebar|card|table|form|footer|stats|chart|testimonial|pricing-card|feature-grid|etc",
      "description": "detailed visual description: shape, elevation, hover effect, internal spacing, icon usage",
      "content": "exact realistic text/data this component displays",
      "states": "default, hover, active, disabled — describe each"
    }
  ],
  "layout": {
    "structure": "detailed layout description — e.g. sticky header (64px) + sidebar (260px, collapsible) + scrollable main content area",
    "grid": "CSS Grid or Flexbox details: columns, gaps, breakpoints",
    "maxWidth": "1200px|1440px|full-width",
    "sections": ["ordered list of page sections from top to bottom with height estimates"]
  },
  "colorScheme": {
    "primary": "#hex",
    "primaryHover": "#hex (slightly darker/lighter variant)",
    "secondary": "#hex",
    "background": "#hex",
    "surface": "#hex (cards/elevated surfaces)",
    "surfaceHover": "#hex",
    "text": "#hex",
    "textSecondary": "#hex (muted text)",
    "textTertiary": "#hex (placeholders, disabled)",
    "border": "#hex",
    "borderLight": "#hex (subtle separators)",
    "success": "#hex",
    "warning": "#hex",
    "error": "#hex",
    "accent": "#hex (highlights, badges, notifications)"
  },
  "typography": {
    "fontFamily": "exact font stack (e.g. 'Inter', -apple-system, BlinkMacSystemFont, sans-serif)",
    "displayLarge": { "size": "px", "weight": "number", "lineHeight": "ratio", "letterSpacing": "value" },
    "h1": { "size": "px", "weight": "number", "lineHeight": "ratio" },
    "h2": { "size": "px", "weight": "number", "lineHeight": "ratio" },
    "h3": { "size": "px", "weight": "number", "lineHeight": "ratio" },
    "body": { "size": "px", "weight": "number", "lineHeight": "ratio" },
    "bodySmall": { "size": "px", "weight": "number", "lineHeight": "ratio" },
    "caption": { "size": "px", "weight": "number", "lineHeight": "ratio" }
  },
  "spacing": { "xs": "4px", "sm": "8px", "md": "16px", "lg": "24px", "xl": "32px", "2xl": "48px", "3xl": "64px" },
  "borderRadius": { "sm": "value", "md": "value", "lg": "value", "xl": "value", "full": "9999px" },
  "shadows": {
    "sm": "exact CSS box-shadow value",
    "md": "exact CSS box-shadow value",
    "lg": "exact CSS box-shadow value",
    "focus": "exact CSS box-shadow for focus rings"
  },
  "effects": {
    "transitions": "default transition (e.g. all 200ms cubic-bezier(0.4, 0, 0.2, 1))",
    "hoverTransform": "e.g. translateY(-2px) or scale(1.02)",
    "animations": ["list 3-5 specific animations: fade-in, slide-up, pulse, shimmer, etc with timing"]
  },
  "realisticContent": {
    "headline": "actual compelling headline text (in context-appropriate language)",
    "subheadline": "actual descriptive subheadline",
    "bodyText": "2-3 sentences of actual body copy",
    "dataExamples": ["8+ rows of realistic data with names, numbers, dates, statuses"],
    "ctaLabels": ["realistic button labels appropriate to the UI"],
    "navigationItems": ["5-8 realistic navigation items"],
    "stats": ["3-4 key metrics with realistic values"],
    "userNames": ["5+ realistic user/customer names"],
    "images": "describe placeholder image content (what photos/illustrations to represent)"
  },
  "views": [
    { "id": "view-id-slug", "navLabel": "Nav label", "title": "Page title", "description": "What this view shows" }
  ]
}

VIEWS RULE — CRITICAL:
- Include "views" array ONLY if the UI concept has 2+ distinct screens/pages (e.g. dashboard app, settings page, multi-tab interface, app with sidebar navigation between sections).
- Each view must have a unique slug id (lowercase, hyphens only, e.g. "home", "analytics", "user-profile").
- If it's a single-screen UI (landing page, single form, article, portfolio hero), OMIT "views" entirely.

CRITICAL RULES:
- All text content must be 100% realistic — NEVER use "Lorem ipsum", "Sample", "Test", or obvious placeholders
- If the UI is Japanese, ALL text must be natural Japanese
- Include enough data to fill the page richly (tables need 8+ rows, lists need 6+ items)
- Design for visual impact: hierarchy, restraint and content density, not decoration`,
    // This message used to prescribe a mesh-gradient hero, gradient headline text,
    // floating blobs, a glassmorphism navbar and a pulse-glow keyframe — every one
    // of which the code assembler explicitly bans and the scorer penalises. The
    // fallback therefore fought the rest of the pipeline whenever the design graph
    // was unavailable, which is precisely when quality mattered most.
    `${kbContext}${imageContext}${dataContext}\n\nUI to design: "${prompt}"\n\nDesign this as a real team would ship it — the level of Linear, Stripe, Vercel or Figma Make.\n\nCommit first to a design direction and record it in the spec: the product's domain, ONE accent colour a real company in that domain would use (never indigo/violet #6366f1 / #8b5cf6 / #7c3aed / #a855f7), one neutral ramp, a type pairing and stance, and a radius/density decision.\n\nThen specify:\n- The sections THIS product actually needs, ordered by what the visitor needs first. Not the stock skeleton (hero → 3 feature cards → stats → 2 testimonials → CTA banner).\n- Components with their real states (default, hover, active, focus, disabled), sized from the type and spacing scales.\n- Depth from 1px hairlines; elevation only for things that genuinely float.\n- Motion only where it is functional: opacity and transform, 120-180ms micro, 300-500ms entrances. No infinite loops on decoration.\n- Realistic content throughout — tables with 8+ rows of plausible data, real names, dates and amounts in the page's language.\n\nExplicitly do NOT specify: gradient-filled headline text, mesh/blob backgrounds, glassmorphism, glow shadows, animated gradient buttons, emoji as icons, or marketing filler copy.`,
    64000,
    imageInput,
    'design:analyst'
  )
  done('design-analyst', t)

  // Step 2: Build final HTML
  t = Date.now()
  log('code-assembler')

  /**
   * Photographs from the curated library, chosen before the model is asked.
   *
   * Selected here rather than by the model because the choice is a lookup, not a
   * judgement: the brief names a domain, the index carries tags, and matching
   * them is deterministic and free. What the model is asked to decide is the
   * only part that needs judgement — whether a given screen wants a photograph
   * at all.
   */
  /**
   * Topped up from the finished plan, never replaced.
   *
   * The design phase was shown `briefImages` and may have specified a screen
   * around one of them. Re-picking from scratch here could drop exactly that
   * picture — leaving the assembler holding a specification that references a
   * photograph it has no URL for, which it resolves by inventing one. So the
   * ones the designer saw are kept, and the plan's own vocabulary is only
   * allowed to add.
   */
  const planImages = await pickStockImages(`${prompt} ${designPlan.slice(0, 4000)}`, profile.stockImages)
  const stockImages = [
    ...briefImages,
    ...planImages.filter((p) => !briefImages.some((b) => b.url === p.url)),
  ].slice(0, 5)
  /**
   * Whether a library exists is a different question from whether this brief
   * matched anything in it, and the slot instruction depends on the first.
   * 「アパレルのECサイト」 matches no photographable subject — `apparel` is a
   * category — so the storefront was built with no photographs at all, while the
   * library held T-shirts, knitwear and jeans that `assignItemImages` would have
   * placed from the product names alone.
   */
  const stockLibrary = await hasStockLibrary()
  if (stockImages.length > 0) {
    logger.info('Offering stock photographs to the build', {
      requestId,
      count: stockImages.length,
      fromBrief: briefImages.length,
      addedByPlan: stockImages.length - briefImages.length,
      urls: stockImages.map((i) => i.url.split('/').slice(-2).join('/')),
    })
  }

  // React output replaces the single-page file/structure rules above. Appended last
  // so its format contract wins wherever the two disagree.
  // React mode replaces the base prompt rather than appending to it. Appending left
  // the single-document HTML mechanics (style/script block names, "output one page",
  // zero-dependency framing) in context, and the model followed those instead of the
  // module contract — emitting window.__Globals__ and React.createElement with no imports.
  const assemblerContract = `You are a senior frontend engineer. You build production TypeScript React applications.

${presetSpec ? `╔════════════════════════════════════════════════════════════════════╗
║  BINDING DESIGN SYSTEM — THESE VALUES ARE ABSOLUTE AND FINAL      ║
╠════════════════════════════════════════════════════════════════════╣
${withoutTokenDeclarations(presetSpec, presetName)}
╚════════════════════════════════════════════════════════════════════╝
${foundationPromptBlock(presetName) || `Transcribe its colour values verbatim into :root in src/styles/globals.css, then
reference them with var(--token) everywhere.`}
The AESTHETIC section is binding too.

The COMPOSITION section is equally binding, and it is the part most often ignored.
It states how a screen is BUILT in this system — the shell, and the shape of a list,
a detail and a form. Build those shapes. A page carrying the right hex values in a
layout this system would never use has not applied the design system; it has
recoloured a generic template, which is the single most common way a preset comes
out looking like every other preset.

${shellRequirement(presetName)}
` : `DESIGN DIRECTION — decide before writing any CSS:
a) DOMAIN — name it from the brief; the visual language follows.
b) ACCENT — ONE accent a real company in that domain would ship. HARD BAN on
   #6366f1 / #8b5cf6 / #7c3aed / #a855f7 and every indigo-violet neighbour.
c) NEUTRALS — one ramp, genuinely neutral or deliberately warm/cool. Never mix.
d) TYPE — a real scale; tight tracking on display sizes; 60-75ch measure for body.
e) DENSITY & SHAPE — settle the radius and spacing rhythm, then hold it.
Record these as comments at the top of src/styles/globals.css and obey them.

BANNED unless the brief asks: gradient-filled headline text, blurred colour blobs,
glassmorphism, glow shadows, animated gradient buttons, emoji as icons, filler copy
("Supercharge", "next level", "Seamlessly"), lorem ipsum.
Restraint wins: hairline borders first, shadows barely visible, motion 120-180ms
opacity/transform only, and honour prefers-reduced-motion.`}

${outputSpecFor(outputKind)}

REQUIRED FILE LAYOUT — reproduce these paths exactly:
  SPECIFICATION.md              what this app does, screen by screen (see below)
  docs/design-guidelines.md     the design rules this app follows (palette, type scale,
                                spacing, component conventions). Written first, then obeyed.
${FRAMEWORKS[outputKind].layout}
  src/data/*.ts                 typed mock data, exported as const arrays
  src/lib/*.ts                  pure helpers (formatters, filters, validators)
  src/styles/globals.css        ALL styling, design tokens in :root
${projectContract(outputKind)}
${stylesheetContract(outputKind)}
${SCREEN_COMPLETENESS}
${FORM_CONTROL_SIZING}`

  /**
   * Everything above is invariant for this framework and preset; everything
   * below is this run's.
   *
   * The split is a cache breakpoint, not a refactor — see prompt-cache.ts. The
   * measured prefix is about 31,500 characters of contract plus up to 5,600 of
   * preset spec, which is roughly 10,000-11,700 tokens: comfortably over the
   * floor, and identical on the next run with the same framework and preset.
   *
   * The photographs are where it has to stop. They are chosen per run, so a
   * breakpoint after them would match nothing on the next one — and the contract
   * they sit between is the whole reason there is anything worth caching.
   */
  const assemblerRun = `
${stockImageInstructions(stockImages, stockLibrary)}

══════════════════════════════════════════════
NO EMOJI — ANYWHERE. This is absolute.
══════════════════════════════════════════════
Not in headings, buttons, labels, nav items, table cells, badges, toasts, empty
states, form hints, status text, alt text or seed data. Not as icons, not as
bullets, not as decoration, not as a status indicator, not "just this one".

Emoji are the clearest single sign a page was generated rather than designed. No
product at the level you are aiming for uses them as interface furniture.

  BAD:  <button>🔍 検索</button>        GOOD: <button><svg .../>検索</button>
  BAD:  <h2>📊 売上サマリー</h2>         GOOD: <h2>売上サマリー</h2>
  BAD:  { label: '設定', icon: '⚙️' }    GOOD: { label: '設定', icon: SettingsIcon }
  BAD:  「✅ 保存しました」               GOOD: 「保存しました」（成功色とSVGで示す）
  BAD:  空状態に 📭                      GOOD: 空状態は線画SVG + 一文の説明 + 次の操作

Where an icon is genuinely needed, draw an inline SVG (viewBox="0 0 24 24",
stroke="currentColor", stroke-width 1.5, no fill). Where it was decoration,
delete it and let spacing do the work. Status is carried by colour, weight and a
written label — never by a glyph.

══════════════════════════════════════════════
MODULE STYLE — the most common failure. Read twice.
══════════════════════════════════════════════
These files are ES modules compiled by a bundler. They are NOT browser scripts.

REQUIRED — every file imports what it uses and exports what others need:

  // src/app/components/EquipmentCard.tsx
  import { useState } from 'react';
  import type { Equipment } from '../data/equipment';
  import { formatDate } from '../lib/formatters';

  interface EquipmentCardProps {
    item: Equipment;
    onSelect: (id: string) => void;
  }

  export default function EquipmentCard({ item, onSelect }: EquipmentCardProps) {
    const [open, setOpen] = useState<boolean>(false);
    return <button onClick={() => onSelect(item.id)}>{item.name}</button>;
  }

FORBIDDEN — every one of these makes the build fail:
  ✗ const { useState } = React;            → import { useState } from 'react';
  ✗ window.__App__ / window.__useApp__     → import App from './app/App';
  ✗ React.createElement(...)               → write JSX
  ✗ a file with no import and no export    → every module has both
  ✗ types written as comments              → write real annotations
  ✗ referencing a global React or ReactDOM → import them

TYPES ARE MANDATORY, NOT DECORATIVE:
  Every component has an exported or local "interface <Name>Props", and its
  parameters are annotated with it. Every data module exports an "interface" for
  its records. The reducer's Action is a discriminated union and both reducer
  parameters are annotated. useState that isn't trivially inferred is
  parameterised. A file containing zero ":" type annotations is a defect.

══════════════════════════════════════════════
OUTPUT SHAPE — a short plan, then the document
══════════════════════════════════════════════
First write 3-5 short lines in Japanese, one sentence each, no headings and no
bullet markers, covering: what this product is, the design direction you chose
(domain, accent colour, type, density) and the screens/sections you will build.
This is streamed to the user while the build runs, so write it as if talking to
them — not as a spec dump.

Then, on a new line, output the document. Write nothing after it.

Then the HTML document described in OUTPUT FORMAT — no markdown, no fences.`

  /*
   * No cache breakpoint, and the reason is arithmetic rather than principle.
   *
   * A breakpoint bills the prefix at 1.25x when it is written and about 0.1x
   * when it is read, so it pays only if the same bytes come back often enough.
   * Measured over 33 generations: this stage wrote 149,831 cached tokens and
   * read ZERO. Every run paid the surcharge and no run collected.
   *
   * It cannot collect. The assembler is one call per run — there is no second
   * call to hit the entry, and a Bedrock cache entry does not live long enough
   * to reach the next generation unless two start within about five minutes of
   * each other, which has not happened once in the log.
   *
   * The break-even is a hit rate of 25/90, near 28%. Reinstate the split if
   * generations ever run back to back often enough to clear that — the numbers
   * to check are `cacheWrite` and `cacheRead` on this stage in the Token ledger.
   *
   * The design graph's own breakpoints stay: layout-architect appears to write
   * 41,125 and read nothing, but cacheRead is billed to the READER, and the
   * three specialists after it read 340,329 between them. That one pays.
   */
  const codeAssemblerSystem = assemblerContract + assemblerRun

  setPhase(`${FRAMEWORKS[outputKind].label} プロジェクトを生成中`)
  const onDelta = pushStream

  /**
   * The project is written one file at a time when the effort profile pays for it.
   *
   * Everything below this block is the single-call assembler, kept as the
   * fallback rather than removed: the per-file build declines whenever it cannot
   * see itself through — no manifest, no foundation, a screen that would not
   * parse — and a build that declines must still produce a project.
   *
   * The reason for the split is in build-files.ts and it is this codebase's own
   * measurement, made twice already on the repair pass and the edit path: a
   * model asked for thirty files in one response writes thirty abbreviated
   * files. The design phase spends minutes enumerating every control on every
   * screen, and then the build has a few hundred tokens per screen to implement
   * them. That gap is where 「モックが動かない」 comes from.
   */
  /*
   * Bounded, because a checklist is worth having and not worth waiting for. On
   * the draft profile there is no design phase to hide behind, and a slow
   * extraction must not hold the build: past the bound the run goes on without
   * one, exactly as it did before this existed.
   */
  requirements = await Promise.race([
    requirementsPromise,
    new Promise<Requirement[]>((resolve) => setTimeout(() => resolve([]), 20_000)),
  ])
  let perFilePlan = ''
  let builtDocument: string | null = null
  if (profile.perFileBuild) {
    const built = await buildProjectFiles(
      {
        spec: specForBuild(designPlan, requestId),
        prompt,
        kind: outputKind,
        requestId,
        presetName,
        effort,
        presetSpec,
        stockBlock: stockImageInstructions(stockImages, stockLibrary),
        formControlSizing: FORM_CONTROL_SIZING,
        projectContract: projectContract(outputKind),
        stylesheetContract: stylesheetContract(outputKind),
      },
      (system, user, maxTokens) => invokeModel(modelId, system, user, maxTokens, imageInput, 'build:per-file'),
      {
        onPhase: setPhase,
        onFile: (path, body) => {
          // Same transcript the single-call build feeds, so the user still
          // watches code arrive rather than a spinner — now labelled by file.
          pushStream(`${path}
${body.slice(0, 4000)}`)
        },
      }
    )
    if (built.html) {
      logger.info('Project built file by file', {
        requestId,
        files: built.written.length,
        screens: built.manifest.screens.length,
        skipped: built.skipped,
      })
      const screens = built.manifest.screens.map((sc) => sc.path.split('/').pop()).join('、')
      perFilePlan =
        `${built.manifest.screens.length}画面と${built.manifest.components.length}個の共通部品に分けて実装しました。
` +
        `画面: ${screens}
` +
        `共通の見た目は src/styles/globals.css に集約し、各画面はそのクラスだけを使っています。`
      builtDocument = built.html
    }
    if (!builtDocument) {
      logger.info('Per-file build declined; using the single-call assembler', { requestId })
      setPhase(`${FRAMEWORKS[outputKind].label} プロジェクトを生成中`)
    }
  }

  const html = builtDocument ?? await invokeModelStreaming(modelId,
    codeAssemblerSystem,
    `Design specification (follow this closely for layout, content, and component structure):\n${specForBuild(designPlan, requestId)}\n\nOriginal user request: "${prompt}"${requirementsBlock(briefRequirements ? requirements : requirements.filter((r) => r.check.kind !== 'screen'))}${imageContext}${dataContext}\n\n${presetSpec ? 'FINAL REMINDER: the design system above is BINDING in both directions. Its VALUES — colours (#hex), fonts, spacing, border-radius, shadows — are used exactly, never substituted or approximated. Its COMPOSITION section is equally binding: build the shell and the screen shapes it describes, rather than applying its colours to a layout of your own. The second is the one that gets skipped, and skipping it is what makes every preset produce the same page in a different colour.' : 'QUALITY BAR: this must read as a real product shipped by a real team — the level of Linear, Stripe, Vercel or Figma Make, and ideally past it. Before writing CSS, state your Step 0 choices to yourself (domain, single accent, neutral ramp, type pairing, radius/density) and hold them for the whole page. Honour every entry in the BANNED list — no indigo-violet default, no gradient headline text, no blurred blobs, no glass navbar, no glow shadows, no stock section order. Let typography, spacing and one restrained accent carry the design. Choose the sections this specific product actually needs rather than filling a template, and write copy a person at this company would really write.'}`,
    onDelta,
    64000,
    // Attached here too, not only to the design phase: the design spec is prose, and
    // prose cannot carry a palette or a layout as precisely as the picture it came from.
    imageInput,
    'build:single-call'
  )
  if (jobId) await updateJobStream(jobId, html, html.length, streamPhase).catch(() => {})
  done('code-assembler', t)

  // Step 3: Finalize
  t = Date.now()
  log('finalizing')
  setPhase('出力を整形中')
  const cleanedHtml = stripFences(html)

  // The model writes a short plan before the document. Split it off: the plan is
  // shown in the chat, and anything before <!DOCTYPE would corrupt the page.
  const docStart = cleanedHtml.search(/<!DOCTYPE html|<html[\s>]/i)
  /**
   * The per-file build writes no prose preamble — there is no single response for
   * one to sit in front of — so its summary is composed from the manifest and
   * used instead. Both paths still hand the chat a sentence about what was built.
   */
  const plan = perFilePlan || (docStart > 0 ? stripFences(cleanedHtml.slice(0, docStart)) : '')
  const body = docStart >= 0 ? cleanedHtml.slice(Math.max(docStart, 0)) : cleanedHtml
  let finalHtml = docStart >= 0 ? body : `<html><body>${cleanedHtml}</body></html>`
  /**
   * Fix the file extensions before anything else reads the project.
   *
   * A `.ts` file holding JSX is a contract violation the model commits often
   * enough that everything downstream had grown a workaround: the preview
   * retried the file and showed the user a warning about a naming rule they did
   * not write, and the exported project shipped a file `tsc` rejects. Renaming
   * it here removes the cause instead, and every later stage — the audits, the
   * repair, the ZIP — sees a project that is correct.
   */
  /**
   * Before anything measures the document: a router-package link is inert, and
   * turning it back into an anchor is mechanical. Doing it here rather than
   * leaving it to the repair loop is what makes it work in `economy` and `fast`,
   * which run no repair passes at all.
   */
  {
    const links = normalizeRouterLinks(finalHtml, outputKind)
    if (links.rewritten > 0) {
      finalHtml = links.html
      logger.info('Rewrote router links as anchors', { requestId, rewritten: links.rewritten })
    }
    /**
     * The idioms that stop a framework compiling, repaired deterministically.
     *
     * Runs on every path and in every effort profile, including the two that pay
     * for no repair passes: a duplicate `defineProps()` or a `$store` prefix on a
     * rune module is a blank page with an error on it, and that is not a less
     * complete interface — it is not an interface.
     */
    const fixups = fixupProject(finalHtml, outputKind)
    if (fixups.fixed.length > 0) {
      finalHtml = fixups.html
      logger.info('Repaired framework idioms', { requestId, fixed: fixups.fixed.slice(0, 6) })
    }
  }

  if (outputKind === 'react') {
    const normalized = normalizeReactExtensions(finalHtml)
    if (normalized.renamed.length > 0) {
      finalHtml = normalized.html
      logger.info('Renamed .ts files containing JSX', { requestId, renamed: normalized.renamed })
    }
    /*
     * React only, and deliberately.
     *
     * `addMissingBarrels` itself is framework-agnostic — `isReactBundle` admits
     * .vue and .svelte — so the gate looks like another stale React assumption
     * of the kind this file has had several of. It is not. A barrel exists to
     * resolve `from './components/ui'`, an import of a DIRECTORY, and measured
     * across every Vue and Svelte project this system has produced: none of them
     * writes one. Both frameworks import a component by its full filename,
     * because the extension is load-bearing there in a way it is not for .tsx.
     *
     * Left as it is rather than widened on principle: the widened version would
     * also have to emit `export { default as Foo } from './Foo.vue'` correctly,
     * which is untested code for a case that does not occur.
     */
    const barrels = addMissingBarrels(finalHtml)
    if (barrels.added.length > 0) {
      finalHtml = barrels.html
      logger.info('Added missing barrel files', { requestId, added: barrels.added })
    }
  }

  /**
   * Before anything measures the project, because until this runs there may be
   * nothing to measure. One unparseable file makes the whole bundle fail, so
   * the audits see an empty render, the score is whatever a blank page scores,
   * and a repair pass is spent on a missing quote. Fixed here it costs no model
   * call, and the fix is only applied when the file it produces compiles.
   *
   * Every framework, not only React. `repairSyntax` reads its file list through
   * `sourceFiles`, which takes the kind from the paths, and checks each file
   * with `parses`, which sends a .vue to the Vue compiler and a .svelte to
   * Svelte's. It was gated on React all the same, so the two frameworks that
   * have needed the most help shipping a page that renders were the two this
   * never ran for. It matters most on `economy` and `fast`, which buy no repair
   * passes at all: there, a missing quote had no second chance.
   */
  const syntax = repairSyntax(finalHtml)
  if (syntax.repairs.length > 0) {
    finalHtml = syntax.html
    logger.info('Repaired syntax errors before verification', {
      requestId,
      kind: outputKind,
      repairs: syntax.repairs.map((r) => `${r.path}:${r.line} ${r.before} → ${r.after}`),
    })
  }
  done('finalizing', t)

  // Step 3b: Preset conformance repair.
  // Half-applied design systems are the most common preset failure — the model
  // starts on-system and drifts back to its own defaults further down the page.
  // Prose reminders don't prevent it, so measure and repair instead. Only fires on
  // real drift, and the result is kept only if it measurably improves.
  {
    /*
     * The token block first, so everything after it measures a stylesheet that has it.
     *
     * The per-file build wrote it into the foundation already; the single-call
     * build, a syntax repair or a fixup may not have kept it. `applyPresetFoundation`
     * is idempotent, so this costs nothing when it is there. See preset-foundation.ts
     * for why the values are written by code at all.
     */
    const founded = applyPresetFoundation(finalHtml, presetName)
    if (founded.applied) {
      finalHtml = founded.html
      logger.info('Wrote the design system token block', { requestId, presetName, overridden: founded.overridden.length })
    }
    const fonts = snapFontFamilies(finalHtml, presetName)
    if (fonts.changes > 0) {
      finalHtml = fonts.html
      logger.info('Put stray font stacks back on the design system typeface', { requestId, presetName, changes: fonts.changes })
    }
    /*
     * The radii, before anything measures them.
     *
     * A model call cannot carry this. Measured on a real run: the deviation was
     * found, the repair ran, the repair worked, and it was rejected for
     * shortening the document by 13% — correctly, because deleting 9,500
     * characters to fix a corner radius is not a trade worth taking. And
     * prompting cannot carry it either: the offending values are the
     * conventional scale a model writes by habit at every element.
     *
     * Done here rather than inside the repair, so the measurement below sees a
     * document already on-scale and the repair is never spent on radii at all.
     */
    const sigRadii = presetRadii(presetName)
    if (sigRadii.length > 0) {
      const snapped = snapRadii(finalHtml, sigRadii)
      if (snapped.changes.length > 0) {
        finalHtml = snapped.html
        const summary = [...new Set(snapped.changes.map((c) => `${c.from}→${c.to}`))]
        logger.info('Snapped corner radii onto the design system scale', {
          requestId, presetName, allowed: sigRadii, changes: snapped.changes.length, values: summary,
        })
      }
    }
    /*
     * Component heights and the smallest type, where the system's value is the
     * only answer — see `snapComponentSizes` for which drift that is and which
     * stays a finding.
     */
    {
      const sized = snapComponentSizes(finalHtml, presetName)
      if (sized.changes.length > 0) {
        finalHtml = sized.html
        logger.info('Snapped component sizes onto the design system', {
          requestId, presetName, changes: sized.changes.length,
          values: [...new Set(sized.changes.map((c) => `${c.what} ${c.from}→${c.to}`))],
        })
      }
    }
    /*
     * And the movement, for the same reason and by the same means.
     *
     * Motion was the one axis every preset asked for in prose and nothing ever
     * measured — 70% of shipped documents carry a `transition: all` against an
     * instruction that has always said opacity and transform only.
     */
    const sigMotion = presetMotion(presetName)
    if (sigMotion) {
      const moved = snapMotion(finalHtml, sigMotion)
      if (moved.changes.length > 0) {
        finalHtml = moved.html
        logger.info('Brought motion inside the design system contract', {
          requestId, presetName, changes: moved.changes.length,
          clamped: [...new Set(moved.changes.filter((c) => c.from > 0).map((c) => `${c.from}→${c.to}ms`))],
        })
      }
    }
    /*
     * The shadows first, and without a model.
     *
     * A blur past 24px and a tinted shadow past 0.25 alpha are the two elevation
     * faults the contract names, and both have one arithmetic answer. Running
     * this before the measurement means a document whose only drift was
     * decorative shadows never reaches the call below at all.
     *
     * Measured on 2026-09-03: of three conformance repairs, two were rejected
     * for 「no improvement」 and both were shadow faults.
     */
    const clamped = clampDecorativeShadows(finalHtml)
    if (clamped.fixed.length > 0) {
      finalHtml = clamped.html
      logger.info('Clamped decorative shadows without a model call', { requestId, presetName, notes: clamped.notes })
    }
    const before = presetConformance(finalHtml, presetName)
    /**
     * Full conformance is the bar, but the pass also needs something to say.
     *
     * `details` is the whole instruction the repair receives. An empty list meant
     * a model call whose user message was 「検出された逸脱（これらを直してください）」
     * followed by nothing — and for `preset: 'none'` the system message was
     * "BINDING DESIGN SYSTEM:" followed by nothing too, because there is no spec
     * for "no preset". A run of the pipeline was spending a full generation-sized
     * call being asked to conform an document to nothing, every time output used
     * a banned colour.
     */
    if ((before.ratio < 1 || before.violations > 0) && before.details.length > 0) {
      t = Date.now()
      log('preset-conformance')
      setPhase('デザイン準拠を補正中')
      logger.info('Preset drift detected', { requestId, presetName, ...before })
      try {
        /*
         * Every deviation this pass repairs is a CSS fact.
         *
         * `measureConformance` runs on `normaliseCss(html)` and nothing else —
         * missing token values, a forbidden colour, palette dominance, radii,
         * motion. And the stylesheet contract puts all styling in one file. So
         * the repair is handed that file rather than the project.
         *
         * Measured before this: 31,115 input tokens a call and 19,019 out,
         * because the call sent `finalHtml.slice(0, 90000)` — the whole project,
         * TypeScript and all — and asked for the whole project back. 7.4% of
         * everything MakeUI spends, to change some hex values in a stylesheet.
         *
         * It is also the safer shape. "Preserve ALL content, copy, structure,
         * semantics and JavaScript EXACTLY as given" was the instruction asking
         * the model not to damage the code it had no reason to touch; a call
         * that is only given the stylesheet cannot damage it at all. Making it
         * impossible beats asking.
         */
        const sheet = stylesheetOf(finalHtml)
        const repaired = sheet
          ? await invokeModel(modelId,
              `You repair design-system conformance in one stylesheet.

${presetSpec
                ? `BINDING DESIGN SYSTEM:
${presetSpec}`
                : `No design system is imposed. The deviations listed below are absolute rules
that hold regardless: banned default palettes, elevation limits. Fix exactly
those and change nothing else — do not restyle towards some other system,
because there is none to move it to.`}

Rules:
- Return the COMPLETE corrected stylesheet and nothing else. No markdown, no
  fences, no commentary.
- Change ONLY the values that deviate. Keep every selector, every rule and their
  order exactly as given — other files reference these class names.
${presetFoundation(presetName)
  ? `- The block between /* makeui:foundation:start and /* makeui:foundation:end */ is
  written by MakeUI from the system's published tokens. Return it exactly as given,
  and make every other rule reference its custom properties instead of hard-coded
  off-system values.`
  : `- Define the system's values verbatim as custom properties in :root, then make
  every other rule reference them instead of hard-coded off-system values.`}`,
              `This stylesheet was written for the "${presetName}" design system but drifted from it.
検出された逸脱（これらを直してください。他は変更しないこと）:
${[...before.details, ...measureComponentDrift(finalHtml, presetName).details].map((d, i) => `${i + 1}. ${d}`).join('\n')}

--- ${sheet.path} ---
${sheet.body}`
            , 16000, null, 'repair:preset-conformance')
          : await invokeModel(modelId,
              `You repair design-system conformance in an existing HTML document.

${presetSpec
                ? `BINDING DESIGN SYSTEM:
${presetSpec}`
                : `No design system is imposed on this document. The deviations listed below are
absolute rules that hold regardless: banned default palettes, elevation limits.
Fix exactly those and change nothing else — in particular, do not restyle the
document towards some other system, because there is none to move it to.`}

Rules:
- Preserve ALL content, copy, structure, semantics and JavaScript EXACTLY as given.
- Change ONLY CSS values that deviate from the design system above.
- Output the COMPLETE corrected document starting with <!DOCTYPE html>.
  No markdown, no code fences, no commentary.`,
              `This document was generated for the "${presetName}" design system but drifted from it.
検出された逸脱（これらを直してください。他は変更しないこと）:
${before.details.map((d, i) => `${i + 1}. ${d}`).join('\n')}

${finalHtml.slice(0, 90000)}`
            , 64000, null, 'repair:preset-conformance')

        /*
         * Whichever shape ran, what is measured is the whole document — the
         * stylesheet is spliced back first. Conformance is a property of the
         * project, not of the file that was rewritten.
         */
        const cleanedRepair = sheet
          ? spliceStylesheet(finalHtml, sheet.path, stripFences(repaired))
          : stripFences(repaired)
        const usable = sheet
          ? cleanedRepair !== null
          : cleanedRepair !== null && (cleanedRepair.includes('<html') || cleanedRepair.includes('<!DOCTYPE'))
        if (usable && cleanedRepair) {
          const after = presetConformance(cleanedRepair, presetName)
          /**
           * Strict improvement, and no shrinkage.
           *
           * The test was `after.ratio >= before.ratio && after.violations <= before.violations`,
           * which is satisfied by a document that changed nothing — and by one that
           * changed a great deal without fixing anything, since equality passes.
           * Accepting an unimproved rewrite risks what it rewrote for no measured
           * gain. The interaction repair next door has always required a real
           * improvement; this is the same rule.
           *
           * Length is checked for the reason it is checked there too: a response cut
           * off partway loses whole blocks, and a document missing its tail can
           * measure *better* on conformance precisely because the drifting part is
           * the part that went missing.
           */
          const improved = after.violations < before.violations || after.ratio > before.ratio
          const intact = cleanedRepair.length >= finalHtml.length * 0.9
          if (improved && intact) {
            finalHtml = cleanedRepair
            logger.info('Preset repair accepted', { requestId, presetName, scope: sheet ? sheet.path : 'document', ...after })
          } else {
            logger.info('Preset repair rejected', {
              requestId,
              presetName,
              scope: sheet ? sheet.path : 'document',
              reason: !improved ? 'no improvement' : 'output shorter than input',
              beforeViolations: before.violations,
              afterViolations: after.violations,
              beforeLen: finalHtml.length,
              afterLen: cleanedRepair.length,
            })
          }
        }
      } catch (e) {
        logger.warn('Preset conformance repair failed', { error: String(e) })
      }
      done('preset-conformance', t)
    }
  }

  // Step 3c: Interaction repair.
  // The prompt already demands working navigation and live controls, but asking is
  // not enforcing — and the visual score cannot tell a live page from a beautiful
  // dead one. So the requirements are measured, and only real defects are repaired.
  /**
   * Last-resort repairs BEFORE the browser sees it, not after.
   *
   * These two used to run at the very end, after verification and after the
   * score. They change `finalHtml`, so they broke the invariant stated on
   * `scoredFacts` a few lines below — "the score is never computed from
   * measurements of a document that was thrown away".
   *
   * Measured at v156: the stub did its job and the shipped project compiled and
   * ran, while the recorded result said `screens 0, consoleErrors 1, score 30`.
   * That described the document as it had been an instant earlier. A user would
   * have opened a working application whose report said it was blank.
   *
   * Running them here means the walk measures what actually ships. They are
   * no-ops on a document that already builds, so a sound run is unaffected, and
   * the repair passes that follow can still improve whatever the stub left —
   * the placeholder is a valid component, not a dead end.
   */
  const preSalvage = salvageUnparsableStyles(finalHtml, outputKind, toRunnableDocument)
  if (preSalvage.stripped.length > 0) {
    finalHtml = preSalvage.html
    logger.warn('Dropped unparsable scoped styles before verification', {
      requestId, kind: outputKind, files: preSalvage.stripped,
    })
  }
  const stubbedFiles: string[] = []
  /**
   * A file that will not build gets one repair before it gets a placeholder.
   *
   * The stub used to be the first and only answer to a build error, and it runs
   * here — before verification, before the repair loop. That ordering costs
   * everything: the placeholder replaces the source, so by the time the repair
   * passes start there is nothing left to repair. Measured on a v192 Svelte
   * run: four screens stubbed at 06:12:00, two full repair passes after it, and
   * the four placeholders shipped. Twenty points each, capped at sixty, and the
   * score hit its floor of 30 with seven screens unreachable.
   *
   * The question is put to the compiler rather than to the stub. Stubbing
   * declines on the entry, the shell, a rune module and anything with a named
   * export — correctly, since a placeholder for any of those is not a smaller
   * failure than the error — and it reports nothing in those cases, so gating
   * the repair on it skipped exactly the cases where nothing else can help.
   * Measured on v195: an `{@const}` where Svelte does not allow one, in
   * App.svelte, five screens and seventeen components, and a page that rendered
   * nothing at all.
   *
   * A compile error is the easiest thing this pipeline ever asks a model to
   * fix. It names the file, the line and the token, and `repairFiles` already
   * refuses a reply that does not parse or that comes back materially shorter
   * than what it replaces — so a failed attempt costs one small call and
   * changes nothing.
   *
   * It only runs when the project is already broken, which today is a certain
   * twenty points a file, or the whole document when the shell is the one that
   * will not build. The bound is on files, not passes: each is one call, they
   * are independent, and a project with more than a handful of unbuildable
   * files has a fault no per-file edit is going to reach.
   */
  const unbuildable = unbuildableFiles(finalHtml, outputKind, toRunnableDocument)
  if (unbuildable.length > 0 && unbuildable.length <= 6) {
    try {
      const { repairFiles } = await import('./repair-files.js')
      setPhase('ビルドできないファイルを修正中')
      const { html: mended, written } = await repairFiles(
        finalHtml,
        unbuildable.map((r) => ({
          path: r.path,
          create: false,
          defects: [
            {
              id: 'build-error',
              severity: 'critical',
              // The compiler's own words. A paraphrase would drop the position,
              // and the position is the whole of what makes this repairable.
              instruction:
                'このファイルはコンパイルできません。ビルドエラーを解消してください' +
                `（位置は <script> ブロック内の 行:列 です）。\n\n${r.error}\n\n` +
                '画面の内容・機能・スタイルは維持したまま、構文だけを直してください。',
            } as InteractionDefect,
          ],
        })),
        (system, user) => invokeModel(modelId, system, user, 16000, null, 'repair:placeholder'),
        // Here a rejected reply means a placeholder, so one more attempt with
        // the compiler's answer to the last one is cheaper than giving up.
        true
      )
      if (written.length > 0) {
        // Asked of the compiler again rather than assumed: `repairFiles` checks
        // that each reply parses on its own, which is not the same as the
        // project building.
        const remaining = unbuildableFiles(mended, outputKind, toRunnableDocument)
        logger.info('Repaired unbuildable files instead of stubbing them', {
          requestId,
          kind: outputKind,
          asked: unbuildable.map((r) => r.path),
          written,
          stillFailing: remaining.map((r) => r.path),
        })
        finalHtml = mended
      }
    } catch (e) {
      // A failure here leaves the stub to do what it has always done.
      logger.warn('Pre-stub build repair failed', { requestId, error: String(e) })
    }
  }
  const preStub = stubUnbuildableComponents(finalHtml, outputKind, toRunnableDocument)
  if (preStub.stubbed.length > 0) {
    finalHtml = preStub.html
    stubbedFiles.push(...preStub.stubbed)
    // The reason, not only the filename. Measured at v160: all three screens of
    // a Svelte project were stubbed and the only record was a list of three
    // paths — three failures with one probable cause, and nothing anywhere
    // saying what it was, because the stub had replaced the evidence along with
    // the fault.
    logger.warn('Replaced unbuildable components with placeholders before verification', {
      requestId, kind: outputKind, reasons: preStub.reasons,
    })
  }

  /**
   * Step 3b-bis: run the document in a real browser before judging it.
   *
   * Everything above this point reads the source. That is how a page scoring 92
   * with zero detected defects shipped a dashboard whose content stopped a third
   * of the way down the viewport, and how an edit that added a Gantt screen
   * reported success with the chart left as an empty box. Both were obvious the
   * moment the page was rendered and neither is expressible as a pattern over
   * the markup.
   *
   * Never fatal: `verifyInBrowser` returns null on any trouble, and the pipeline
   * then behaves exactly as it did before this stage existed.
   */
  let runtimeDefects: InteractionDefect[] = []
  let visualDefects: InteractionDefect[] = []
  /**
   * The render that describes `finalHtml` as it currently stands. Reassigned when
   * a repair is accepted, so the score is never computed from measurements of a
   * document that was thrown away.
   */
  let scoredFacts: Awaited<ReturnType<typeof verifyInBrowser>> = null
  /**
   * The document `scoredFacts` was measured on — which is not always `finalHtml`.
   *
   * The deterministic fixes change the document right after it is measured and
   * deliberately do not re-measure it. When a repair pass is then accepted, its
   * render replaces the stale facts; when none is, nothing did. The end-of-run
   * re-walk compared against the document as it stood after the loop, which
   * already contained those fixes, so it saw no change and did not run.
   *
   * Measured on the 2026-09-13 run: #7a7066 was recoloured before the loop, the
   * only pass was rejected, and the reply still listed 「「著者」rgb(122, 112,
   * 102)」 — the colour the shipped document no longer had — while the score
   * deducted for it. Tracking what was actually measured is what makes the
   * re-walk fire.
   */
  let measuredHtml = ''
  /**
   * A React project puts none of its screens in the DOM — the ScreenId union
   * lives in routes.ts — so the list of what SHOULD be reachable has to travel
   * with the document. Read from the document being verified rather than once up
   * front, because a repair may have added a screen.
   */
  /**
   * Why the first render came back empty, when it did.
   *
   * `scoredFacts` being null used to be the whole story, and the reply read it
   * as 「このモードでは省略されます」 — on a 仕上げ run whose mode had asked for the
   * browser, on 2026-09-20, because the walk froze the page on its first item
   * click and the transport gave up at 45s. Kept so the reply can say what
   * actually happened and the repair loop can be handed the freeze.
   */
  let verifyFailure: VerifyFailure | null = null
  const verify = (doc: string) =>
    /**
     * The declared screen list, for every framework.
     *
     * Gated on React, so a Vue or Svelte project was verified with no list to
     * compare against — and `unreachable` is computed by subtracting what the
     * walk reached from what the project declares. With nothing declared, it
     * reported an empty list, which reads as "every screen is reachable". Two of
     * three frameworks could not produce that finding at all.
     *
     * `declaredScreenIds` reads `src/routes.ts`, which all three write.
     */
    verifyInBrowser(doc, {
      declaredScreens: declaredScreenIds(doc),
      requestId,
      onFailure: (f) => { verifyFailure = f },
    })

  if (useBrowserVerify) {
    t = Date.now()
    log('browser-verify')
    setPhase('ブラウザで実際に表示して検証中')
    let facts = await verify(finalHtml)
    measuredHtml = finalHtml
    /*
     * A page that stops answering when a control is pressed is the worst thing
     * a mock can do — the preview locks, and the reviewer has to reload — and it
     * was the one thing verification could not report, because it took the
     * verification down with it. Named from WALK_MARK, which crossed the socket
     * before the page stopped.
     */
    // Read through a cast: it is assigned inside `verify`'s callback, which
    // control-flow analysis cannot see, so it would otherwise narrow to null.
    const failure = verifyFailure as VerifyFailure | null
    if (!facts && failure?.reason === 'page-frozen') {
      runtimeDefects.push(pageFrozenDefect(failure))
      logger.warn('The page stopped responding during the walk', {
        requestId,
        frozeOn: failure.frozeOn,
        durationMs: failure.durationMs,
      })
    }

    /**
     * Fill the holes before anything else judges the page.
     *
     * An empty container cannot be repaired by the generic pass: that pass is
     * told to keep the existing markup and design exactly as they are, which is
     * the opposite of what filling a chart requires. Measured, it did the
     * conservative thing and left the hole. So the hole is filled here, by a
     * pass whose whole permission is to write into one named element, and the
     * result is only kept if rendering it again shows fewer holes.
     */
    /**
     * HTML only. The pass finds its target by matching the rendered element's
     * opening tag against the source, and for a React project the source is TSX:
     * the browser reports `<div class="chart">` and the file says
     * `<div className="chart">`, so nothing is ever located. Running it there
     * would spend a model call to reliably change nothing. React's empty
     * containers go to the general repair below, which is given whole files and
     * can actually edit them.
     */
    /**
     * The fill pass edits RENDERED markup, so it can only run on a document that
     * is its own markup.
     *
     * The skip was written as `outputKind === 'react'` and the run as
     * `outputKind !== 'react'`, which was right while React was the only project
     * format. It is not a fact about React: a Vue template and a Svelte
     * component are no more the rendered DOM than JSX is. So the two other
     * project formats were being sent into a pass that searches the source for
     * markup the browser measured — it can only fail to find it, and any match
     * it does make is a coincidence being written into a component.
     *
     * The question is whether the document is a project, and the repair loop is
     * what fills holes in one.
     */
    const holesFound = Boolean(facts?.screens.some((sc) => sc.emptyBoxes.length > 0))
    const isProjectDoc = detectKind(readProjectFiles(finalHtml).keys()) !== null
    if (isProjectDoc && holesFound) {
      logger.info('Empty container fill skipped — a project source file is not its rendered markup', {
        requestId,
        kind: outputKind,
        holes: facts!.screens.reduce((n, sc) => n + sc.emptyBoxes.length, 0),
      })
    }
    if (!isProjectDoc && facts && holesFound) {
      setPhase('空の枠を埋めています')
      const { fillEmptyContainers } = await import('./fill-empty.js')
      const holesBefore = facts.screens.reduce((n, sc) => n + sc.emptyBoxes.length, 0)
      const attempt = await fillEmptyContainers(finalHtml, facts, presetSpec, (system, user) =>
        invokeModel(modelId, system, user, 8000, null, 'repair:fill-empty')
      )
      if (attempt.filled.length > 0) {
        const refacts = await verify(attempt.html)
        const holesAfter = refacts ? refacts.screens.reduce((n, sc) => n + sc.emptyBoxes.length, 0) : holesBefore
        if (refacts && holesAfter < holesBefore) {
          // Measured before the assignment: reading the delta afterwards would
          // compare the new document against itself and always bill zero.
          finalHtml = attempt.html
          facts = refacts
          measuredHtml = attempt.html
          logger.info('Empty container fill accepted', { requestId, holesBefore, holesAfter, filled: attempt.filled })
        } else {
          logger.info('Empty container fill rejected — no measured improvement', {
            requestId,
            holesBefore,
            holesAfter,
          })
        }
      }
    }

    /**
     * The arithmetic defects, solved rather than described.
     *
     * `passingPair` already returns the exact colour that clears the ratio, and
     * the form-control floor is a rule the audit spells out in full — both were
     * being computed and then put in a prompt as advice. Applying them here
     * costs no model call and, for contrast, is the more reliable answer: a
     * computed colour clears 4.5:1, a chosen one might.
     *
     * Before the audit reads the facts, so a defect fixed here never reaches the
     * repair planner and never costs a file rewrite. The facts themselves are
     * not re-measured — the next verification does that — so a fix that did not
     * work reappears on the next pass rather than being trusted.
     */
    let settledIds: string[] = []
    if (facts) {
      const settled = applyDeterministicFixes(finalHtml, facts)
      /*
       * Keep the work whenever there was work, and claim only what was closed.
       *
       * These were one condition. `applyDeterministicFixes` marks `contrast-low`
       * fixed only when EVERY fault was recolourable — rightly, since a partial
       * fix leaves the defect open — and this adopted the document only when
       * something had been marked. So a pass that cleared three of five contrast
       * faults for nothing had its stylesheet thrown away, and the model was
       * then asked to redo all five.
       *
       * That is also why the stage looked idle: over 30 days it logged 3 times,
       * and a partial pass logs nothing because it claims nothing. Three of five
       * is invisible and total.
       *
       * The two questions are now separate. `settled.html` differs from the
       * input only when the stylesheet changed AND spliced, so it is the honest
       * test for "was anything done"; `settled.fixed` stays the honest answer to
       * "what may the planner stop worrying about".
       */
      const changed = settled.html !== finalHtml
      if (changed) finalHtml = settled.html
      settledIds = settled.fixed
      if (changed || settled.fixed.length > 0) {
        logger.info('Fixed deterministically, without a model call', {
          requestId,
          defects: settled.fixed.join(','),
          // Named so a partial pass can be told from a complete one in the log
          // this measurement comes from, rather than being absent from it.
          closed: settled.fixed.length,
          changes: settled.notes,
          partial: changed && settled.fixed.length === 0,
        })
      }
    }

    scoredFacts = facts
    if (facts) {
      /*
       * The facts are not re-measured, and the score is the pessimistic side of
       * that on purpose.
       *
       * `scoredFacts` still describes the document as it was before these fixes,
       * so a contrast fault that has just been corrected is still deducted for.
       * It is the safe direction: the alternative is a score that credits a fix
       * nothing has looked at. An accepted repair pass re-verifies and the score
       * becomes fresh; when none is accepted, the end-of-run re-walk does it,
       * because `measuredHtml` still names the document before these fixes.
       * Until then the pessimistic side holds.
       *
       * The DEFECT list is filtered, because that is the whole saving: a defect
       * left in it costs a file rewrite to change what is already changed.
       */
      runtimeDefects = auditRuntime(facts, finalHtml, presetName)
        .filter((d) => !settledIds.includes(d.id))
      logger.info('Runtime audit', {
        requestId,
        summary: summariseRuntime(facts),
        defects: runtimeDefects.map((d) => d.id).join(',') || 'none',
      })
      /**
       * Nothing rendered, so there is nothing to look at.
       *
       * Asking a vision model to critique the design of a blank page costs a
       * call and produces prose instead of JSON — measured twice in real logs,
       * both of them 「提供いただいた画像が完全に白色で、UIの内容が確認できません」
       * on runs whose app had thrown before mounting. That surfaced as
       * "Visual critique returned no parsable JSON", which reads like a fault in
       * the critic and is not one: the critic was right, and the screenshot was
       * blank. The defect is already reported by `console-error` and
       * `import-missing`, which name what to fix.
       */
      if (!profile.visualCritic) {
        logger.info('Visual critique skipped — not in this effort profile', { requestId })
      } else if (facts.screens.length === 0) {
        logger.info('Visual critique skipped — nothing rendered', {
          requestId,
          consoleErrors: facts.consoleErrors.length,
        })
      } else {
        visualDefects = await critiqueScreenshot(
          facts.screenshot,
          [`プロダクト: ${prompt.slice(0, 120)}`, presetScaleNote(presetName)].filter(Boolean).join('\n'),
          (system, user, image) => invokeModel(modelId, system, user, 2000, image, 'critic:visual')
        )
      }
    }
    done('browser-verify', t)
  }

  /**
   * Everything currently wrong with the document, from every instrument.
   *
   * The runtime and visual findings are passed in rather than re-derived: they
   * come from a render, and a render is not something a pure function of the
   * source can repeat.
   */
  /**
   * Drift from the bound design system, as something the repair loop can work on.
   *
   * There is a conformance pass earlier that rewrites the whole document in one
   * call, and on an HTML mock it works. On a React project it is the shape this
   * pipeline has repeatedly measured failing: thirty files re-emitted to change
   * a stylesheet. Stating the drift as a defect puts it into the loop that
   * already converges — per file, re-measured every pass, accepted only when the
   * count actually falls.
   *
   * A preset is chosen precisely so the output does not look machine-made, and
   * "the system was applied to the first screen and abandoned by the third" is
   * the form that failure takes. One pass was never going to be enough for it.
   */
  const presetDefects = (doc: string): InteractionDefect[] => {
    if (!presetName || presetName === 'none') return []
    const c = presetConformance(doc, presetName)
    if ((c.ratio >= 1 && c.violations === 0) || c.details.length === 0) return []
    return [
      {
        id: 'preset-drift',
        instruction:
          `デザインシステム「${presetName}」から逸脱している箇所があります。` +
          `システムが定義する値だけを使うように直してください（新しい色・角丸・影・フォントを作らないこと）:\n` +
          [...c.details.slice(0, 8), ...measureComponentDrift(doc, presetName).details].map((d, i) => `${i + 1}. ${d}`).join('\n') +
          '\n値は styles/tokens.css に定義し、使用箇所はそのトークンを参照する形にしてください。' +
          '内容・文言・構造は変更しないでください。',
      },
    ]
  }

  const collectDefects = (
    doc: string,
    rt: InteractionDefect[],
    vis: InteractionDefect[]
  ): InteractionDefect[] => [
    ...auditInteractivity(doc, outputKind),
    ...auditShellContract(doc, outputKind),
    ...auditSeedData(doc),
    ...auditAiTells(doc, presetName, outputKind),
    ...auditDesignSystem(doc),
    ...presetDefects(doc),
    /**
     * Named before the browser has to discover it.
     *
     * A missing module is not a degraded import, it is the end of the program —
     * and it reaches the runtime audit as one `console-error` carrying a stack,
     * which the repair planner has to reverse-engineer into "write this file".
     * Measured: it did not, and a six-screen application shipped blank.
     */
    ...moduleDefects(doc),
    /**
     * The quieter cousin of a missing module, and the reason it needs naming
     * here: an unresolved component does not fail anything. It compiles, the
     * page paints, and the element is inert. Measured on a generated Vue
     * project — a sidebar of `<router-link>` with vue-router absent — the app
     * looked complete and not one of its six screens could be reached.
     */
    ...unresolvedComponentDefects(doc, outputKind),
    /**
     * And the one that compiles, builds, and throws on the first render: a name
     * destructured out of an object that never carried it. Both halves are
     * valid on their own and they live in different files, so nothing upstream
     * of the browser can see the mismatch.
     */
    ...destructuredKeyDefects(doc),
    /**
     * And the one that throws nothing at all: a loop reading a property its own
     * data never carries. `{#each NAV_ITEMS as item}<a href={item.hash}>` over
     * elements of `{ id, label }` renders every nav link without an href, so
     * the nav is drawn, correctly labelled, and inert.
     *
     * The walk does catch it, as `nav-dead-runtime` — after the fact and by the
     * symptom. That tells a repair pass a button did nothing and leaves it to
     * find out why; this names the property and the file.
     */
    ...missingItemKeyDefects(doc),
    /**
     * And the one that waits until the user interacts: a hook behind a branch.
     * React pairs hooks with their state by call order, so the screen works
     * until the condition flips and then error #310 takes it down.
     */
    ...conditionalHookDefects(doc),
    /**
     * And the one that is not a defect in the code at all: the response stopped
     * mid-file. Named because the compiler's account of it — an invalid end tag
     * in the file that never closed — sends the repair pass after a markup bug
     * that does not exist.
     */
    ...truncatedDocumentDefects(doc),
    /**
     * And a root waiting on props nothing can pass. Ordinary missing props have
     * a parent that could supply them; the root has none, so this is decidable
     * from the entry alone.
     */
    ...rootPropsNeverPassedDefects(doc),
    /**
     * And the ordinary case one level down: a child that declares a prop as
     * required, rendered by a parent that passes nothing. The parent usually
     * holds a binding of exactly that name, which is what makes it easy to
     * write and invisible to read.
     */
    ...requiredPropNeverPassedDefects(doc),
    /**
     * And the version-mixing that stops the bundle outright. The compiler does
     * report it, but as a parser position — measured, `Unexpected keyword
     * 'class'` for a component whose real problem was that its props were
     * written in Svelte 4 style. A repair pass given the position fixes a line;
     * given the idiom it can rewrite the declaration.
     */
    /*
     * And the one shape no deterministic repair should touch: a Svelte or Vue
     * component returning JSX from its script. Rewriting it means deciding
     * where the conditional ends and what the other branch renders — judgement,
     * and a wrong guess ships a wrong interface rather than a blank one.
     */
    ...frameworkConfusionDefects(doc, outputKind),
    /**
     * Also named before the browser has to discover it, and for a stronger
     * reason than a missing module: a file that does not parse stops the bundle,
     * so nothing renders and every other audit on this list has nothing to look
     * at. It reached the planner as one `console-error` carrying a parser
     * position in a file it could not see, and the position is routinely not
     * even the faulty line. `repairSyntax` has already had a free go at these,
     * so anything still here needs a model.
     */
    ...syntaxDefects(doc),
    /*
     * What the user asked for, checked against what was built.
     *
     * Here and nowhere else, so it is measured by the same collector before and
     * after a repair pass — the judge was found measuring `after` with a shorter
     * list than `before`, and a check added only to one side would read as fixed
     * every time. Deterministic: grep over the source, so it is convergent and
     * gets a vote on whether a pass counted.
     */
    ...requirementDefects(checkRequirements(doc, requirements)),
    ...rt,
    ...vis,
  ]

  /**
   * A defect a second pass can be trusted to have actually fixed.
   *
   * Every audit here is a function of the document or of a render: run it twice
   * on the same input and it says the same thing, so "three became one" is a
   * measurement. The visual critic is not — it is a vision model looking at a
   * fresh screenshot, and it returns a different list each time it is asked.
   * Measured on one run: `visual-accent` vanished and `visual-density` appeared
   * across a single pass, and neither had been touched.
   *
   * The critic is still worth having, and its findings are still handed to the
   * repair. What they cannot do is decide whether to spend another pass — four
   * findings becoming three tells you the sample changed, not that the page did.
   */
  const convergent = (d: InteractionDefect) => !d.id.startsWith('visual-')

  /**
   * Decides whether a candidate document replaces the current one, and applies it.
   *
   * Shared by both repair shapes so that a per-file repair is held to exactly the
   * same standard as a whole-document one. The rule has not changed: re-measure
   * with the instruments that produced the complaint, and keep the result only if
   * it measurably improved.
   */
  const judgeRepair = async (
    candidate: string,
    before: InteractionDefect[],
    pass: number,
    kind: string,
    minLength: number,
    /** True on the one retry below, so it cannot recurse further. */
    isRetry = false
  ): Promise<boolean> => {
    /*
     * The deterministic corrections first, on the candidate as well as on the
     * document that ships.
     *
     * `fixupProject` ran after the build and again after the repair loop, and
     * never on what a repair pass returned — so a candidate carrying a mistake it
     * rewrites in milliseconds (a named import of a default export, a default
     * import of a named one) was rendered, went blank, and was rejected, with
     * every other fix in the pass thrown away. The document that would have
     * shipped after the loop gets these same corrections; judging the candidate
     * without them was judging a document nobody would receive.
     */
    if (!isRetry) {
      const corrected = fixupProject(candidate, outputKind)
      if (corrected.fixed.length > 0) {
        logger.info('Corrected a repair candidate before judging it', {
          requestId, pass, kind, fixed: corrected.fixed.slice(0, 6),
        })
        candidate = corrected.html
      }
    }
    /**
     * A project that no longer compiles is rejected before anything else looks
     * at it. Every other check would read it as an improvement — a file that
     * fails to parse contributes no patterns for the audits to complain about.
     */
    {
      /**
       * Every framework, not only React. `toRunnableDocument` reads the
       * framework off the file extensions and compiles with that framework's
       * own compiler, so gating this on `outputKind === 'react'` did not make
       * the check safer — it just let a Vue or Svelte repair that no longer
       * builds past the one instrument that would have caught it.
       */
      const compiled = toRunnableDocument(candidate, outputKind)
      if (compiled.error) {
        /*
         * One bad file should not discard the other eight — the same rule the
         * routing retry below follows, and the one repair-files.ts states as
         * 「Independent files must fail independently」.
         *
         * The compiler names the file it choked on, so there is nothing to
         * reason about: put that file back and ask again. Measured over 45 days,
         * thirteen passes were rejected here, and in ten of them the named file
         * was one this pass had written.
         *
         * In the other three it was not, and that case is worth its own line in
         * the log rather than a silent rejection: the document was already
         * broken before the pass, and every attempt against it was being blamed
         * for a fault it did not introduce.
         */
        const inCandidate = readProjectFiles(candidate)
        const inBase = readProjectFiles(finalHtml)
        const named = [...inCandidate.keys()].filter((f) => compiled.error!.includes(f))
        const written = named.filter((f) => inBase.get(f) !== inCandidate.get(f))
        if (!isRetry && written.length > 0) {
          const reduced = withoutFiles(finalHtml, candidate, written)
          if (reduced) {
            logger.info('Retrying the repair without the file that will not compile', {
              requestId, pass, kind, reverted: reduced.reverted, dropped: reduced.dropped,
            })
            return judgeRepair(reduced.html, before, pass, `${kind} (uncompilable file reverted)`, minLength, true)
          }
        }
        logger.info('Interaction repair rejected', {
          requestId,
          pass,
          kind,
          reason: 'no longer compiles',
          error: compiled.error,
          named,
          writtenByThisPass: written,
        })
        return false
      }
      /**
       * And the converse, which is the case that was shipping broken output.
       *
       * When the document currently in hand does NOT compile, a candidate that
       * does is an improvement whatever else it measures — there is no "else",
       * because a project that cannot build renders nothing and every audit
       * below is scoring a blank page. The measured failure: a Svelte
       * `HomeScreen.svelte` with a syntax error, a repair that fixed it and
       * scored lower on the audits (having produced a page with real content to
       * find fault with), and the repair rejected for not measuring better. The
       * broken version shipped.
       *
       * "Only keep it if it measured better" is the right rule between two
       * working documents and the wrong one when the incumbent is not a
       * document at all.
       */
      if (toRunnableDocument(finalHtml, outputKind).error) {
        logger.info('Interaction repair accepted — it makes the project build again', {
          requestId,
          pass,
          kind,
        })
        return true
      }
    }

    /*
     * The same guard for a page that builds and renders nothing was proposed,
     * measured, and is not here.
     *
     * The argument was symmetry: a blank page has no buttons to be dead, no
     * screens to be unreachable and no contrast to be low, so the pass that
     * unblanks it is judged by a count its own fix pushes up. That is real —
     * every accepted pass whose carried set grew (5 of 158) had `blank-render`
     * or `layout-broken` in front of it, and what it "gained" was defects that
     * were always there and could not be seen.
     *
     * What the guard would have to be worth is passes rejected for it. Over 45
     * days, eight rejected passes had cleared one of those, and every one of
     * them carried a regression entry of its own, or was still throwing, or was
     * still blind somewhere else. Not one was a clean fix thrown away. Three
     * runs in 247 ended with the page still blank.
     *
     * So the rule is right for the wrong-sounding reason: it is not rejecting
     * unblanking, it is rejecting unblanking-and-breaking, which is what those
     * candidates were. Re-propose it when a clean one shows up in the log.
     */

    /**
     * Re-measure with the same instruments that produced the complaint.
     *
     * `before` may include runtime and visual findings, and those cannot be
     * re-derived from the source. Comparing a mixed "before" against a
     * static-only "after" would make every repair look successful in proportion
     * to how many browser defects it was given — the repair would be accepted
     * precisely when it was least verified. So when the browser found something,
     * the browser is asked again.
     */
    const usedBrowser = runtimeDefects.length > 0 || visualDefects.length > 0
    let repairedFacts: Awaited<ReturnType<typeof verifyInBrowser>> = null
    let afterRuntime: InteractionDefect[] = []
    let afterVisual: InteractionDefect[] = []
    if (usedBrowser) {
      const factsAfter = await verify(candidate)
      repairedFacts = factsAfter
      if (factsAfter) {
        /*
         * The arithmetic contrast fix, on the candidate as on the build.
         *
         * A rewrite that introduces a failing colour was counted against itself
         * for a fault the pipeline corrects for nothing before the loop even
         * starts: the inventory run of 2026-09-13 was rejected partly on a
         * 3.19:1 label. Applied here the same way it is applied there — the
         * document changes, the facts are not re-measured, and a fault closed by
         * it is not counted.
         */
        const settled = applyDeterministicFixes(candidate, factsAfter)
        if (settled.html !== candidate) {
          logger.info('Fixed a repair candidate deterministically before judging it', {
            requestId, pass, kind, closed: settled.fixed, changes: settled.notes,
          })
          candidate = settled.html
        }
        // Absolute defects, plus anything this repair made worse. The absolute
        // rules are deliberately conservative and a real regression can pass
        // under them; a delta cannot be argued with.
        afterRuntime = [
          ...auditRuntime(factsAfter, candidate, presetName),
          ...(scoredFacts ? runtimeRegressions(scoredFacts, factsAfter) : []),
        ].filter((d) => !(settled.fixed.includes('contrast-low') && (d.id === 'contrast-low' || d.id === 'contrast-introduced')))
        // The critic is asked later, and only when its answer is used — see
        // `critiqueCandidate` below.
      } else {
        // The browser was available before and is not now. Carry the original
        // findings forward rather than counting them as fixed.
        afterRuntime = runtimeDefects
        afterVisual = visualDefects
      }
    }
    /*
     * Measured with the SAME collector that produced `before`.
     *
     * This was a hand-kept list of five auditors, while `before` comes from
     * `collectDefects`, which has grown to fifteen — every auditor added since
     * (missing modules, unresolved components, required props never passed,
     * legacy idioms, syntax errors, preset drift…) was appended there and never
     * here. So a defect from any of those ten could be handed to a pass and
     * could not be reported as remaining afterwards: it dropped out of the count
     * whether or not it was fixed.
     *
     * Measured over 30 days: thirteen defect ids were handed to passes and never
     * once appeared in a judge's `remaining` list, which is why `FIX_RATE` shows
     * import-missing, required-prop-missing, component-unresolved,
     * svelte-legacy-idiom and preset-drift at exactly 100% — the number is the
     * blind spot, not the repair. And 34 of 191 accepted passes counted as an
     * improvement only because those ids fell out of `after`.
     *
     * One list, two measurements, is the only arrangement where "fewer" means
     * the document changed rather than the ruler did.
     */
    /*
     * The critic, asked only when what it says is used.
     *
     * Its findings get no vote whenever the document has a convergent one (see
     * `convergentCount` below), and a rejected candidate is thrown away with
     * everything measured on it. So critiquing every candidate paid a vision
     * call per rejection — and per revert-retry of it — for a list nobody read.
     * Asked here: before the verdict when the verdict is taken on the total,
     * after it when the candidate is accepted and its findings become the next
     * pass's input and the reply's. `collectDefects` appends the critic's list
     * last and nothing convergent depends on it, so the verdict is unchanged.
     */
    let critiqued = false
    const critiqueCandidate = async (): Promise<void> => {
      if (critiqued || !repairedFacts) return
      critiqued = true
      // Same reason as the first pass: a repair that leaves the app unable to
      // mount has nothing to look at, and the runtime audit already says so.
      afterVisual =
        !profile.visualCritic || repairedFacts.screens.length === 0
          ? []
          : await critiqueScreenshot(
              repairedFacts.screenshot,
              [`プロダクト: ${prompt.slice(0, 120)}`, presetScaleNote(presetName)].filter(Boolean).join('\n'),
              (system, user, image) => invokeModel(modelId, system, user, 2000, image, 'critic:visual')
            )
    }
    if (!before.some(convergent)) await critiqueCandidate()
    let after = collectDefects(candidate, afterRuntime, afterVisual)
    // Length is checked as well as defect count, because fewer defects is not by
    // itself evidence of a better document: a model that stops early returns a
    // partial project that scores BETTER simply by having lost the files the
    // checks look at. A repair that drops a sixth of the document is a loss.
    const longEnough = candidate.length >= minLength

    /**
     * Judged on the findings that mean the same thing twice.
     *
     * Counting everything looked right and was not. Measured on a real run: a
     * per-file repair fixed both deterministic defects it was given — the
     * missing icons folder and the missing illustrations — and introduced one,
     * so the part of the verdict that reproduces went 2 to 1. It was rejected,
     * because the critic had meanwhile re-sampled its own findings from a fresh
     * screenshot: `hierarchy` came back as `typography` and `spacing` came back
     * twice, and the total held at five.
     *
     * A test that a re-sample can overturn is not measuring the document. So the
     * convergent findings decide, and the critic's decide nothing — they are
     * still shown to the repair, and still shown to the user, they just no
     * longer get a vote on whether the work counted.
     *
     * When there is nothing convergent to judge by, the total is all there is;
     * a purely visual repair can still be accepted, once, on that basis.
     */
    const convergentCount = (list: InteractionDefect[]) => list.filter(convergent).length
    /**
     * Three findings that no count can outweigh.
     *
     * The verdict is a comparison of how many findings there are, and a repair
     * that closes two while breaking the application still looks like a net
     * gain. Measured on the v197 React run, accepted at pass 1:
     *
     *     before 12 after 11 — accepted
     *     remaining: … 'unreachable-introduced', 'console-error-introduced' …
     *
     * The pass introduced a JavaScript error and made screens unreachable, and
     * was kept because eleven is fewer than twelve. The first verification of
     * that document had measured four screens at full fill; every verification
     * after this pass measured one, and the run shipped at 42 with a React
     * error on the page and three of its four screens unopenable.
     *
     * These three are not findings about the document, they are findings about
     * THIS EDIT: it rendered before and does not now, it was reachable before
     * and is not now, it was quiet before and throws now. Each is a statement
     * that the previous document was better, so trading them away for a lower
     * total is trading away the thing being measured.
     *
     * The other `-introduced` markers stay tradeable on purpose. A contrast
     * pair or an empty container arriving alongside two real fixes is worth
     * keeping and repairing next pass; a page that has stopped working is not.
     *
     * A rejection here ends the loop, as any rejection does, and that is the
     * right outcome rather than a cost: the document it keeps is the one from
     * before the pass, which rendered and could be navigated. The loop cannot
     * "try something else" — asking the same prompt over the same defects is a
     * resample, which is what this loop exists not to do.
     *
     * Measured over the last twenty-two accepted repairs in the log: fourteen
     * of them carried one of these three.
     */
    const BREAKING = new Set(['render-lost', 'unreachable-introduced', 'console-error-introduced'])
    const broke = after.filter((d) => BREAKING.has(d.id))
    /**
     * One bad file should not discard the other nine.
     *
     * All three breaking findings are about rendering and routing, and those
     * live in a known set of files. So the retry keeps everything else — the
     * icons, the components, the stylesheet — and puts the routing files back
     * the way they were. If a component was the culprit after all, the retry
     * breaks too and the original rejection stands.
     *
     * It costs one browser verification and no model call, which is why it is
     * worth trying at all rather than reasoning about which file it was.
     */
    /*
     * A candidate that broke the app says what broke it, and is kept.
     *
     * The runtime error is React #130 more often than not, and #130 names no
     * component; the static check can name the import. The candidate itself goes
     * to S3 for a week so the next person can open the document instead of
     * guessing at it — see utils/rejected-candidate.ts.
     */
    const mismatched = broke.length > 0 && !isRetry ? missingExports(candidate) : []
    if (broke.length > 0 && !isRetry) {
      const base = readProjectFiles(finalHtml)
      logger.info('A repair candidate broke the app', {
        requestId,
        pass,
        kind,
        broke: broke.map((d) => d.id),
        runtimeErrors: repairedFacts?.consoleErrors.slice(0, 2) ?? [],
        missingExports: mismatched.slice(0, 8).map((m) => `${m.importer} -> ${m.target}: ${m.name}`),
        written: [...readProjectFiles(candidate)].filter(([p, b]) => base.get(p) !== b).map(([p]) => p).slice(0, 30),
      })
      keepRejectedCandidate(requestId, pass, kind, candidate)
    }
    if (broke.length > 0 && !isRetry) {
      const reduced = withoutRoutingChanges(finalHtml, candidate, outputKind)
      if (reduced) {
        logger.info('Retrying the repair without the files that route', {
          requestId,
          pass,
          kind,
          broke: broke.map((d) => d.id),
          kept: reduced.kept,
          reverted: reduced.reverted,
          dropped: reduced.dropped,
        })
        if (await judgeRepair(reduced.html, before, pass, `${kind} (routing reverted)`, minLength, true))
          return true
      }
      /*
       * Then one file at a time — see `revertSuspects`.
       *
       * The routing revert puts every screen back at once, and a pass whose work
       * is in the screens loses all of it for one bad screen. Each attempt is a
       * browser run and, when the page renders, one critic call; bounded so a
       * pass that is broken everywhere costs a few seconds more, not a minute.
       */
      // An importer the static check names is the likeliest culprit: its path in
      // the evidence ranks it first — see `revertSuspects`.
      const suspects = revertSuspects(finalHtml, candidate, [
        ...(repairedFacts?.consoleErrors ?? []),
        ...mismatched.map((m) => m.importer),
      ])
        .filter((path) => !(reduced && reduced.reverted.length === 1 && reduced.reverted[0] === path))
        .slice(0, MAX_SINGLE_REVERTS)
      for (const path of suspects) {
        const one = withoutFiles(finalHtml, candidate, [path])
        if (!one) continue
        logger.info('Retrying the repair without one file', { requestId, pass, kind, reverted: path, dropped: one.dropped, suspects })
        if (await judgeRepair(one.html, before, pass, `${kind} (${path} reverted)`, minLength, true)) return true
      }
    }
    /*
     * Weighted, so a screen made usable outweighs a glyph — see defect-weight.ts.
     * The convergent findings still decide and the critic's still do not.
     */
    const weighed = (list: InteractionDefect[]) => weightedCount(list.filter(convergent))
    const improved =
      convergentCount(before) > 0
        ? weighed(after) < weighed(before)
        : after.length < before.length
    if (improved && longEnough && broke.length === 0) {
      if (!critiqued) {
        await critiqueCandidate()
        after = collectDefects(candidate, afterRuntime, afterVisual)
      }
      finalHtml = candidate
      if (repairedFacts) {
        scoredFacts = repairedFacts
        measuredHtml = candidate
      }
      /**
       * The next round starts from what this render actually found.
       *
       * `after` carries the regression entries too, and those are a judgement
       * about this one pass rather than a property of the document — carrying
       * them forward would have the loop chasing a complaint about an edit it
       * already accepted.
       */
      if (repairedFacts) {
        runtimeDefects = auditRuntime(repairedFacts, finalHtml, presetName)
        visualDefects = afterVisual
      }
      openDefects = collectDefects(finalHtml, runtimeDefects, visualDefects)
      logger.info('Interaction repair accepted', {
        requestId,
        pass,
        kind,
        before: before.length,
        after: after.length,
        weightedBefore: weighed(before),
        weightedAfter: weighed(after),
        remaining: after.map((d) => d.id),
      })
      return true
    }
    logger.info('Interaction repair rejected', {
      requestId,
      pass,
      kind,
      reason: broke.length > 0
        ? `broke the app: ${broke.map((d) => d.id).join(', ')}`
        : longEnough
          ? 'no improvement'
          : 'document shrank',
      before: before.length,
      after: after.length,
      // The counts the verdict was actually taken on. Without these the log
      // shows "5 and 5" for a repair that halved the findings that matter.
      convergentBefore: convergentCount(before),
      convergentAfter: convergentCount(after),
      weightedBefore: weighed(before),
      weightedAfter: weighed(after),
      remaining: after.map((d) => d.id),
      // Without the critic's findings when it was not asked — see `critiqueCandidate`.
      critic: critiqued ? 'asked' : 'not asked',
      // The error itself, not just that there was one. A rejection reading
      // `console-error` names a category; the next person needs the message.
      runtimeErrors: repairedFacts?.consoleErrors.slice(0, 2) ?? [],
      beforeLen: finalHtml.length,
      afterLen: candidate.length,
    })
    return false
  }

  /**
   * Repairs a React project file by file, or returns null to fall through.
   *
   * Returns null — rather than an unchanged document — when the planner produced
   * nothing usable, so the caller can tell "there was nothing to do this way"
   * from "this was tried and did not help".
   */
  /**
   * How much rewriting this run may still do, across every pass.
   *
   * One per generation, deliberately: three passes each obeying their own limit
   * is three times that limit, which is the shape the measurement found.
   */
  const repairBudget = new RepairBudget()
  /** Defects planned against but never given a call. Reported, not swallowed. */
  let unrepairedDefects = 0

  const repairProjectByFile = async (defects: InteractionDefect[]): Promise<string | null> => {
    const { planFileRepairs, repairFiles } = await import('./repair-files.js')
    const planModelId = await routerModelId()

    /*
     * The planner decides where a defect belongs, including the CSS ones.
     *
     * Routing `contrast-low` and `input-small` straight to the stylesheet was
     * tried and withdrawn, because the deterministic pass above already takes
     * every case where the stylesheet is the right target — it settles contrast
     * only when the failing colour is IN the stylesheet, and adds the form rule
     * whenever one exists. So a CSS defect that survives to here is, by
     * construction, one the stylesheet cannot fix: the v205 case, where the
     * colour was written into four components and no token existed. Sending it
     * to the stylesheet would have spent a call on a file that does not contain
     * the problem.
     */
    /*
     * Haiku, like every other classification in this pipeline.
     *
     * `routerModelId` was written for exactly this and one other caller — its
     * note says so, 「which specialists to use, which files a defect belongs
     * to」 — and only the first was ever wired to it. This one has been paying
     * the generation model's rate to read a list of filenames and a list of
     * defect sentences and say which goes with which; it sees nothing else, by
     * design. 67 calls in 14 days at three times the price of the model that
     * should have been making them.
     */
    const planned = await planFileRepairs(finalHtml, defects, (system, user) =>
      invokeModel(planModelId, system, user, 2000, null, 'repair:plan')
    )
    if (planned.length === 0) {
      logger.info('No per-file repair plan; falling back to the whole document', { requestId })
      return null
    }
    /*
     * What this run is still allowed to rewrite — see repair-budget.ts.
     *
     * Applied to the plan rather than inside the fan-out below, because the
     * fan-out is a single `Promise.all` over the plans: by the time a call is in
     * flight there is nothing left to decide.
     */
    const { run: plans, skipped: unrepaired } = repairBudget.admit(planned)
    unrepairedDefects += unrepaired.reduce((sum, u) => sum + u.defects, 0)
    if (unrepaired.length > 0) {
      logger.info('Repair budget: some files were not rewritten', {
        requestId,
        spent: repairBudget.spent,
        unrepaired: unrepaired.map((u) => `${u.path}:${u.defects}(${u.reason})`),
      })
    }
    if (plans.length === 0) {
      logger.info('Repair budget spent; nothing left to plan against', { requestId })
      return null
    }
    logger.info('Per-file repair planned', {
      requestId,
      files: plans.map((p) => `${p.path}${p.create ? '(new)' : ''}:${p.defects.length}`),
    })
    setPhase(`${plans.length}個のファイルを修正中`)
    const { html, written, skipped } = await repairFiles(finalHtml, plans, (system, user) =>
      invokeModel(modelId, system, user, 16000, null, 'repair:per-file')
    )
    if (written.length === 0) {
      logger.info('Per-file repair wrote nothing; falling back to the whole document', {
        requestId,
        skipped,
      })
      return null
    }
    logger.info('Per-file repair applied', { requestId, written, skipped })
    return html
  }

  /**
   * Repair, re-measure, repeat while it is still working.
   *
   * A single pass was measured taking a document from 3 defects to 1 and
   * stopping there, with the last one shipping. Nothing about that pass was
   * exhausted — it simply was not asked again.
   *
   * The loop is bounded four ways, and each bound answers a different failure:
   * MAX_REPAIR_PASSES caps the cost, REPAIR_BUDGET_MS caps the wall clock so a
   * run cannot be killed by the client's timeout, a pass that does not measurably
   * improve the document ends it, and a document whose only remaining findings
   * are the critic's gets one pass rather than three. The same prompt over the
   * same defects is a resample, not a repair, and this loop exists precisely
   * because resampling for a better number is not a strategy.
   */
  let openDefects = collectDefects(finalHtml, runtimeDefects, visualDefects)

  /**
   * A project that does not build gets a pass even in the modes that buy none.
   *
   * `economy` and `fast` set `repairPasses: 0` deliberately, and that is the
   * right trade for polish — the user asked for cheap or quick and accepted a
   * less finished interface. It is not the right trade for a build failure.
   * "Less complete" and "does not compile" are different things: one is a
   * weaker deliverable, the other is not a deliverable at all, and nobody
   * choosing 節約 was choosing that.
   *
   * Measured on Haiku at `fast`: three consecutive Svelte generations each
   * failed to compile for a different reason, the last because the model wrote
   * JSX inside a `<script>` block — React idiom in a Svelte component. That is
   * exactly the kind of mistake one pass fixes and no rewrite rule can.
   *
   * The floor is one pass, not the full budget: the aim is a project that
   * builds, not a polished one.
   */
  const buildBroken = openDefects.some((d) => d.id === 'syntax-error' || d.id === 'import-missing')
  /*
   * Passes, which is not the same quantity as work — see repair-budget.ts. A
   * pass plans one call per defective file, so this number never said how many
   * calls it was buying. `repairBudget` below bounds that.
   */
  const passBudget = Math.max(profile.repairPasses, buildBroken ? 1 : 0)
  if (passBudget > profile.repairPasses) {
    logger.info('Spending a repair pass the effort profile did not buy: the project does not build', {
      requestId,
      effort,
      defects: openDefects.map((d) => d.id),
    })
  }

  /**
   * Which defect ids this run has already paid a pass to attempt.
   *
   * Measured over 45 days: a first attempt at a defect lands 44% of the time, a
   * second 28%, a third 23% — no cliff by attempt number. By id there is one, and
   * it is wide: everything at or below 18% and everything at or above 50%, with
   * nothing between. The ids under it are in repair-yield.ts.
   */
  const attemptedIds = new Set<string>()
  for (let pass = 1; pass <= passBudget && openDefects.length > 0; pass++) {
    if (pass > 1 && !openDefects.some(convergent)) {
      logger.info('Only re-sampled findings remain; not spending another pass', {
        requestId,
        pass,
        remaining: openDefects.map((d) => d.id),
      })
      break
    }
    const elapsed = Date.now() - startTime
    if (elapsed > REPAIR_BUDGET_MS) {
      logger.info('Repair budget spent; shipping with open defects', {
        requestId,
        pass,
        elapsedMs: elapsed,
        remaining: openDefects.map((d) => d.id),
      })
      break
    }
    /*
     * Only the defects a repair pass has ever actually fixed — see
     * repair-yield.ts for the measurement and for why each excluded id is on
     * that list.
     *
     * The skipped ones stay in `openDefects`: the score still deducts for them
     * and the reply still reports them. What stops is paying a model to attempt
     * what it has not managed 96 times out of 100.
     */
    const { attempt: defects, skipped: notWorthTrying } = worthRepairing(openDefects, attemptedIds)
    if (notWorthTrying.length > 0) {
      logger.info('Defects reported but not repaired — measured yield too low', {
        requestId,
        pass,
        skipped: notWorthTrying.map((d) => d.id),
        retried: notWorthTrying.filter((d) => attemptedIds.has(d.id)).map((d) => d.id),
      })
    }
    /*
     * Everything this pass is about to attempt counts as attempted, whether the
     * pass is accepted or not.
     *
     * A rejected pass threw its document away, so nothing in it was fixed — but
     * the call was made and the model was given the defect. Counting only
     * accepted passes would let a run pay three times for the same defect and
     * call each of them a first attempt.
     */
    for (const d of defects) attemptedIds.add(d.id)
    /*
     * Nothing left to attempt is the end of the loop, not an empty pass. A
     * planner given no defects returns no plan, and the whole-document fallback
     * behind it would rewrite the project against an empty instruction.
     */
    if (defects.length === 0) {
      logger.info('Shipping with open defects: none of them are ones a pass fixes', {
        requestId,
        pass,
        remaining: openDefects.map((d) => d.id),
      })
      break
    }
    /*
     * And a nearly-clean document is not worth another pass either.
     *
     * Measured over 14 days: a pass opened on one or two attemptable defects was
     * accepted 0 times out of 7 and made the document worse in 6 of them, by a
     * median of four new defects — see REPAIR_FLOOR. The rejection throws the
     * damage away, so nothing ships broken; what is lost is the tokens.
     *
     * After the first pass only. All seven were a second or third pass, and a
     * run whose FIRST pass has two defects should still get its one attempt —
     * the floor is about diminishing returns within a run, not about refusing to
     * repair a document that arrived nearly clean.
     */
    if (pass > 1 && defects.length <= REPAIR_FLOOR) {
      logger.info('Shipping with open defects: too few left for a pass to help', {
        requestId,
        pass,
        attemptable: defects.map((d) => d.id),
        remaining: openDefects.map((d) => d.id),
      })
      break
    }
    {
      t = Date.now()
      log('interaction-repair')
      logger.info('Quality defects detected', {
        requestId,
        outputKind,
        pass,
        defects: defects.map((d) => d.id),
      })
      setPhase(
        pass === 1 ? '動作とデザインを検証・修正中' : `残った不備を修正中（${pass}回目）`
      )
      try {
        /**
         * A React project is repaired file by file; a single HTML page is not.
         *
         * The page is one file, so "rewrite the document" and "rewrite the file"
         * are the same request and the whole-document pass is already the right
         * shape for it. A project is not: measured, one call asked to re-emit
         * eighty-eight kilobytes across a dozen files while holding eight
         * unrelated instructions returned exactly as many defects as it was
         * given.
         *
         * Falls through to the whole-document pass whenever planning produces
         * nothing to do, so this can only add a path, never remove one.
         */
        /**
         * Per-file repair for every framework.
         *
         * This read `outputKind === 'react' ? … : null`, so a Vue or Svelte
         * generation skipped the per-file path entirely and went to the
         * whole-document prompt below — which, on the other side of its
         * ternary, told the model it was holding "a generated HTML mock" and
         * to return a document starting with <!DOCTYPE html>. The result was
         * then rejected for not containing <html>, so a Vue project's repair
         * loop could not accept anything and every measured defect shipped.
         */
        const repaired = await repairProjectByFile(defects)
        if (repaired !== null) {
          const accepted = await judgeRepair(
            repaired,
            defects,
            pass,
            'per-file',
            // Only file bodies were replaced, so the document should come back
            // about the same size. A big shrink means a file was gutted.
            finalHtml.length * 0.85
          )
          done('interaction-repair', t)
          if (accepted) continue
          break
        }
        /**
         * The fallback prompt describes the document that is actually being
         * repaired. Both arms of the ternary this replaces were wrong: one
         * named the `<script type="text/jsx">` transport that nothing has
         * emitted since components with their own <script> forced line fences,
         * and the other described a single HTML mock, a format this product no
         * longer produces at all.
         */
        const whole = await invokeModelStreaming(modelId,
          `You repair a generated ${FRAMEWORKS[outputKind].label} project so that every screen and control actually works.

Rules:
- The document is a set of source files separated by whole-line fences:
    @@@makeui:file <path>
    …the file's contents, verbatim…
    @@@makeui:endfile
  Keep every fence and its path exactly. Never wrap a file in <script> or <style>.
- Keep the existing design exactly as it is. Do not restyle the app, and do not
  rename or delete existing files.
- Fix ONLY the listed defects, plus whatever wiring those fixes require.
- When a defect asks for a file that does not exist yet, ADD it as a new fenced
  block and import it where it belongs. Keeping the existing files does not forbid
  new ones — a defect that names a missing path can only be fixed by creating it.
- Do not add dependencies. Available: ${FRAMEWORKS[outputKind].packages}.
- Preserve TypeScript: real annotations, no "any".
${FRAMEWORKS[outputKind].editGuard}
- Output the COMPLETE corrected document starting with <!DOCTYPE html> and ending
  with </body></html>. No markdown, no fences, no commentary.`,
          `次の不備を修正してください:\n\n${defects.map((d, i) => `${i + 1}. ${d.instruction}`).join('\n')}\n\n${finalHtml.slice(0, REPAIR_INPUT_LIMIT)}`,
          pushStream
          , 64000, null, 'repair:whole-document')
        const cleanedRepair = stripFences(whole)
        if (cleanedRepair.includes('<html') || cleanedRepair.includes('<!DOCTYPE')) {
          const accepted = await judgeRepair(
            cleanedRepair,
            defects,
            pass,
            'whole-document',
            // Judged against the length it was actually given: the input is
            // truncated at REPAIR_INPUT_LIMIT, so a longer document cannot come
            // back whole and must not be required to.
            Math.min(finalHtml.length, REPAIR_INPUT_LIMIT) * 0.85
          )
          if (accepted) {
            done('interaction-repair', t)
            continue
          }
        }
      } catch (e) {
        /*
         * Includes the planner rethrowing a refusal — see planFileRepairs. The
         * throw is the point: it skips the whole-document rewrite below, which
         * is what a throttled run used to escalate to. Named separately so the
         * log distinguishes "the model would not answer" from "the repair went
         * wrong", which are the same line otherwise.
         */
        if (isModelUnavailable(e)) {
          logger.warn('Interaction repair refused; the pass stops here', { requestId, pass, error: String(e) })
        } else {
          logger.warn('Interaction repair failed', { requestId, pass, error: String(e) })
        }
      }
      done('interaction-repair', t)
      // Rejected, malformed or thrown. Another attempt would be the same request
      // over the same document, which is the resampling this loop is designed not
      // to do — so the remaining defects ship, and they are reported.
      break
    }
  }
  if (openDefects.length > 0) {
    logger.info('Shipping with open defects', { requestId, defects: openDefects.map((d) => d.id) })
  }

  /**
   * Any stock URL the model invented is swapped for one that exists.
   *
   * Handed a list of real URLs, a model will occasionally write a fourth that
   * looks like the other three. A 404 is invisible to every check in this
   * pipeline — the markup is perfect, the audits see an <img> with a src — and
   * entirely visible to the user, which is the worst combination a defect can
   * have.
   */
  {
    // Substituted from the photographs chosen for THIS brief, not from the
    // library at large — see repairStockUrls.
    const repaired = await repairStockUrls(finalHtml, stockImages)
    if (repaired.fixed > 0) finalHtml = repaired.html
  }

  /**
   * And then every photograph is reassigned to match what it illustrates.
   *
   * Second, because the pass above guarantees the URLs exist and this one
   * guarantees they are of the right thing — a picture can be both real and
   * wrong, and measured on a real storefront it usually was: three garments
   * illustrated with two photographs of an office desk. Choosing per item is
   * not something the assembler can do, because at the moment it writes the
   * catalogue it has a list of URLs and no idea what any of them are of.
   */
  {
    const assigned = await assignItemImages(finalHtml, {
      // The page's own domain, for an item whose name settles nothing, and the
      // reader for names no term list contains (「カプチーノ」 is coffee).
      brief: prompt,
      resolveNames: resolveSubjects,
    })
    if (assigned.assignments.length > 0) {
      finalHtml = assigned.html
      logger.info('Photographs matched to their subjects', {
        requestId,
        matched: assigned.matched,
        cleared: assigned.cleared,
      })
    }
  }

  // Again after the repairs, which write whole files and can reintroduce the
  // same mistake. The per-file parse gate deliberately accepts JSX in a .ts —
  // it must not be stricter than the bundler — so the rename is what makes the
  // shipped project correct rather than merely runnable.
  // Again after the repairs, for the same reason as the rename below: a repair
  // that rewrites a whole screen can reintroduce the link it was told to remove.
  {
    const links = normalizeRouterLinks(finalHtml, outputKind)
    if (links.rewritten > 0) {
      finalHtml = links.html
      logger.info('Rewrote router links as anchors after repair', { requestId, rewritten: links.rewritten })
    }
    /**
     * The idioms that stop a framework compiling, repaired deterministically.
     *
     * Runs on every path and in every effort profile, including the two that pay
     * for no repair passes: a duplicate `defineProps()` or a `$store` prefix on a
     * rune module is a blank page with an error on it, and that is not a less
     * complete interface — it is not an interface.
     */
    const fixups = fixupProject(finalHtml, outputKind)
    if (fixups.fixed.length > 0) {
      finalHtml = fixups.html
      logger.info('Repaired framework idioms', { requestId, fixed: fixups.fixed.slice(0, 6) })
    }
  }

  if (outputKind === 'react') {
    const normalized = normalizeReactExtensions(finalHtml)
    if (normalized.renamed.length > 0) {
      finalHtml = normalized.html
      logger.info('Renamed .ts files containing JSX after repair', { requestId, renamed: normalized.renamed })
    }
    // Again after the repairs: a repair that adds an icon can add the import
    // for a barrel too, and leave the barrel itself unwritten.
    const barrels = addMissingBarrels(finalHtml)
    if (barrels.added.length > 0) {
      finalHtml = barrels.html
      logger.info('Added missing barrel files after repair', { requestId, added: barrels.added })
    }
  }

  /*
   * The token block, put back if a repair rewrote the stylesheet without it.
   * Idempotent, so an untouched stylesheet is left exactly as it is.
   */
  {
    const founded = applyPresetFoundation(finalHtml, presetName)
    if (founded.applied) {
      finalHtml = founded.html
      logger.info('Restored the design system token block after repair', { requestId, presetName, overridden: founded.overridden.length })
    }
    // A repair writes whole files, and the form contract's 44px rides back in with them.
    const sized = snapComponentSizes(finalHtml, presetName)
    if (sized.changes.length > 0) {
      finalHtml = sized.html
      logger.info('Snapped component sizes onto the design system after repair', {
        requestId, presetName, changes: sized.changes.length,
        values: [...new Set(sized.changes.map((c) => `${c.what} ${c.from}→${c.to}`))],
      })
    }
    const drift = measureComponentDrift(finalHtml, presetName)
    if (drift.details.length > 0) {
      logger.info('Component sizes off the design system scale', { requestId, presetName, fontSizes: drift.fontSizes, buttonHeights: drift.buttonHeights, fieldHeights: drift.fieldHeights })
    }
  }

  // And again for the same reason as the rename above: the repair passes write
  // whole files, so they can reintroduce the fault they were asked to fix.
  // Ungated for the same reason as the call before verification — see there.
  const syntaxAfter = repairSyntax(finalHtml)
  if (syntaxAfter.repairs.length > 0) {
    finalHtml = syntaxAfter.html
    logger.info('Repaired syntax errors after repair', {
      requestId,
      kind: outputKind,
      repairs: syntaxAfter.repairs.map((r) => `${r.path}:${r.line} ${r.before} → ${r.after}`),
    })
  }

  /**
   * The user's image goes in last, after every pass that rewrites the document.
   *
   * Both repair passes re-emit the whole document and take their input truncated at
   * 120,000 characters. A data URI substituted earlier would be re-transcribed by a
   * model — expensive, and one wrong character makes a broken image — or simply cut
   * off by the truncation. The marker is thirteen characters and survives both.
   */
  if (imageInput && canEmbedImage) {
    const embedded = embedUserImage(finalHtml, imageInput)
    finalHtml = embedded.html
    logger.info('User image embedded', { requestId, placements: embedded.count })
    if (embedded.count === 0) {
      // Not necessarily wrong — the request may have been "follow this design" — but
      // "the user attached an image and it appears nowhere" is worth being able to see.
      logger.info('User image was treated as a reference, not as content', { requestId })
    }
  }
  /**
   * A marker that survives to here would ship as `src="{{USER_IMAGE}}"` — a visibly
   * broken image. It should be impossible: the marker is only ever described to the
   * model when there is an image small enough to substitute. Impossible things are
   * worth checking when the failure is user-visible and the check is one line.
   */
  if (finalHtml.includes(USER_IMAGE_TOKEN)) {
    logger.warn('User image marker left unsubstituted; stripping it', {
      requestId,
      hadImage: Boolean(imageInput),
      embeddable: canEmbedImage,
    })
    finalHtml = finalHtml.split(USER_IMAGE_TOKEN).join('')
  }
  /*
   * The supplied pictures, put in where the model asked for them.
   *
   * After the repair loop for the same reason the single image is: both repair
   * passes re-emit the whole document from an input truncated at 120,000
   * characters, and a data URI substituted earlier would either be re-transcribed
   * by a model — expensive, and one wrong character is a broken image — or cut
   * off by that truncation. A marker is sixteen characters and survives both.
   */
  if (placeableImages.length > 0) {
    const placed = embedContentImages(finalHtml, placeableImages)
    finalHtml = placed.html
    const missing = placeableImages
      .filter((_im, i) => placed.placements[i] === 0)
      .map((im) => im.index)
    logger.info('Supplied images embedded', {
      requestId,
      placements: placed.placements,
      unplaced: missing,
    })
    if (missing.length > 0) {
      /*
       * Worth its own line, at warn.
       *
       * Unlike the reference image — where "it appears nowhere" is a legitimate
       * outcome, because the request may have been "follow this design" — a
       * content image has exactly one job. One the user chose and the UI does
       * not show is the first thing they will notice, and it is otherwise
       * invisible from here: the document builds, renders and scores fine.
       */
      logger.warn('Some supplied images were never placed', {
        requestId,
        unplaced: missing,
        captions: missing.map((n) => placeableImages.find((im) => im.index === n)?.caption || '(none)'),
      })
    }
  }
  /*
   * And any numbered marker still standing, including ones invented from the
   * pattern of the others — `{{USER_IMAGE_9}}` when only three were supplied.
   * Shipping one is a visibly broken image.
   */
  const leftover = stripContentImageTokens(finalHtml)
  if (leftover.stripped.length > 0) {
    logger.warn('Numbered image markers left unsubstituted; stripping them', {
      requestId,
      markers: leftover.stripped,
      supplied: placeableImages.length,
    })
    finalHtml = leftover.html
  }

  /**
   * The last thing between a document that will not build and a user.
   *
   * Everything above repairs a fault it recognises. Three consecutive Svelte
   * runs failed to build for three unrelated reasons and only one had been
   * foreseen, which is the nature of the problem: the list of known mistakes is
   * never finished, and the requirement it serves does not allow for that —
   * a generated UI must never fail to display.
   *
   * So the last step handles the class instead of the instance, for the one
   * part of a component that can be dropped without changing what it does. It
   * runs only on a document that does not compile, only when the compiler
   * blames CSS, and stops the moment the project builds.
   */
  const salvaged = salvageUnparsableStyles(finalHtml, outputKind, toRunnableDocument)
  if (salvaged.stripped.length > 0) {
    finalHtml = salvaged.html
    logger.warn('Dropped unparsable scoped styles to keep the project buildable', {
      requestId,
      kind: outputKind,
      files: salvaged.stripped,
    })
  }

  /*
   * And if it still will not build, the broken component goes rather than the
   * application.
   *
   * The CSS salvage above handles the one part of a component that can be
   * dropped without changing what it does. This handles the rest, and it exists
   * because the targeted repairs are not converging fast enough on their own:
   * three sessions running, each shipped a fix for the idiom that had just
   * broken a Svelte run, and each following run failed on a different one.
   *
   *   v145  a class-based router          (ours — Sucrase lowering class fields)
   *   v151  {width={size}} in one icon of nine
   *   v153  {#const …} in two screens
   *
   * A list of known mistakes cannot be finished, and "a generated UI must never
   * fail to display" does not bend. So the file the compiler blames becomes a
   * labelled placeholder and everything else runs: the navigation works, the
   * other screens work, and the one broken piece says so on the page.
   *
   * Components only, and never the shell — see the function for why.
   */
  const stubbed = stubUnbuildableComponents(finalHtml, outputKind, toRunnableDocument)
  if (stubbed.stubbed.length > 0) {
    finalHtml = stubbed.html
    // Added to the tally from before verification: a repair pass rewrites whole
    // files, so it can reintroduce the fault it was asked to fix, and the score
    // has to reflect every component that ended up as a placeholder rather than
    // only the ones broken on the first pass.
    stubbedFiles.push(...stubbed.stubbed)
    logger.warn('Replaced unbuildable components with placeholders to keep the project running', {
      requestId,
      kind: outputKind,
      reasons: stubbed.reasons,
    })
  }

  /**
   * Whether the thing about to be saved is an interface at all.
   *
   * Worth one line and a log entry: a document that does not compile renders as
   * a blank page with an error on it, and until now that shipped with the same
   * silence as a good one. Nothing downstream can tell the difference — the
   * score is computed from source, the audits read source — so this is the only
   * place the distinction exists.
   */
  const buildError = toRunnableDocument(finalHtml, outputKind).error
  if (buildError) {
    logger.error('Shipping a project that does not build', {
      requestId,
      kind: outputKind,
      error: buildError.split('\n')[0],
    })
  }

  /**
   * Measured again, because the document is not the one that was measured.
   *
   * Between the last browser pass and the score, `finalHtml` is rewritten
   * eleven times: stock URLs, per-item photographs, router links, rune
   * normalisation, `fixupProject`, extension normalisation, barrels, syntax
   * repair, asset embedding, token stripping and style salvage. The invariant
   * stated on `scoredFacts` — "the score is never computed from measurements of
   * a document that was thrown away" — was enforced for two of those at v156
   * and the other nine kept running.
   *
   * Measured on the v208 Vue run. The record said `consoleErrors 1`,
   * `ReferenceError: props is not defined`; the shipped document, served and
   * walked by hand, throws nothing and opens all four screens. A `fixupProject`
   * pass ran nine milliseconds after "Shipping with open defects" and bound the
   * props the error was about. The number described a document nobody received.
   *
   * The error went the flattering way for the user and the harsh way for the
   * score, which is luck rather than design: `assignItemImages` and
   * `repairStockUrls` rewrite markup too, and nothing says their edits cannot
   * break what the walk had found working.
   *
   * So it is re-walked, once, only when something actually changed it and only
   * when the browser ran in the first place. That costs a page load and no model
   * call. If the second walk cannot run, the old facts are kept — stale
   * measurements are worse than fresh ones and better than none.
   */
  if (scoredFacts && finalHtml !== measuredHtml) {
    const refreshed = await verify(finalHtml)
    if (refreshed) {
      logger.info('Re-measured after the post-verification repairs', {
        requestId,
        consoleErrorsBefore: scoredFacts.consoleErrors.length,
        consoleErrorsAfter: refreshed.consoleErrors.length,
        screensBefore: scoredFacts.screens.length,
        screensAfter: refreshed.screens.length,
      })
      scoredFacts = refreshed
      runtimeDefects = auditRuntime(refreshed, finalHtml, presetName)
      // The findings the user is shown come from here too, so they follow the
      // measurement. The critic's are kept as they were: those came from a
      // screenshot and are not re-derivable without another model call.
      openDefects = collectDefects(finalHtml, runtimeDefects, visualDefects)
    }
  }

  const scored = scoreBreakdown(
    finalHtml,
    presetName,
    outputKind,
    scoredFacts
      ? {
          fills: scoredFacts.screens.map((x) => x.fill),
          emptyBoxes: scoredFacts.screens.reduce((n, x) => n + x.emptyBoxes.length, 0),
          consoleErrors: scoredFacts.consoleErrors.length,
          deadNav: scoredFacts.deadNav.length,
          deadActions: scoredFacts.deadActions.length,
          throwingControls: (scoredFacts.throwing ?? []).length,
          stubbedComponents: stubbedFiles.length,
          smallFields: scoredFacts.smallFields.length,
          unreachableScreens: scoredFacts.unreachable.length,
          declaredScreens: declaredScreenIds(finalHtml).length,
          truncated: scoredFacts.truncated,
          /*
           * Measured failures only.
           *
           * Text over a photograph is reported as `text-over-image` and carries
           * no ratio, because the backdrop walk resolves background COLOURS and
           * a picture is not one. Counting those here would deduct for a number
           * that was never measured — and would go on deducting after the fix,
           * since a solid panel over a photo is still text over a photo to
           * anything looking only at the element tree.
           */
          contrastFaults: scoredFacts.contrast.filter((c) => !c.overImage).length,
          mobileOverflowPx: scoredFacts.mobile?.overflowBy ?? 0,
        }
      : /*
         * A stub is a runtime fact even when the browser never ran.
         *
         * `economy` and `fast` switch browser verification off, so scoredFacts
         * is undefined and the whole runtime object used to be dropped — on
         * exactly the two profiles that buy no repair passes and therefore lean
         * hardest on the placeholder. A project missing three screens would have
         * scored as though nothing had happened.
         */
        stubbedFiles.length > 0
        ? {
            // Every field, zeroed. `scoreRuntime` dereferences `rt.fills.length`
            // among others, so a partial cast here would not mis-score — it
            // would throw, in the last step before the document is saved.
            fills: [],
            emptyBoxes: 0,
            consoleErrors: 0,
            deadNav: 0,
            deadActions: 0,
            throwingControls: 0,
            stubbedComponents: stubbedFiles.length,
            smallFields: 0,
            unreachableScreens: 0,
            declaredScreens: 0,
            // The browser never ran, so nothing was cut short.
            truncated: false,
            contrastFaults: 0,
            mobileOverflowPx: 0,
          }
        : undefined
  )
  /*
   * The number, and what it is made of.
   *
   * `finalScore` is unchanged and stays the thing 427 stored versions carry —
   * changing what it means would make every one of them incomparable with the
   * next, which is the mistake the ledger's `total` avoided by gaining
   * `processed` beside it rather than a new definition.
   */
  const finalScore = scored.total

  /*
   * The one number the score cannot tell apart from a bad one.
   *
   * A project document whose fences stopped being readable falls through
   * `scoreProject` into the rubric for a single interactive page, and measured
   * on a complete nine-screen fixture with one character of the fence marker
   * changed, that path returns 30 — the floor, and the same number an empty
   * document gets. That is not hypothetical: it is exactly what users were shown
   * while `data-file` was unreadable, a plumbing failure wearing the face of a
   * quality judgement.
   *
   * The split already carries the evidence. `contract.possible` is zero only on
   * the single-page path, and every output kind MakeUI has is a project, so zero
   * here means the transport could not be read. It is logged as an error rather
   * than thrown: the generation finished, the document exists, and discarding it
   * would cost the user the run over a scorer's problem. What must not happen is
   * that it passes silently.
   */
  if (scored.contract.possible === 0) {
    logger.error('Scored on the single-page rubric: the project transport was unreadable', {
      requestId,
      outputKind,
      score: finalScore,
      documentChars: finalHtml.length,
      fenceMarkers: (finalHtml.match(/@@@makeui:file /g) || []).length,
      head: finalHtml.slice(0, 200),
    })
  }

  /**
   * Remember the decisions, not the event.
   *
   * The record used to be `Generated digital-agency UI: "<prompt>"` — retrievable
   * but useless, because nothing in it helps design the next screen. Storing what
   * was actually chosen lets the design phase carry a user's visual language
   * across projects, which is the difference between a tool that remembers and
   * one that starts from the same defaults every time.
   *
   * Only recorded for output that passed the audits: a defective run's choices
   * are not worth reproducing.
   */
  try {
    /*
     * Gated on the audits that read what is being stored, and no others.
     *
     * This required all five to come back empty. Over 30 days that is 244 skips
     * against 35 writes — one run in eight — and 0 failures, so the store is
     * real and thinly fed rather than empty.
     *
     * The reason it passed so rarely is that four of the five had nothing to do
     * with the record. `summariseDesignDecisions` stores palette, type, radius,
     * shadow and screen count — visual language. Whether a nav link is dead,
     * whether the seed data is flat, whether the shell has navigation: all real
     * defects, none of them a reason to distrust the palette. They were the
     * common ones, so they decided every run.
     *
     * What remains is the two audits that read the same thing the record does —
     * `auditAiTells` for the tells that make a palette not worth copying
     * (default indigo, emoji, gradient text) and `auditDesignSystem` for whether
     * the scales are coherent — plus the document being renderable, because a
     * project that does not build has CSS that was never resolved and a computed
     * palette that means nothing.
     *
     * Measured on the 205 runs that shipped with open defects in that window,
     * 101 carried nothing from those two. So this is roughly one run in two
     * rather than one in eight, against a store that already caps itself at 20
     * records per actor and drops the near-duplicates.
     */
    const blockers = [
      ...(toRunnableDocument(finalHtml, outputKind).error ? ['not-runnable'] : []),
      ...auditAiTells(finalHtml, presetName, outputKind).map((d) => d.id),
      ...auditDesignSystem(finalHtml).map((d) => d.id),
    ]
    const clean = blockers.length === 0
    if (clean) {
      await saveDesignMemory(userId, summariseDesignDecisions({
        prompt,
        presetName,
        outputKind,
        html: finalHtml,
        score: finalScore,
      }))
    } else {
      /*
       * Naming them, because the previous line did not.
       *
       * It said only that a write had been skipped, so 244 of these said nothing
       * about whether the gate was doing its job or refusing on grounds that had
       * nothing to do with the record. A skip that does not name what stopped it
       * cannot be told from a skip that was right to happen.
       */
      logger.info('Skipped memory write', { requestId, blockers })
    }
  } catch (e) {
    logger.warn('Memory save failed', { error: String(e) })
  }

  /*
   * Archived for the corpus, not for the response. Failing is a warning:
   * losing one document from a sample must not lose the user their build.
   */
  let outputKey: string | undefined
  try {
    outputKey = await saveOutput({ userId, requestId, html: finalHtml, metadata: { qualityScore: finalScore, preset: presetName } })
  } catch (e) {
    logger.warn('Output save failed', { error: String(e) })
  }

  logger.info('Token usage: generateUI', { requestId, inputTokens: ledger.inputTokens, outputTokens: ledger.outputTokens, totalTokens: ledger.inputTokens + ledger.outputTokens, calls: ledger.calls, unreported: ledger.unreported, effort: effort ?? 'standard', via: 'multi-agent-pipeline' })

  // Checked once, on the document that ships: the reply and the version row read the same numbers.
  const requirementSummary = summarizeRequirements(checkRequirements(finalHtml, requirements))
  if (requirementSummary.total > 0) {
    // The edit path logs its own; generation's was only in the reply text.
    logger.info('Requirements checked', {
      requestId,
      total: requirementSummary.total,
      met: requirementSummary.met,
      unmet: requirementSummary.unmet,
      unverified: requirementSummary.unverified,
      openFindings: openDefects.length,
    })
  }
  // Read through a cast for the same reason as at the first render: it is set
  // inside `verify`'s callback, which control-flow analysis cannot see.
  const lastVerifyFailure = scoredFacts ? null : (verifyFailure as VerifyFailure | null)
  const finalOutput: FinalOutput = {
    html: finalHtml,
    /*
     * The chat message for this build, and the whole of it.
     *
     * `plan` is the preamble the model wrote before the document — the prompt
     * asks for three to five Japanese sentences on what the product is, the
     * design direction and the screens, which is the brief description this is
     * meant to be. What it also caught was anything else sitting before the
     * document: a `SPECIFICATION.md` written ahead of it landed in the preamble
     * whole, and six of forty-five stored replies carried one, the longest
     * running to 6,541 characters of spec in a chat bubble.
     */
    /*
     * The model's account, then the run's own — see `replyWithOutcome`.
     *
     * Everything the second half needs was already measured and already in
     * `metadata.verification`, and the frontend had no reference to any of it.
     * Putting it in the reply rather than rendering it from metadata is what
     * makes it survive a reload: the thread stores the text and not the run.
     */
    plan: replyWithOutcome(plan, 'UIを生成しました。', {
      // What was asked for and what the finished project shows — see
      // `RunOutcome.requirements`. Checked on the document that ships.
      requirements: requirementSummary,
      verified: Boolean(scoredFacts),
      // Asked is not the same as answered — see RunOutcome.verifyAttempted.
      verifyAttempted: useBrowserVerify,
      ...(lastVerifyFailure
        ? {
            verifyFailure: {
              reason: lastVerifyFailure.reason,
              ...(lastVerifyFailure.frozeOn ? { frozeOn: lastVerifyFailure.frozeOn } : {}),
            },
          }
        : {}),
      /*
       * The declared screens the walk did not report unreachable. `screens` is
       * every screen the walk landed on, under whatever the hash said — a route
       * with a parameter is a screen of its own there — so a four-screen project
       * replied 「4画面中 6画面に到達しました」 on 2026-09-14. Without a declared
       * list there is nothing to subtract from, and the walk's count stands.
       */
      reached: scoredFacts
        ? declaredScreenIds(finalHtml).length > 0
          ? Math.max(0, declaredScreenIds(finalHtml).length - scoredFacts.unreachable.length)
          : scoredFacts.screens.length
        : undefined,
      declared: declaredScreenIds(finalHtml).length,
      /*
       * The unreached screens the project itself navigates to — see
       * `RunOutcome.afterAction`. A storefront that correctly will not open
       * checkout over an empty cart replied 「5画面中 3画面に到達しました」,
       * which reads as two broken screens.
       */
      afterAction: scoredFacts
        ? scoredFacts.unreachable
            .filter((id) => declaredScreenIds(finalHtml).includes(id) && navigatedToInCode(finalHtml, id))
            .map((id) => specScreenTitle(finalHtml, id) ?? '')
        : undefined,
      consoleErrors: scoredFacts?.consoleErrors.length,
      files: projectFileCounts(finalHtml).files,
      screens: projectFileCounts(finalHtml).screens,
      components: projectFileCounts(finalHtml).components,
      // What the project calls its screens, so the reply can say what was built
      // rather than only how much of it — see `RunOutcome.screenNames`.
      screenNames: screenLabels(finalHtml),
      defects: openDefects.map((d) => ({ id: d.id, note: readerNote(d) })),
    }),
    qualityScore: finalScore,
    metadata: {
      generatedAt: new Date().toISOString(),
      refinementCount: 0,
      /*
       * The score, split into the two unlike things it sums.
       *
       * `contract` is the checklist — does the project have the paths, the
       * routing, the types. `runtime` is what a browser found. One number over
       * both has been read as a judgement about the UI and cannot carry that:
       * two runs of the same brief a day apart scored 84 and 69, and most of the
       * difference was two absent directories on the LARGER project, which
       * reached all five of its screens with no console errors.
       */
      scoreParts: { rubric: scored.rubric, contract: scored.contract, runtime: scored.runtime },
      ...(unrepairedDefects > 0 ? { unrepairedDefects } : {}),
      ...(requirementSummary.total > 0
        ? { requirements: { total: requirementSummary.total, met: requirementSummary.met, unmet: requirementSummary.unmet, unverified: requirementSummary.unverified } }
        : {}),
      openFindings: openDefects.length,
      agentsUsed: ['design-analyst', 'code-assembler'],
      memoryUpdated: false,
      knowledgeBaseHits: designDocs.length,
      outputKey,
      tokenUsage: { inputTokens: ledger.inputTokens, outputTokens: ledger.outputTokens, cacheReadTokens: ledger.cacheReadTokens, cacheWriteTokens: ledger.cacheWriteTokens },
      modelTier: selectedModel.tier,
      preset: presetName || 'none',
      effort: effort ?? 'checked',
      scoreVerified: Boolean(scoredFacts),
      ...(selectedModel.autoReason
        ? { autoModel: { tier: selectedModel.tier, reason: selectedModel.autoReason } }
        : {}),
      ...(modelSubstitution(selectedModel.modelId)
        ? {
            modelUnavailable: {
              asked: selectedModel.modelId,
              used: modelSubstitution(selectedModel.modelId) as string,
            },
          }
        : {}),
      ...(scoredFacts
        ? {
            verification: {
              /*
               * What hid a screen, and the shell and styling symptoms, kept with the run.
               *
               * The 2026-09-14 verification rounds had to rebuild every document and
               * walk it again in a local browser to learn what `screen-hidden`,
               * `nav-unstyled` and `preset-composition` had measured — the defect ids
               * were stored and the facts behind them were not. Whether those repairs
               * ever work can only be counted from facts that outlive the run.
               */
              screens: scoredFacts.screens.map((x) => ({ id: x.id, fill: Math.round(x.fill * 100) / 100, ...(x.hiddenBy ? { hiddenBy: x.hiddenBy } : {}) })),
              ...(scoredFacts.layout ? { layout: scoredFacts.layout } : {}),
              ...((scoredFacts.unstyledNav ?? []).length ? { unstyledNav: scoredFacts.unstyledNav } : {}),
              ...((scoredFacts.oversizedIcons ?? []).length ? { oversizedIcons: scoredFacts.oversizedIcons } : {}),
              emptyBoxes: scoredFacts.screens.reduce((n, x) => n + x.emptyBoxes.length, 0),
              consoleErrors: scoredFacts.consoleErrors.length,
              /**
               * And the first of them, in words.
               *
               * The count alone says a page failed without saying how, and every
               * blank page this session has been diagnosed by going and finding
               * this string by hand — rebuilding the document, serving it, and
               * reading the console. The text is what names the defect:
               * "useApp must be used within AppProvider" and
               * '"" is not a function' are different repairs, and the number 1
               * is the same number for both.
               *
               * Three, clipped. A page that throws on render usually throws once
               * and then repeats itself, so the tail costs bytes without adding
               * anything the first line did not already say.
               */
              consoleErrorTexts: [...new Set(scoredFacts.consoleErrors)]
                .slice(0, 3)
                .map((e) => (e.length > 300 ? `${e.slice(0, 299)}…` : e)),
              deadNav: scoredFacts.deadNav.length,
              deadActions: scoredFacts.deadActions.length,
          throwingControls: (scoredFacts.throwing ?? []).length,
              smallFields: scoredFacts.smallFields.length,
              stubbedComponents: stubbedFiles.length,
              unreachable: scoredFacts.unreachable,
              contrast: scoredFacts.contrast.map((c) => ({
                text: c.text,
                ratio: c.ratio,
                required: c.required,
                // Carried so a reader can apply the same filter the scorer does.
                // Text over a photograph is reported here but never deducted for,
                // and without the flag the two are indistinguishable in the record.
                overImage: c.overImage,
              })),
              mobileOverflowPx: scoredFacts.mobile?.overflowBy ?? 0,
              declaredScreens: declaredScreenIds(finalHtml).length,
              /**
               * Whether the walk finished, so a reader can tell "nothing was
               * unreachable" from "the walk ran out of time to find out".
               *
               * Reported for the same reason it is now scored: the two look
               * identical in a record that omits it.
               */
              truncated: scoredFacts.truncated,
              /**
               * What is still wrong, by name.
               *
               * The score cannot carry this. It is a proportion of a rubric, so
               * 66 and 88 differ by "how many checks were ticked" and neither
               * says which thing to fix — and a page has scored 92 with two
               * thirds of it blank. These are the findings the repair loop ran
               * out of passes or improvement on, which is a fact the user can
               * act on: the next instruction can name one.
               */
              defects: openDefects.map((d) => ({ id: d.id, note: readerNote(d) })),
            },
          }
        : {}),
    },
  }

  /*
   * `raw` beside the score, because 30 is a clamp. 64 of 231 runs over 21 days
   * finished on exactly 30 and nothing said how far under it they were — see
   * `Rubric.raw`. The displayed number is unchanged.
   */
  logger.info('Pipeline completed', {
    requestId,
    duration: Date.now() - startTime,
    score: finalScore,
    ...(scored && scored.raw !== finalScore ? { raw: scored.raw } : {}),
  })
  return finalOutput
}

// =============================================================
// Plan mode
// =============================================================

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

async function runPlan(options: PlanUIOptions, ledger: TokenLedger): Promise<PlanUIResult> {
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
const PLAN_WRITER_SYSTEM = `あなたはUI設計の提案を書きます。読み手は非エンジニアを含むレビュアーで、
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
const PLAN_CHANGE_WRITER_SYSTEM = `あなたは既存UIへの変更の提案を書きます。読み手は非エンジニアを含むレビュアーで、
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
