import type { UsageRowLike } from './modelTotals';

/**
 * A month's bar, split into the models that made it up.
 *
 * The bars used to be plain totals. They are stacked now, and the reason the
 * split cannot simply be `byModel` is the same measurement as everywhere else on
 * this tab: `tok_<model>_*` began part-way through the product's life, so a month
 * can carry a complete total and no attribution at all — August 2026 is 0 of 165
 * requests. A stack built from `byModel` alone would draw that month as a month
 * with nothing in it.
 *
 * So every bar is the TOTAL, and the part no model claims is its own segment.
 * It is not a model and is never coloured as one: it carries the neutral slot and
 * a texture, the way an untagged bucket does in a cost explorer. Removing it
 * would not remove the fact — it would only stop the chart mentioning it.
 */

export type Metric = 'tokens' | 'requests' | 'cost';

/** One month of the whole account, as the server reports it. */
interface MonthLike extends UsageRowLike {
  month: string;
  cost: number | null;
  /** Whether `cost` is a sum or an inference — see splitCoverage on the server. */
  estimated: boolean;
  attributed: { tokens: number; requests: number };
}

interface Segment {
  /** The model key, or `__none__` for the part with no model recorded. */
  key: string;
  label: string;
  value: number;
  /** Share of the bar, 0–100. */
  percent: number;
  /** True for the one segment that is not a model. */
  unattributed: boolean;
}

interface Bar {
  month: string;
  /** The metric's total for the month, or null when it cannot be known. */
  total: number | null;
  /** Height as a share of the tallest bar, 0–100. */
  percent: number;
  segments: Segment[];
  estimated: boolean;
  attributed: { tokens: number; requests: number };
  requestCount: number;
}

/** The label the unattributed segment carries, and the key it is found by. */
export const UNATTRIBUTED = '__none__';
export const UNATTRIBUTED_LABEL = 'モデル未記録';

/**
 * Which colour slot each model gets, fixed for the whole chart.
 *
 * Colour follows the entity, not its rank: a period where Sonnet outspends Haiku
 * must not repaint them. The configured tiers come first in their ladder order,
 * then anything else in the order it first appears — so adding a month to the
 * range cannot recolour the models already on screen.
 *
 * Eight slots exist; past that a series folds into the unattributed neutral
 * rather than inventing a hue. Three tiers and an occasional `direct-edit` is
 * what this actually holds.
 */
export function modelOrder(tiers: { id: string }[], series: MonthLike[]): string[] {
  const order = tiers.map((t) => t.id);
  for (const m of series) {
    for (const b of m.byModel ?? []) if (!order.includes(b.model)) order.push(b.model);
  }
  return order;
}

const valueOf = (
  m: NonNullable<UsageRowLike['byModel']>[number],
  metric: Metric
): number | null =>
  metric === 'tokens' ? m.inputTokens + m.outputTokens
    : metric === 'requests' ? m.requestCount
    : m.cost;

const totalOf = (m: MonthLike, metric: Metric): number | null =>
  metric === 'tokens' ? m.totalTokens : metric === 'requests' ? m.requestCount : m.cost;

export function chartBars(
  series: MonthLike[],
  order: string[],
  metric: Metric,
  labelFor: (key: string) => string
): Bar[] {
  const totals = series.map((m) => totalOf(m, metric) ?? 0);
  const max = Math.max(0, ...totals);

  return series.map((m) => {
    const total = totalOf(m, metric);
    const segments: Segment[] = [];
    let claimed = 0;

    for (const key of order) {
      const found = (m.byModel ?? []).find((b) => b.model === key);
      if (!found) continue;
      const v = valueOf(found, metric);
      // An unpriced model contributes no money — and no segment, rather than a
      // zero-height one. Its tokens still land in the unattributed remainder
      // below, which is where an unpriced request's money is too.
      if (v === null || v <= 0) continue;
      claimed += v;
      segments.push({ key, label: labelFor(key), value: v, percent: 0, unattributed: false });
    }

    /*
     * What the models do not account for.
     *
     * For tokens and requests this is the part recorded before the split
     * existed. For money it is the same part, priced at the recorded requests'
     * average — the month's `cost` is already scaled that way and the budget is
     * enforced on it, so the segment is the difference rather than a second
     * inference.
     */
    const rest = total === null ? 0 : Math.max(total - claimed, 0);
    if (rest > 0) {
      segments.push({
        key: UNATTRIBUTED,
        label: UNATTRIBUTED_LABEL,
        value: rest,
        percent: 0,
        unattributed: true,
      });
    }

    const sum = segments.reduce((a, s) => a + s.value, 0);
    for (const s of segments) s.percent = sum > 0 ? (s.value / sum) * 100 : 0;

    return {
      month: m.month,
      total,
      // A flat run of zeros is a real answer and must not divide by zero.
      percent: max > 0 && total !== null ? (total / max) * 100 : 0,
      segments,
      estimated: m.estimated,
      attributed: m.attributed,
      requestCount: m.requestCount,
    };
  });
}
