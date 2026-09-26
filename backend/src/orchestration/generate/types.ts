import { type ModelChoice } from '../../config/model-config.js'
import { type RawAttachment } from '../../utils/data-attachment.js'
import { type Effort } from '../../config/effort.js'
import { type OutputKind } from '../../config/frameworks.js'
import type { ScoreParts } from '../audit/scoring.js'

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

