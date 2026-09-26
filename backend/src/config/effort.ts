/**
 * How thoroughly a build is checked. Not which model runs it.
 *
 * This was one dial carrying two decisions — how much of the pipeline to run,
 * and which model to run it on — and the two do not order together, so the
 * ladder it presented was not a ladder. Measured over 30 days:
 *
 *   economy (Haiku)  67% failed to compile first time, 4 calls, 85k out, 440s
 *   fast    (Sonnet) 25% failed to compile first time, 2 calls, 50k out, 278s
 *
 * 「高速」 came out faster than 「節約」 on the median while doing strictly MORE
 * work, because the weaker model broke the build twice as often and every break
 * bought an emergency repair pass. A dial whose two ends can swap places is not
 * a dial, and no amount of renaming fixes that: the fault is that one control
 * was deciding two independent things.
 *
 * So the mode decides one thing now — whether the expensive checking stages run
 * — and the model picker decides the model, which is what it was already there
 * for. Every combination the four old modes could express is still reachable,
 * plus the two they could not: a checked build on a cheap model, which is the
 * obvious thing to want and was unreachable, and therefore also unmeasured.
 *
 * `draft` is allowed to produce worse UI. That is the trade being asked for,
 * and pretending otherwise by quietly keeping a stage would make the setting a
 * lie. What it is NOT allowed to produce is something that does not build — see
 * the note at the end of this file.
 */

/**
 * The two modes, which are the two answers to one question.
 *
 * `economy`, `fast`, `standard` and `thinking` are what these were called when
 * the mode also chose the model. They are still accepted everywhere a value
 * arrives — a stored job, a resumed tab, a version row written months ago — and
 * `normalizeEffort` maps them here. Nothing downstream sees the old names.
 */
export type Effort = 'draft' | 'checked';

const EFFORTS: Effort[] = ['draft', 'checked'];

/**
 * What the four old names meant, in terms of the one axis that survives.
 *
 * `economy` and `fast` ran the same pipeline as each other — identical on every
 * stage flag — and differed only in the model they forced. That is the clearest
 * evidence that the model was the wrong thing for a mode to be carrying: two
 * menu entries for one behaviour, separated by a choice the picker already
 * offers.
 */
const LEGACY: Record<string, Effort> = {
  economy: 'draft',
  fast: 'draft',
  standard: 'checked',
  thinking: 'checked',
};

/** Accepts the current names and the four they replaced. */
export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORTS.includes(value as Effort) || value in LEGACY);
}

/**
 * A value from anywhere — a request, a stored job, a version row — as one of
 * the two modes, or undefined when it names neither.
 *
 * Undefined rather than a default, so a caller that wants to refuse an unknown
 * value can, and `effortProfile` supplies the default for callers that do not.
 */
export function normalizeEffort(value: unknown): Effort | undefined {
  if (typeof value !== 'string') return undefined;
  if (EFFORTS.includes(value as Effort)) return value as Effort;
  return LEGACY[value];
}

interface EffortProfile {
  /** The four-agent Strands design graph. 60–260s and the largest single cost. */
  designGraph: boolean;
  /**
   * Build the project one file at a time rather than in a single response.
   *
   * Off in both modes, on the operator's instruction, and the reason is token
   * cost. Per-file assembly measured better on every static axis — 155 CSS
   * rules against 10, classes instead of inline styles, real SVG icons, empty
   * states — but it costs 400k–1.1M tokens a run against roughly a third of
   * that for the single call, because the contract travels with every file. A
   * dozen generations in one evening exhausted the account's daily Bedrock
   * quota outright.
   *
   * What made it better was mostly INSTRUCTION, not per-file mechanics: the
   * foundation prompt told the model the stylesheet is the contract and the
   * screens may only use its classes, and the single-call assembler had never
   * been told any of that. Those sections now live in the single-call prompt
   * too, so most of the quality is available at the cheaper price.
   *
   * It is kept as a field rather than deleted because the switch is one line
   * and the measurement above is the whole argument for its value.
   */
  perFileBuild: boolean;
  /** Knowledge-base retrieval. Cheap to call, but its result is prompt input on every later call. */
  knowledgeBase: boolean;
  /** Render in AgentCore Browser and measure. Supplies half the defect list — see the note at the end. */
  browserVerify: boolean;
  /** Upper bound on repair rounds. Zero means the loop does not start. */
  repairPasses: number;
  /** The vision critic. A screenshot to a model, per pass. */
  visualCritic: boolean;
  /**
   * How many stock photographs to offer, per pick. Each travels as prompt text —
   * url, title and tags — so the count is a real input-token lever.
   */
  stockImages: number;
}

/**
 * draft — no checking.
 *   One pass at the document and the deterministic fixes that cost nothing. No
 *   design graph, no browser, no repair loop, no critic. Fast and cheap on any
 *   model, and cheapest on Haiku — which is now the picker's business rather
 *   than the mode's.
 *
 * checked — the checking stages.
 *   What every generation did before modes existed. The design graph, the
 *   browser, three repair rounds, the visual critic. Unchanged on purpose:
 *   people's expectations of it are calibrated, and moving it would make this a
 *   redesign rather than a restructuring.
 *
 * The two differ only in stages. Knowledge-base retrieval and the stock-image
 * count are the same in both, because they are INPUTS rather than checks — the
 * old `fast` had both and the old `economy` had neither, which made 「cheap」
 * mean two unrelated things at once.
 */
export const EFFORT_PROFILES: Record<Effort, EffortProfile> = {
  draft: {
    perFileBuild: false,
    designGraph: false,
    knowledgeBase: true,
    browserVerify: false,
    repairPasses: 0,
    visualCritic: false,
    stockImages: 5,
  },
  checked: {
    perFileBuild: false,
    designGraph: true,
    knowledgeBase: true,
    browserVerify: true,
    repairPasses: 3,
    visualCritic: true,
    stockImages: 5,
  },
};

/**
 * The profile for a mode, defaulting to the checked one.
 *
 * The substitution happens HERE rather than only at the handlers that validate
 * input, because this is the function every stage decision reads. A check at
 * the door is one a later code path can be added behind — and the default is
 * the SAFE direction: an unrecognised value gets the build that is verified,
 * not the one that is not.
 */
export function effortProfile(effort: unknown): EffortProfile {
  return EFFORT_PROFILES[normalizeEffort(effort) ?? 'checked'];
}

/**
 * There is deliberately no `modelForRun` any more, and no `fixedModel`.
 *
 * A mode used to be able to override the model picker, and three of the four
 * did. That is what made the menu and the picker two controls for one decision,
 * with one of them silently winning — and it is what let a mode named for speed
 * be slower than a mode named for thrift. The model comes from the user, or
 * from the brief-reading router when they choose `auto`, and from nowhere else.
 *
 * A note on the two fields that look coupled and are not: with `browserVerify`
 * off the repair loop can still run, because the defect list keeps its static
 * half — unresolved imports, syntax, preset drift, the AI-tell and design-system
 * audits. `draft` sets `repairPasses: 0` outright rather than relying on that,
 * so the saving is stated rather than inferred.
 *
 * One thing `repairPasses: 0` does NOT buy: shipping something that will not
 * build. `graph.ts` raises the budget to one pass when the document carries a
 * syntax error or a missing module, in every mode. The distinction is the
 * user's own — 「下書き」 offers an interface that may be less complete, and a
 * project that does not compile is not a less complete interface, it is not an
 * interface. Measured: of ten runs that needed that emergency pass, all ten
 * carried `import-missing`.
 */
