/**
 * What every admin tab shares: the model list, number and money formatting,
 * the CSV export and the reporting period.
 */
import { type UserUsageSummary, type ModelId } from '../../hooks/useAdmin';

export const UNLIMITED = -1;

/**
 * Drawn in this order, and stored in it. `auto` last because it is not a model.
 *
 * Opus is `closed`: it stays on the list, greyed, and cannot be granted. This
 * account cannot invoke any Opus that stays in Japan — the agreement was
 * accepted and the throughput allocation is still zero — so the server withholds
 * it build-wide (backend config/withdrawn.ts) and a grant here would be a
 * permission for something that cannot run.
 *
 * Shown rather than deleted, for two reasons. A checkbox that vanishes tells an
 * administrator nothing, and they would go looking for it. And a user may
 * already have Opus in their stored set: hiding the row would drop it silently
 * the next time any other box was ticked, which is a change to somebody's
 * settings that nobody asked for and nobody would see.
 */
export const MODEL_OPTIONS: { id: ModelId; label: string; hint: string; closed?: string }[] = [
  { id: 'haiku', label: 'Haiku', hint: '最も安価。下書きや小さな修正向け' },
  { id: 'sonnet', label: 'Sonnet', hint: '標準。品質とコストのバランス' },
  {
    id: 'opus',
    label: 'Opus',
    hint: '最高品質。最も高価',
    closed: '現在この環境では Opus を利用できないため、許可しても実行されません（AWS 側のトークン枠が 0 のため。枠が付き次第この制限は外れます）',
  },
  { id: 'auto', label: '自動', hint: '指示内容からモデルを自動選択します' },
];

/**
 * Unset means unrestricted, matching what the server returns for a user with no
 * setting. Opus stays in it: this list is what ticking a box expands to, and
 * removing Opus here would quietly strip it from a user who already had it.
 */
export const ALL_MODELS: ModelId[] = ['haiku', 'sonnet', 'opus', 'auto'];

export function formatNumber(n: number): string {
  if (n === UNLIMITED) return '∞';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toString();
}

export function formatDate(iso: string | undefined): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function downloadCSV(users: UserUsageSummary[]) {
  const header = ['Name', 'Email', 'User ID', 'Total Tokens', 'Input Tokens', 'Output Tokens', 'Requests', 'Token Limit', 'Request Limit', 'Last Updated'];
  const rows = users.map((u) => [
    u.displayName,
    u.email,
    u.userId,
    u.totalTokens,
    u.inputTokens,
    u.outputTokens,
    u.requestCount,
    u.monthlyLimit === UNLIMITED ? 'Unlimited' : u.monthlyLimit,
    u.lastUpdated,
  ]);
  const csv = [header, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `usage-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * A stored limit as money, and back.
 *
 * The server weighs a request by what it cost and records the answer in
 * millionths of a unit of currency, so a limit of 10,000,000 IS ten dollars —
 * see backend/src/config/pricing.ts. Nothing here converts anything; it moves a
 * decimal point, and it is written down because a bare `/ 1e6` in a JSX
 * expression is exactly the kind of thing that gets "simplified" later.
 */
const PER_UNIT_CURRENCY = 1_000_000;
export const asMoney = (limit: number): number => limit / PER_UNIT_CURRENCY;
export const asLimit = (money: number): number => Math.round(money * PER_UNIT_CURRENCY);
/** Two decimals, because a budget is a price and prices have cents. */
export const money = (n: number): string => n.toFixed(2);
/**
 * Money with its unit attached, everywhere money is drawn.
 *
 * `$` alone is ambiguous — a dozen currencies use the sign — and the price
 * table these figures come from carries a `currency` field precisely because
 * the amount and the unit are two facts. Every budget in this panel goes
 * through here.
 */
export const usd = (n: number): string => `$${money(n)} USD`;

export interface Period { from: string; to: string }

/** `YYYY-MM` for a date `back` months before now. */
export function monthKey(back = 0): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - back);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export const THIS_MONTH: Period = { from: monthKey(0), to: monthKey(0) };

