import { modelTotals, type UsageRowLike } from './modelTotals';

/**
 * One row per model: what it is, and what it spent.
 *
 * The model tab used to carry two tables — the period's usage split by model,
 * and the tiers this deployment is configured to run — sitting one above the
 * other and keyed on the same thing. Reading them meant matching a name in the
 * first against a name in the second by eye.
 *
 * Joined on the tier name, which is what both sides already use: usage is
 * recorded as `tok_haiku_in` and the configuration is keyed `haiku`. That is a
 * fact about the store rather than a convention this file introduces — see
 * backend/src/services/token-usage.ts.
 *
 * Two kinds of row come out, and both are the reason this is a function rather
 * than a `.map()`:
 *
 *   a configured tier, whether or not it ran. A tier with no usage is a row of
 *     zeros, not an absence: 「Opusは使われていない」 and 「Opusは設定されていない」
 *     are different answers and the table has to be able to say the first.
 *   a model that ran but is not a configured tier. `direct-edit` is one. It has
 *     spend and no profile, and dropping it would make the column totals
 *     disagree with the usage tab.
 *
 * A third kind — the part no model claims — was removed on the operator's
 * instruction. `attribution` below is what took its place.
 */

export interface ModelConfigLike {
  id: string;
  label: string;
  /** The inference profile Bedrock is called with. Empty when unset. */
  profile: string;
  version: string | null;
  withdrawn: boolean;
  isDefault: boolean;
}

export interface ModelRow {
  /** The tier name, or the raw usage key for a model with no configuration. */
  id: string;
  /** `Haiku 4.5`, or just the key when no version is known. */
  name: string;
  /** Empty for a model that ran without being one of the configured tiers. */
  profile: string;
  tokens: number;
  requests: number;
  cost: number;
  /** False when any request in this row had no price — see `modelTotals`. */
  priced: boolean;
  withdrawn: boolean;
  isDefault: boolean;
}

/** `Haiku` + `4.5`. The version is part of the answer to "which model". */
export const modelName = (label: string, version: string | null): string =>
  version ? `${label} ${version}` : label;

export function modelRows(users: UsageRowLike[], tiers: ModelConfigLike[]): ModelRow[] {
  const totals = modelTotals(users);
  const spent = new Map(totals.rows.map((r) => [r.model, r]));
  const rows: ModelRow[] = [];

  for (const t of tiers) {
    const use = spent.get(t.id);
    spent.delete(t.id);
    rows.push({
      id: t.id,
      name: modelName(t.label, t.version),
      profile: t.profile,
      tokens: use?.tokens ?? 0,
      requests: use?.requests ?? 0,
      cost: use?.cost ?? 0,
      // A tier that has not run is priced by definition: there is nothing
      // unpriced in it. Saying otherwise would put 「—」 in the money column of
      // every unused model.
      priced: use ? use.priced : true,
      withdrawn: t.withdrawn,
      isDefault: t.isDefault,
    });
  }

  // Whatever ran that is not a configured tier, heaviest first.
  for (const r of [...spent.values()].sort((a, b) => b.tokens - a.tokens)) {
    rows.push({
      id: r.model,
      name: r.model,
      profile: '',
      tokens: r.tokens,
      requests: r.requests,
      cost: r.cost,
      priced: r.priced,
      withdrawn: false,
      isDefault: false,
    });
  }

  return rows;
}

/** How many models the table is about, for the tab's badge. */
export const modelCount = (rows: ModelRow[]): number => rows.length;

/**
 * How much of the period has a model recorded against it.
 *
 * There was a 「内訳なし」 row for the rest and it is gone on the operator's
 * instruction. What it named has not gone: `tok_<model>_*` began part-way
 * through the product's life, so a period can carry a complete total and almost
 * no attribution — measured 2026-09-10, August is 0 of 165 requests and
 * September 3 of 8. Removing the row without saying this would leave a table
 * that adds up to a third of the month and looks complete, which is the one
 * failure a breakdown must not have.
 *
 * So it is said once, in the caption, instead of as a row in the table.
 */
export function attribution(users: UsageRowLike[]): { requests: number; total: number } {
  const totals = modelTotals(users);
  const counted = totals.rows.reduce((a, r) => a + r.requests, 0);
  return { requests: counted, total: counted + totals.restRequests };
}
