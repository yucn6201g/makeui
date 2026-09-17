import { getModelConfig } from './agentcore-config.js';
import { isWithdrawnModel, WITHDRAWN_NOTE } from './withdrawn.js';

/**
 * Which model a tier resolves to. The id, and nothing else.
 *
 * It used to carry `maxTokens`, `temperature` and `region` as well, and not one
 * of them was ever read — every consumer takes `.modelId`, `.tier` or
 * `.autoReason` and leaves the rest. Three fields that looked like settings and
 * were decoration.
 *
 * `temperature` was the expensive one. It read 0.3 for Haiku and Sonnet and 0.7
 * for Opus, which is a design decision anyone would take at face value — and it
 * prompted the reasonable question of whether Opus being refused was a
 * temperature problem. It was not, twice over: the refusal is an
 * `AccessDeniedException` that reproduces with no inference config at all, and
 * this number never reached Bedrock. The only temperatures the pipeline sends
 * are the 0.4 and 0.3 hard-coded in strands-design.ts, and those come from the
 * Strands `BedrockModel`, not from here.
 *
 * Deleted rather than wired up. Sending it WOULD change what every generation
 * produces, and the score's own run-to-run spread is 11 points — so "Opus should
 * run hotter" is a claim that needs measuring, not a field to quietly connect.
 * That is a separate change with a separate number attached to it. This one only
 * removes the impression that the wiring already exists.
 *
 * `maxTokens` was 64000 for every tier and the invoke paths default to the same
 * 64000 themselves; `region` was the process environment, which every AWS client
 * here already reads on its own.
 */
export interface BedrockModelConfig {
  modelId: string;
}

async function getBedrockModel(tier: 'fast' | 'quality' | 'lite'): Promise<BedrockModelConfig> {
  const config = await getModelConfig();
  if (tier === 'lite') return { modelId: config.haikuId };
  if (tier === 'fast') return { modelId: config.sonnetId };
  return { modelId: config.opusId };
}

/**
 * The next cheaper model, for a run whose own model turns out to be unusable.
 *
 * Not a preference — a last resort. It exists because a model this account
 * cannot invoke takes the whole generation down, and produces nothing: 思考モード
 * asks for Opus, `jp.anthropic.claude-opus-4-8` answers
 * `AccessDeniedException: not available for this account`, and the run ends on
 * 「サーバー側の設定に問題があり…」 with no UI in it.
 *
 * Two separate things can cause that and neither is a quota:
 *
 *   - the account has not accepted the model's agreement. This was the real one,
 *     and it reads as a quota if you look in the wrong place: Service Quotas
 *     returns 0.0 for every Opus 4.8 row, which is a CONSEQUENCE of there being
 *     no agreement and not a cap that could be raised. What answers it is
 *     `bedrock get-foundation-model-availability`, a control-plane call that
 *     costs nothing and returns `agreementAvailability: NOT_AVAILABLE`.
 *   - the runtime role does not permit the profile. It allows
 *     `inference-profile/jp.anthropic.*` and nothing else, so every `global.`
 *     profile is refused before Bedrock is asked.
 *
 * And a third, which is the one that actually holds Opus shut here: the account
 * has a throughput allocation of zero. Accepting the 4.8 agreement on
 * 2026-09-04 moved it NOT_AVAILABLE -> AVAILABLE in sixty seconds and changed
 * nothing else — the invoke is still refused, with the same message. Every Opus
 * 4.8 quota row still reads 0.0 against an AWS default of 21.6 BILLION tokens a
 * day, so it is set to zero deliberately rather than left unprovisioned, and the
 * daily rows are `Adjustable: false`. The error says what to do about it:
 * contact AWS Sales.
 *
 * So all three produce one message, `AccessDeniedException: not available for
 * this account`, and they want a config change, an IAM change, and a
 * conversation with AWS respectively. Reading the first as a quota, or the
 * quota as the first, is a day either way.
 *
 * Measured across every Opus inference profile in ap-northeast-1: 4.8 and 4.7
 * refuse on both `jp.` and `global.`, Opus 5 refuses, and only
 * `global.anthropic.claude-opus-4-6-v1` and `-4-5-...` answer — neither of which
 * has a `jp.` profile at all.
 *
 * Matching on the id rather than asking a describe API is deliberate: the
 * describe answers the first cause and is blind to the second, and the failure
 * this recovers from is whichever one bites first.
 */
export async function nextModelDown(modelId: string): Promise<string | null> {
  const config = await getModelConfig();
  if (modelId === config.opusId) return config.sonnetId;
  if (modelId === config.sonnetId) return config.haikuId;
  return null;
}

async function getDefaultModel(): Promise<BedrockModelConfig> {
  const config = await getModelConfig();
  const tier = config.defaultModel === 'opus' ? 'quality' : config.defaultModel === 'haiku' ? 'lite' : 'fast';
  return getBedrockModel(tier);
}

export type ModelChoice = 'sonnet' | 'opus' | 'haiku' | 'auto';

/** What `auto` decided, so the caller can log it and show it in the chat. */
export interface ResolvedModel extends BedrockModelConfig {
  /** The tier actually used. */
  tier: 'haiku' | 'sonnet' | 'opus';
  /** Set only when the caller asked for `auto`. */
  autoReason?: string;
}

export async function resolveModel(model?: ModelChoice): Promise<BedrockModelConfig> {
  if (!model || model === 'auto') return getDefaultModel();
  const tier = model === 'opus' ? 'quality' : model === 'haiku' ? 'lite' : 'fast';
  return getBedrockModel(tier);
}

/**
 * Resolve a model, letting `auto` choose from the prompt.
 *
 * Separate from `resolveModel` because it needs the prompt, and most callers
 * (edits, reverse-engineering) have no prompt to route on — those keep the plain
 * resolver and treat `auto` as the configured default.
 *
 * The classifier always runs on the cheapest configured model. Paying Opus rates
 * to decide whether to use Opus would spend most of what the routing is meant to
 * save, and the decision is a short classification that Haiku makes just as well.
 */
/** The models a caller may pick, each independently permitted. */
export type ModelId = 'haiku' | 'sonnet' | 'opus' | 'auto';

type Tier = 'haiku' | 'sonnet' | 'opus';

const TIER_ORDER: Record<Tier, number> = { haiku: 0, sonnet: 1, opus: 2 };

const ALL_MODELS: ModelId[] = ['haiku', 'sonnet', 'opus', 'auto'];

/**
 * The permitted tiers, cheapest first.
 *
 * An empty set is read as no restriction rather than as no models. A user with
 * nothing permitted cannot be served at all, and failing every request is a
 * worse answer to a malformed setting than ignoring it — the endpoint that
 * writes the setting is where an empty set gets refused.
 */
function tiersOf(allowed: readonly ModelId[], offered: readonly Tier[]): Tier[] {
  const tiers = offered.filter((t) => allowed.includes(t));
  return tiers.length > 0 ? tiers : [...offered];
}

/**
 * The tiers this build offers at all, which is not the same question as what an
 * administrator permits.
 *
 * A withdrawal is a property of the deployment — the account cannot invoke the
 * model, so nobody's permitted set can make it work — where the permitted set is
 * a property of the user. Keeping them separate matters at the point of
 * explaining the outcome: one of them is somebody's decision and the other is
 * not, and the message says which.
 */
const offeredTiers = (): Tier[] =>
  (['haiku', 'sonnet', 'opus'] as Tier[]).filter((t) => !isWithdrawnModel(t));

/**
 * The permitted tier closest to the one asked for.
 *
 * Downwards first: a request for something not permitted is answered with the
 * best permitted thing under it, which is the ladder's old behaviour and the one
 * that cannot surprise anyone with a bill. Only when nothing is permitted below
 * does it go up — a user allowed Opus alone asking for Haiku gets Opus, because
 * the alternative is refusing to run.
 */
function nearestTier(want: Tier, tiers: Tier[]): Tier {
  if (tiers.includes(want)) return want;
  const below = tiers.filter((t) => TIER_ORDER[t] < TIER_ORDER[want]);
  if (below.length > 0) return below[below.length - 1];
  return tiers[0];
}

/**
 * The tier for a job that has no brief to route on, clamped to what is permitted.
 *
 * Reverse-engineering is the one path with nothing to classify — it is handed an
 * image, not a prompt — and it used to choose entirely inside the agent, from
 * its argument alone, consulting nobody about permissions. So the administrator's
 * model setting, which every other path rounds into, did not apply there at all:
 * a user held to Haiku who asked for Opus got Opus.
 *
 * `auto` becomes Sonnet BEFORE the clamp rather than reaching `decideTier` as
 * `auto`. Sonnet is what this path has always run for `auto`, and letting
 * `decideTier` see `auto` would take its top-of-set branch and promote an
 * unrestricted user from Sonnet to Opus — a change nobody asked for, in the
 * expensive direction.
 */
export function fixedTierFor(
  requested: ModelChoice | undefined,
  allowed: readonly ModelId[],
  /** See decideTier: injectable so the ladder stays testable while a tier is withheld. */
  offered?: readonly Tier[]
): Tier {
  const asked: ModelChoice = requested && requested !== 'auto' ? requested : 'sonnet';
  return decideTier(asked, allowed, undefined, offered).tier;
}

const bedrockTierFor = (t: Tier) => (t === 'opus' ? 'quality' : t === 'haiku' ? 'lite' : 'fast');

export interface TierDecision {
  tier: Tier
  /** True when the classifier should be consulted; false when the answer is already fixed. */
  useRouter: boolean
  /** True when the allowance lowered the outcome, so the caller can say why. */
  limited: boolean
}

/**
 * The whole decision, as a pure function of the request and the permitted set.
 *
 * Separated from the resolution so it can be tested against the real rules
 * rather than against a copy of them. A test that restates the table proves the
 * two agree only until one of them changes.
 *
 * `routerTier` is what the classifier picked; pass nothing when it has not run.
 */
export function decideTier(
  requested: ModelChoice | undefined,
  allowed: readonly ModelId[],
  routerTier?: Tier,
  /*
   * What this build offers, defaulting to everything not withdrawn.
   *
   * A parameter so the ladder can still be exercised across all three tiers
   * while one of them is withheld. Without it, withdrawing Opus would silently
   * delete the Opus half of model-allowance.test.mjs — the rules would go
   * untested for as long as the withdrawal lasted, which is exactly the period
   * during which someone might edit them.
   */
  offered: readonly Tier[] = offeredTiers()
): TierDecision {
  const tiers = tiersOf(allowed, offered);
  const top = tiers[tiers.length - 1];

  // Asking a model which model to use, and then overriding it, buys nothing.
  if (requested === 'auto' && !allowed.includes('auto')) {
    return { tier: top, useRouter: false, limited: true };
  }

  if (requested !== 'auto') {
    const asked: Tier = requested === 'opus' ? 'opus' : requested === 'haiku' ? 'haiku' : 'sonnet';
    if (tiers.includes(asked)) return { tier: asked, useRouter: false, limited: false };
    return { tier: nearestTier(asked, tiers), useRouter: false, limited: true };
  }

  // `auto` is permitted. The router still only gets to pick from the set: it
  // reads the brief, not the administrator's settings.
  if (routerTier === undefined) return { tier: top, useRouter: true, limited: false };
  const tier = nearestTier(routerTier, tiers);
  return { tier, useRouter: true, limited: tier !== routerTier };
}

/**
 * Resolves the model to use, always one the administrator permits.
 *
 * The clamp is applied to `auto` as well as to an explicit choice, and that is
 * the point of taking the permitted set rather than a tier: `auto` is not a
 * model, it is a decision that can land on Opus. Restricting only what the user
 * typed would leave a withdrawn model reachable by leaving the dropdown alone.
 *
 * When `auto` itself is not permitted, the classifier is not run at all — asking
 * a model which model to use, and then overriding it, is a call that buys
 * nothing.
 */
export async function resolveModelForPrompt(
  model: ModelChoice | undefined,
  prompt: string,
  allowed: readonly ModelId[] = ALL_MODELS
): Promise<ResolvedModel> {
  const config = await getModelConfig();
  const first = decideTier(model, allowed);

  if (!first.useRouter) {
    // An explicit, permitted choice keeps whatever resolveModel gives it, so a
    // request for a specific model is not re-derived from its tier.
    if (!first.limited && model && model !== 'auto') {
      return { ...(await resolveModel(model)), tier: first.tier };
    }
    return {
      ...(await getBedrockModel(bedrockTierFor(first.tier))),
      tier: first.tier,
      autoReason: first.limited
        ? model && model !== 'auto' && isWithdrawnModel(model)
          ? WITHDRAWN_NOTE
          : model === 'auto'
            ? `管理者の設定により自動選択は利用できないため ${first.tier} を使用します`
            : `管理者の設定により ${model} は利用できないため ${first.tier} を使用します`
        : undefined,
    };
  }

  const { selectModelForPrompt } = await import('../orchestration/workflow-router.js');
  /*
   * The classifier is only offered what this deployment can invoke.
   *
   * It used to be shown all three names. With Opus withdrawn it would choose
   * `opus`, `decideTier` below would clamp that to Sonnet, and the sentence the
   * user read was the classifier's own with a parenthesis added:
   * 「品質重視の依頼と判断し、最高品質のモデルを選びました（管理者の設定により
   * sonnet に制限）」. No administrator set anything, the model was not the
   * highest quality, and the reader would go looking at an unrelated setting.
   *
   * Asking a question whose answer cannot be honoured is the defect; the clamp
   * was only where it became visible. `decideTier` still clamps — an
   * administrator's permitted set is a separate thing and its message is true.
   */
  const selection = await selectModelForPrompt(prompt, config.haikuId, offeredTiers());
  const decided = decideTier(model, allowed, selection.tier);
  return {
    ...(await getBedrockModel(bedrockTierFor(decided.tier))),
    tier: decided.tier,
    autoReason: decided.limited
      ? `${selection.reason}（管理者の設定により ${decided.tier} に制限）`
      : selection.reason,
  };
}
