import { maskAccountId } from '../utils/mask-account.js';
import { getModelConfig } from '../config/agentcore-config.js';
import { pricingTable, pricingEnforced, type ModelPrices } from '../config/pricing.js';
import { isWithdrawnModel, WITHDRAWN_MODELS } from '../config/withdrawn.js';

/**
 * What this deployment is actually configured to run, read from where it is set.
 *
 * Every number the usage tab reports is a consequence of three things stored
 * outside the code — which model id each tier resolves to, what the price table
 * says, and whether that table is enforced — and none of them was visible
 * anywhere. Answering 「今月なぜこの金額なのか」 meant an `aws ssm get-parameter`
 * on a machine with credentials.
 *
 * Read live rather than cached beside the answer: a parameter changed five
 * minutes ago is exactly the case this screen is opened for, and
 * `agentcore-config.ts` already holds a five-minute cache in front of the
 * per-name reads.
 */

interface TierInventory {
  /** `haiku` | `sonnet` | `opus`. */
  id: string;
  label: string;
  /**
   * What Bedrock is actually called with, exactly as Parameter Store holds it.
   *
   * Named for the thing rather than for its format: today every value is a full
   * inference-profile ARN, but the same field accepts a bare profile id and both
   * have been in here. "ARN" would be a claim about the string; this is a claim
   * about what it identifies.
   */
  profile: string;
  /**
   * The inference profile's region scope: `jp`, `global`, `us`, `apac`.
   *
   * Null for a bare model id. It is the difference between inference that stays
   * in Japan and inference that does not, which is a policy question rather than
   * a configuration detail — see config/withdrawn.ts, where it is the reason a
   * working Opus profile was not adopted.
   */
  scope: string | null;
  /** `anthropic`. From the id, because the id is what Bedrock is given. */
  vendor: string | null;
  /** `4.5`, `4.6`, `5` — the family version, not the snapshot date. */
  version: string | null;
  /** True while this build refuses the tier — see config/withdrawn.ts. */
  withdrawn: boolean;
  /** True for the tier `/makeui/models/default` names. */
  isDefault: boolean;
  /** Per 1,000,000 tokens, or null when the price table does not cover it. */
  prices: ModelPrices | null;
}

export interface ModelInventory {
  /** Who runs the models. One string, because it is one answer today. */
  provider: string;
  region: string;
  tiers: TierInventory[];
  /** The tier ids this build will not run. */
  withdrawn: string[];
  pricing: { currency: string; enforced: boolean } | null;
}

/**
 * The parts of a Bedrock model id that mean something.
 *
 * `jp.anthropic.claude-sonnet-4-6-20260514-v1:0` is a cross-region inference
 * profile: a region scope, a vendor, a family, a version and a snapshot. Split
 * by position rather than by a table of known ids, so a model added tomorrow
 * still reads correctly.
 */
export function describeModelId(modelId: string): { scope: string | null; vendor: string | null; version: string | null } {
  /*
   * The profile id, which is what an ARN's last segment is.
   *
   * Parameter Store holds the full ARN —
   * `arn:aws:bedrock:ap-northeast-1:…:inference-profile/jp.anthropic.claude-sonnet-4-6`
   * — and this read the string from the start, so `scope` and `vendor` were both
   * null on every real value and the panel drew 「—」 for the provider. It passed
   * its test because the test's fixtures were bare ids. Measured against what
   * `/makeui/models/sonnet` actually contains.
   */
  const id = (modelId || '').split('/').pop() ?? '';
  // A leading `jp.` / `global.` / `us.` / `apac.` is the profile's scope. Two
  // dots before the family means there is one; one dot means there is not.
  const scoped = /^([a-z]{2,6})\.([a-z0-9-]+)\./.exec(id);
  const scope = scoped ? scoped[1] : null;
  const vendor = scoped ? scoped[2] : (/^([a-z0-9-]+)\./.exec(id)?.[1] ?? null);
  /*
   * Both spellings: `claude-sonnet-4-6` (major-minor) and `claude-opus-5` (major).
   *
   * The minor is bounded at two digits and must not be followed by another,
   * because the snapshot date sits in the same position with the same
   * separator. `claude-opus-5-20260601` read as version 5.20260601 — measured
   * against this exact id. `lambda-handler.ts` had the unbounded pattern too and
   * now calls this instead of keeping a second copy.
   */
  const v = /claude-(?:haiku|sonnet|opus)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(id);
  const version = v ? (v[2] ? `${v[1]}.${v[2]}` : v[1]) : null;
  return { scope, vendor, version };
}

const LABELS: Record<string, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' };

export async function getModelInventory(): Promise<ModelInventory> {
  const cfg = await getModelConfig();
  const table = pricingTable();
  const byTier: { id: string; profile: string }[] = [
    { id: 'haiku', profile: cfg.haikuId },
    { id: 'sonnet', profile: cfg.sonnetId },
    { id: 'opus', profile: cfg.opusId },
  ];

  return {
    // One answer today, and named rather than assumed: every value below is an
    // inference profile, which is a Bedrock concept and not Anthropic's.
    provider: 'Amazon Bedrock',
    region: process.env.AWS_REGION || 'ap-northeast-1',
    tiers: byTier.map(({ id, profile }) => ({
      id,
      label: LABELS[id] ?? id,
      // The account id comes out before this leaves the server — see
      // utils/mask-account.ts. Read the parts off the unmasked value; they are
      // after the last slash and identical either way.
      profile: maskAccountId(profile),
      ...describeModelId(profile),
      withdrawn: isWithdrawnModel(id),
      isDefault: cfg.defaultModel === id,
      // Keyed by tier, which is how the table is written and how usage is
      // recorded — see config/pricing.ts.
      prices: table?.models[id] ?? null,
    })),
    withdrawn: [...WITHDRAWN_MODELS],
    /*
     * Whether the prices are only reported or actually gate a request.
     *
     * The panel draws money either way, and the difference is the whole
     * question when an account is over budget and still running: enforcement is
     * read in `checkUsageLimit` and nowhere else.
     */
    pricing: table ? { currency: table.currency, enforced: pricingEnforced() } : null,
  };
}
