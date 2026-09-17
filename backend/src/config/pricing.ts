/**
 * What a token costs, per model and per kind — supplied by the operator.
 *
 * The monthly limit counts `input + output` and treats every token alike. Three
 * things make that a poor proxy for the bill, all measured on this account:
 *
 *   - output is 43% of the tokens counted (5,954,020 in / 4,497,258 out over 44
 *     runs) and does not cost the same as input;
 *   - cache reads and writes are billed and were not counted at all — 1,334,606
 *     tokens over the same 44 runs, 12.8% of what the limit saw;
 *   - a Haiku token and an Opus token are the same token to the limit.
 *
 * The prices are NOT in this file. AWS publishes Bedrock pricing through its
 * Pricing API, and for ap-northeast-1 that API returns Claude 2.0, 2.1, 3 Haiku
 * and 3 Sonnet and nothing else — the models this project actually runs are not
 * in it, in any region. So a table written here would be a number somebody
 * remembered, ageing silently, and only correctable by a deploy.
 *
 * `MODEL_PRICING` is a JSON object instead, per 1,000,000 tokens, in whatever
 * currency the operator is billed in:
 *
 *   {"currency":"USD",
 *    "models":{"haiku":{"input":1,"output":5,"cacheRead":0.1,"cacheWrite":1.25},
 *              "sonnet":{"input":3,"output":15,"cacheRead":0.3,"cacheWrite":3.75}}}
 *
 * Absent, every weight is 1 and nothing changes: the weighted count equals the
 * plain one, the limit behaves exactly as it did, and the panel says the table
 * is unset rather than showing a cost it cannot know.
 */

/** Per 1,000,000 tokens, in the operator's currency. */
export interface ModelPrices {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PricingTable {
  currency: string;
  models: Record<string, ModelPrices>;
}

/** The four things a request spends, kept apart because they are priced apart. */
export interface TokenSplit {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

const NUMBER_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;

function readPrices(raw: unknown): ModelPrices | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const out = {} as ModelPrices;
  for (const k of NUMBER_KEYS) {
    const v = o[k];
    // A missing or negative price is a table somebody is still writing, and
    // guessing a zero for it would silently make that model free.
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
    out[k] = v;
  }
  return out;
}

let cached: { raw: string; table: PricingTable | null } | null = null;

/**
 * The configured table, or null when there is none.
 *
 * Parsed once per distinct value of the variable rather than per call: this is
 * read on every usage write and every admin listing, and the variable does not
 * change inside a process. A malformed value is null, not a partial table — half
 * a price list produces a bill that is wrong in a way nobody can see.
 */
export function pricingTable(): PricingTable | null {
  const raw = process.env.MODEL_PRICING ?? '';
  if (cached && cached.raw === raw) return cached.table;

  let table: PricingTable | null = null;
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as { currency?: unknown; models?: unknown };
      const models: Record<string, ModelPrices> = {};
      for (const [name, value] of Object.entries((parsed.models ?? {}) as Record<string, unknown>)) {
        const prices = readPrices(value);
        if (prices) models[name] = prices;
      }
      if (Object.keys(models).length > 0) {
        table = {
          currency: typeof parsed.currency === 'string' && parsed.currency ? parsed.currency : 'USD',
          models,
        };
      }
    } catch {
      table = null;
    }
  }
  cached = { raw, table };
  return table;
}

/** Test seam: forget the parse so a changed variable is read again. */
export function forgetPricing(): void {
  cached = null;
}

/**
 * Whether the weighted count is what the limit refuses on.
 *
 * Separate from having a table, because the two are separate decisions and the
 * gap between them is large. Measured against the operator's own price sheet on
 * the 44 stored runs: output is priced at five times input and is 43% of the
 * tokens the old limit counted, so weighting multiplies a Haiku month by 2.83 —
 * a stored 1,000,000 limit becomes 352,747 real tokens, and 117,582 on Sonnet.
 *
 * So a table arrives first and only reports: the panel gains a cost column and
 * the row gains `weightedTokens`, and nobody's allowance moves. Turning this on
 * is the second step, taken together with whatever the limits should become —
 * three times the current numbers keeps a Haiku allowance where it is.
 */
export function pricingEnforced(): boolean {
  return process.env.MODEL_PRICING_ENFORCE === '1' && pricingTable() !== null;
}

/**
 * What one request costs, in the table's currency, or null without a table.
 */
export function costOf(model: string, split: TokenSplit, table = pricingTable()): number | null {
  const prices = table?.models[model];
  if (!prices) return null;
  return (
    (split.inputTokens * prices.input
      + split.outputTokens * prices.output
      + split.cacheReadTokens * prices.cacheRead
      + split.cacheWriteTokens * prices.cacheWrite)
    / 1_000_000
  );
}

/**
 * One weighted token is one millionth of a unit of currency. Nothing else.
 *
 * It was "the cheapest input token in the table", which happened to be $1.00 per
 * million and therefore happened to equal this — and would have stopped equalling
 * it the day Haiku was repriced, moving what every stored limit meant without
 * anybody editing one. A limit is a budget; a budget that drifts with a supplier's
 * price list is not one.
 *
 * So the number a limit holds IS the budget, in millionths: 10,000,000 is ten
 * dollars, and it stays ten dollars. Measured on this account, ten dollars is
 * about fifteen Haiku generations, five on Sonnet and three on Opus.
 */
const PER_UNIT_CURRENCY = 1_000_000;

/**
 * The request's tokens, weighted by what they cost — in millionths of a unit of
 * currency, so a limit is a budget and reads as one.
 *
 * Without a table this is the plain sum of input and output — the number the
 * limit has always counted — so nothing moves until prices are configured.
 * Cache tokens join the count only when there is a price for them, because
 * adding 12.8% to everybody's usage on the strength of a weight of 1 would
 * tighten every limit by that much without saying so.
 */
export function weighTokens(model: string, split: TokenSplit, table = pricingTable()): number {
  if (!table) return split.inputTokens + split.outputTokens;
  const cost = costOf(model, split, table);
  if (cost === null) return split.inputTokens + split.outputTokens;
  return Math.round(cost * PER_UNIT_CURRENCY);
}

/** A stored limit as money, for anything that shows it to a person. */
export function limitAsCurrency(limit: number): number {
  return limit / PER_UNIT_CURRENCY;
}

/** And back, for anything that takes money from one. */
export function currencyAsLimit(amount: number): number {
  return Math.round(amount * PER_UNIT_CURRENCY);
}
