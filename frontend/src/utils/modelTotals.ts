/**
 * A period's tokens, requests and money, split by model, across every account.
 *
 * The usage tab's summary bar answers "how much" — one figure each. The tiers
 * differ by five times in price, so "how much" without "on what" is the number
 * that cannot be acted on: forty dollars means one thing if it is all Haiku and
 * another if a third of it went to Opus. Every row already carries the split;
 * nothing added them up.
 *
 * A function rather than a `useMemo` in the component, because two of the rules
 * below are the kind that look like arithmetic and are not.
 */

/** One account's month, as much of it as this needs. */
export interface UsageRowLike {
  totalTokens: number;
  requestCount: number;
  byModel?: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    requestCount: number;
    /** Null for a request the price table does not cover. */
    cost: number | null;
  }[];
}

export interface ModelTotalRow {
  model: string;
  tokens: number;
  requests: number;
  /** The money, meaningful only when `priced`. */
  cost: number;
  /**
   * Whether every request in this row had a price.
   *
   * A model with one unpriced request is an unpriced model: printing the priced
   * part as the total would understate the bill and look exactly like a correct
   * figure. The same rule the summary bar uses for whole accounts.
   */
  priced: boolean;
}

export interface ModelTotals {
  /** Heaviest first, which is the order the question is asked in. */
  rows: ModelTotalRow[];
  /**
   * The part no model claims.
   *
   * Real for any period straddling the deploy that began recording which model
   * each request went to. Named rather than dropped: a breakdown that silently
   * omits part of a month is worse than no breakdown, because every number in it
   * looks right and the reader has no way to notice.
   */
  restTokens: number;
  restRequests: number;
  /** Whether any row has money worth a column. */
  anyCost: boolean;
  /** Whether at least one row could not be priced. */
  partialCost: boolean;
}

export function modelTotals(users: UsageRowLike[]): ModelTotals {
  const acc = new Map<string, ModelTotalRow>();
  let splitTokens = 0;
  let splitRequests = 0;
  let partialCost = false;

  for (const u of users) {
    for (const m of u.byModel ?? []) {
      const tokens = m.inputTokens + m.outputTokens;
      splitTokens += tokens;
      splitRequests += m.requestCount;
      // A model that appears with nothing against it is not a row; it is a
      // leftover key from a month that recorded it and then spent nothing.
      if (tokens === 0 && m.requestCount === 0) continue;
      const cur = acc.get(m.model) ?? { model: m.model, tokens: 0, requests: 0, cost: 0, priced: true };
      cur.tokens += tokens;
      cur.requests += m.requestCount;
      if (typeof m.cost === 'number') cur.cost += m.cost;
      else { cur.priced = false; partialCost = true; }
      acc.set(m.model, cur);
    }
  }

  const totalTokens = users.reduce((a, u) => a + u.totalTokens, 0);
  const totalRequests = users.reduce((a, u) => a + u.requestCount, 0);
  const rows = [...acc.values()].sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model));

  return {
    rows,
    // Clamped at zero: the split is recorded per request and the total per
    // month, and a month can carry a total written before its own split.
    restTokens: Math.max(totalTokens - splitTokens, 0),
    restRequests: Math.max(totalRequests - splitRequests, 0),
    anyCost: rows.some((r) => r.priced && r.cost > 0),
    partialCost,
  };
}
