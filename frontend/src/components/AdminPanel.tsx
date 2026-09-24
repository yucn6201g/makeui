import { useState, useEffect, useMemo, useRef } from 'react';
import { useAdmin, type UserUsageSummary, type CognitoUser, type ModelId, type AdminProject, type AdminVersion, type UserGroup, type ModelInventory, type ModelTierInfo, type MonthSeries } from '../hooks/useAdmin';
import { useAuth } from '../auth/AuthProvider';
import { isSuperAdmin } from '../utils/membership';
import { modelRows, modelCount, modelName, attribution } from '../utils/modelRows';
import { chartBars, modelOrder, UNATTRIBUTED, UNATTRIBUTED_LABEL, type Metric } from '../utils/chartSeries';
import { Preview } from './Preview';
import { Dropdown } from './Dropdown';
import { isOlderScoreScale } from '../utils/scoreScale';
import { versionQualityLabel, versionQualityTitle } from '../utils/versionQuality';
import { SlidingIndicator } from './SlidingIndicator';
import { usePresence } from '../hooks/usePresence';

const UNLIMITED = -1;

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
const MODEL_OPTIONS: { id: ModelId; label: string; hint: string; closed?: string }[] = [
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
const ALL_MODELS: ModelId[] = ['haiku', 'sonnet', 'opus', 'auto'];

function formatNumber(n: number): string {
  if (n === UNLIMITED) return '∞';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toString();
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function downloadCSV(users: UserUsageSummary[]) {
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

// --- Summary bar ---
function SummaryBar({ users, period }: { users: UserUsageSummary[]; period: Period }) {
  /*
   * 「今月」 was correct while the period could only be this month. It is a
   * label on a number, so it has to move with the number.
   */
  const span = period.from === period.to
    ? (period.from === THIS_MONTH.from ? '今月' : period.from)
    : `${period.from}〜${period.to}`;
  const totalTokens = users.reduce((s, u) => s + u.totalTokens, 0);
  const totalRequests = users.reduce((s, u) => s + u.requestCount, 0);
  const nearLimit = users.filter((u) => u.monthlyLimit !== UNLIMITED && u.monthlyLimit > 0
    && ((u.weightedTokens ?? u.totalTokens) / u.monthlyLimit) >= 0.8).length;
  /*
   * Summed only over the users whose month is fully priced. A total that added
   * the priced ones and silently skipped the rest would be a smaller bill than
   * the real one, presented as the real one.
   */
  const pricedUsers = users.filter((u) => typeof u.cost === 'number');
  const totalCost = pricedUsers.reduce((s, u) => s + (u.cost ?? 0), 0);
  return (
    <div className="adm-summary">
      <div className="adm-summary__item">
        <span className="adm-summary__val">{users.length}</span>
        <span className="adm-summary__label">ユーザー</span>
      </div>
      <div className="adm-summary__item">
        <span className="adm-summary__val">{formatNumber(totalTokens)}</span>
        <span className="adm-summary__label">{span}の合計トークン</span>
      </div>
      <div className="adm-summary__item">
        <span className="adm-summary__val">{formatNumber(totalRequests)}</span>
        <span className="adm-summary__label">{span}の合計リクエスト</span>
      </div>
      {pricedUsers.length > 0 && (
        <div className="adm-summary__item">
          <span className="adm-summary__val">{totalCost.toFixed(2)}</span>
          <span className="adm-summary__label">
            {span}の合計金額
            {pricedUsers.length < users.length && `（${pricedUsers.length}/${users.length}人分）`}
          </span>
        </div>
      )}
      {nearLimit > 0 && (
        <div className="adm-summary__item adm-summary__item--warn">
          <span className="adm-summary__val">{nearLimit}</span>
          <span className="adm-summary__label">上限80%超過</span>
        </div>
      )}
    </div>
  );
}

// --- Inline limit editor (reused for token and request limits) ---
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
const asMoney = (limit: number): number => limit / PER_UNIT_CURRENCY;
const asLimit = (money: number): number => Math.round(money * PER_UNIT_CURRENCY);
/** Two decimals, because a budget is a price and prices have cents. */
const money = (n: number): string => n.toFixed(2);
/**
 * Money with its unit attached, everywhere money is drawn.
 *
 * `$` alone is ambiguous — a dozen currencies use the sign — and the price
 * table these figures come from carries a `currency` field precisely because
 * the amount and the unit are two facts. Every budget in this panel goes
 * through here.
 */
const usd = (n: number): string => `$${money(n)} USD`;

/**
 * The month's budget, editable where it is read.
 *
 * A dollar figure rather than a token count. The number stored is the same; what
 * changed is that it is now readable — 「10,000,000」 answered no question anybody
 * was asking, and 「$10.00」 is the question they were asking.
 */
function BudgetEditor({
  value,
  onSave,
  disabled,
  children,
}: {
  value: number;
  onSave: (limit: number) => Promise<void>;
  /** True for a group administrator: the budget is the account's spending. */
  disabled?: boolean;
  /**
   * How the current figure is drawn, when the caller draws one.
   *
   * Given to this component rather than placed beside it, because only this
   * component knows whether it is being edited — and the two cannot share a
   * line. In a 178px column the spend, the budget and a four-part editor came to
   * more than twice the width; the cell has `text-overflow: ellipsis`, so what
   * it cut was the budget, and pressing 編集 clipped the very number being
   * edited. While the editor is open the figure steps aside — the input is
   * carrying it, pre-filled — and it comes back on save or cancel.
   */
  children?: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unlimited = value === UNLIMITED;

  const save = async (next: number) => {
    setSaving(true);
    setError(null);
    try {
      await onSave(next);
      setEditing(false);
    } catch (e) {
      setError((e as Error).message || '保存に失敗しました');
    } finally {
      setSaving(false);
    }
  };

  if (disabled) {
    // The caller's own figure when there is one: repeating it beside the cell
    // that already shows it was the same number twice in 178px.
    return children ? <>{children}</> : (
      <span className="adm-readonly" title="予算の変更はアカウント管理者のみが行えます">
        {unlimited ? '無制限' : usd(asMoney(value))}
      </span>
    );
  }

  if (editing) {
    return (
      /*
       * Two deliberate lines, not four things that happen to wrap.
       *
       * The budget column is 178px in a split pane, and the editor is a prefix,
       * a number field and two buttons. Laid out as one wrapping row it broke
       * after the input, at a place nothing chose: the buttons landed under the
       * field with no alignment and the row grew, so every other cell in the
       * groups table shifted the moment 編集 was pressed. The field takes the
       * line it needs and the buttons take theirs.
       */
      <span className="adm-edit-group">
        <span className="adm-edit-group__field">
          <span className="adm-uid">$</span>
          <input
            type="number"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="adm-input adm-input--sm"
            min="0"
            step="1"
            placeholder="空欄=無制限"
            aria-label="月間予算（USD）"
          />
        </span>
        <span className="adm-edit-group__actions">
        <button
          onClick={() => {
            const raw = draft.trim();
            if (raw === '') return void save(UNLIMITED);
            const n = Number(raw);
            // Zero is a budget nobody can spend, which is a different thing from
            // no budget set, and typing it by accident should not lock an account
            // out silently.
            if (!Number.isFinite(n) || n <= 0) { setError('0より大きい金額を入力してください'); return; }
            void save(asLimit(n));
          }}
          disabled={saving}
          className="adm-btn adm-btn--primary adm-btn--sm"
          type="button"
        >
          {saving ? '…' : '保存'}
        </button>
        <button onClick={() => { setEditing(false); setError(null); }} className="adm-btn adm-btn--ghost adm-btn--sm" type="button">
          キャンセル
        </button>
        </span>
        {error && <span className="adm-inline-error" role="alert">{error}</span>}
      </span>
    );
  }

  return (
    <span className="adm-limit-row">
      {children}
      <button
        onClick={() => { setDraft(unlimited ? '' : String(asMoney(value))); setEditing(true); setError(null); }}
        className="adm-btn adm-btn--link adm-btn--sm"
        type="button"
        aria-label="月間予算を編集"
        title={unlimited ? '予算は設定されていません' : `月間予算 ${usd(asMoney(value))}`}
      >
        編集
      </button>
      {error && <span className="adm-inline-error" role="alert">{error}</span>}
    </span>
  );
}

/**
 * One checkbox per model, each independently on or off.
 *
 * This was a four-option dropdown naming a ceiling — Haiku, then Haiku+Sonnet,
 * and so on — which could only express permissions that nest. "Opus but not
 * Haiku", to keep a team's floor high, was not a sentence it could say. Boxes
 * can say it, and the resolver was rewritten to honour a set rather than a rung.
 *
 * The last remaining model cannot be unchecked. An empty set is refused by the
 * server, because a set holding no model resolves to nothing and the pipeline's
 * fallback for that is to ignore the setting entirely — so an accidental empty
 * set would grant everything, the exact opposite of what clearing the boxes
 * looks like it does. Disabling the last box says so before the click rather
 * than after it.
 */
function ModelPicker({
  models,
  onSave,
}: {
  models: ModelId[];
  onSave: (models: ModelId[]) => Promise<void>;
}) {
  const [saving, setSaving] = useState<ModelId | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // The last real model is the one that cannot go; `auto` is never load-bearing.
  const realCount = models.filter((m) => m !== 'auto').length;

  const toggle = async (id: ModelId, on: boolean) => {
    const next = on
      ? ALL_MODELS.filter((m) => m === id || models.includes(m))
      : models.filter((m) => m !== id);
    setSaving(id);
    setSaveError(null);
    try {
      await onSave(next);
    } catch (e) {
      setSaveError((e as Error).message || '保存に失敗しました');
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="adm-models">
      {MODEL_OPTIONS.map((opt) => {
        const on = models.includes(opt.id);
        const last = on && opt.id !== 'auto' && realCount === 1;
        /*
         * A closed model can still be turned OFF. Leaving a dead grant in place
         * with no way to clear it would make the setting permanently wrong, and
         * turning it off is the one edit that is unambiguously an improvement.
         */
        const closed = Boolean(opt.closed);
        return (
          <label
            key={opt.id}
            className={`adm-model${on ? ' adm-model--on' : ''}${last ? ' adm-model--locked' : ''}${closed ? ' adm-model--closed' : ''}`}
            title={closed ? opt.closed : last ? '最後の1つは外せません（少なくとも1つのモデルが必要です）' : opt.hint}
          >
            <input
              type="checkbox"
              className="adm-model__box"
              checked={on}
              disabled={last || saving !== null || (closed && !on)}
              onChange={(e) => toggle(opt.id, e.target.checked)}
            />
            <span className="adm-model__label" aria-disabled={closed || undefined}>{opt.label}</span>
            {/*
              No badge. The checkbox being unclickable IS the statement, and the
              reason is on the `title` for anyone who wonders — a word repeated
              beside every closed model says the same thing the control already
              says, in a place that costs a column of width.

              `aria-disabled` rather than nothing, because the visual cue of a
              greyed box does not reach a screen reader and the input above is
              only `disabled` when the model is off.
            */}
          </label>
        );
      })}
      {saveError && <span className="adm-inline-error" role="alert">{saveError}</span>}
    </div>
  );
}

/**
 * The name column, editable in place.
 *
 * Only an administrator can reach this at all — the panel is behind the group
 * check and so is the route — so there is no per-row permission to draw. What
 * the row does have to show is which names were CHOSEN: an account that predates
 * names, or one created outside this form, falls back to the part of its address
 * before the `@`, and an administrator reading a column of plausible names
 * should be able to tell those apart from the ones somebody decided.
 */
function NameEditor({
  user,
  onRename,
}: {
  user: CognitoUser;
  onRename: (username: string, displayName: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(user.displayName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const next = value.trim();
    if (!next) { setError('ユーザー名を入力してください'); return; }
    if (next === user.displayName && user.displayNameSet) { setEditing(false); return; }
    setSaving(true);
    setError(null);
    try {
      await onRename(user.username, next);
      setEditing(false);
    } catch (e) {
      setError((e as Error).message || '保存に失敗しました');
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <div className="adm-name">
        <span className="adm-email">{user.displayName}</span>
        {!user.displayNameSet && (
          <span className="adm-name__derived" title="メールアドレスの@より前から自動で付けた名前です。編集すると保存されます。">
            自動
          </span>
        )}
        {/* The same control, and the same word, as the budget's 編集 in the same row. */}
        <button
          className="adm-btn adm-btn--link adm-btn--sm"
          type="button"
          onClick={() => { setValue(user.displayName); setEditing(true); setError(null); }}
          aria-label={`${user.displayName} のユーザー名を編集`}
        >
          編集
        </button>
      </div>
    );
  }

  return (
    <div className="adm-name">
      <input
        className="adm-input adm-input--sm"
        value={value}
        maxLength={64}
        autoFocus
        disabled={saving}
        onChange={(e) => setValue(e.target.value)}
        // Enter saves, Escape abandons. A name is one field, and making someone
        // reach for a button to commit a single value is the sort of friction
        // that gets a rename left half-done.
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') { setEditing(false); setError(null); }
        }}
        aria-label="ユーザー名"
      />
      <button className="adm-btn adm-btn--primary adm-btn--sm" type="button" onClick={save} disabled={saving}>
        {saving ? '…' : '保存'}
      </button>
      <button className="adm-btn adm-btn--ghost adm-btn--sm" type="button" onClick={() => { setEditing(false); setError(null); }} disabled={saving}>
        キャンセル
      </button>
      {error && <span className="adm-inline-error" role="alert">{error}</span>}
    </div>
  );
}

// --- Usage tab row ---
/** One entry of a month's per-model split, as the row carries it. */
type ModelSplit = NonNullable<UserUsageSummary['byModel']>[number];

/**
 * The same figure again, per model, under the total it adds up to.
 *
 * A month's tokens and requests were one number each, which answers "how much"
 * and not "on what" — and on what is the question the numbers exist to support,
 * because the tiers differ by five times in price. The rows are the split the
 * server records.
 *
 * There was a 「内訳なし」 entry for the part no model claims, and it is gone on
 * the operator's instruction. What it named has not gone: `tok_<model>_*` began
 * part-way through the product's life, so a month can carry a complete total and
 * no attribution at all — measured 2026-09-10, August is 0 of 165 requests and
 * September 3 of 8. The total above these rows is still the month's; these rows
 * are still only what was recorded; and the gap between them is now said once,
 * in the caption of the model tab, rather than as a row in every cell.
 */
function ByModel({
  rows,
  of,
}: {
  rows: ModelSplit[];
  of: (m: ModelSplit) => string;
}) {
  if (rows.length === 0) return null;
  return (
    <span className="adm-split-models">
      {rows.map((m) => (
        <span key={m.model} className="adm-split-model">
          <span className="adm-split-model__name">{m.model}</span>
          <span className="adm-split-model__val">{of(m)}</span>
        </span>
      ))}
    </span>
  );
}

export interface Period { from: string; to: string }

/** `YYYY-MM` for a date `back` months before now. */
function monthKey(back = 0): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - back);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export const THIS_MONTH: Period = { from: monthKey(0), to: monthKey(0) };

/**
 * How long a period the figures cover, and how to change it.
 *
 * A month, because a month is what the store keeps: one row per account per
 * month. A finer range would have to be rebuilt from the per-request `EVENT#`
 * rows, which means a query per account to answer a report — so the honest
 * granularity is offered rather than a day picker that quietly rounds.
 *
 * Presets first: 「先月と比べたい」 and 「四半期を見たい」 are most of what this
 * is opened for, and both are one click. The two month fields underneath are
 * for the rest.
 */
function PeriodPicker({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  const presets: { label: string; period: Period }[] = [
    { label: '今月', period: { from: monthKey(0), to: monthKey(0) } },
    { label: '先月', period: { from: monthKey(1), to: monthKey(1) } },
    { label: '過去3ヶ月', period: { from: monthKey(2), to: monthKey(0) } },
    { label: '過去6ヶ月', period: { from: monthKey(5), to: monthKey(0) } },
  ];
  const set = (patch: Partial<Period>) => {
    const next = { ...value, ...patch };
    // Kept in order, so dragging the start past the end moves the end with it
    // rather than producing a range the server refuses.
    if (next.to < next.from) {
      if (patch.from) next.to = next.from;
      else next.from = next.to;
    }
    onChange(next);
  };
  return (
    <div className="adm-period">
      <span className="adm-period__label">期間</span>
      {presets.map((p) => {
        const on = value.from === p.period.from && value.to === p.period.to;
        return (
          <button
            key={p.label}
            type="button"
            className={`adm-btn adm-btn--sm ${on ? 'adm-btn--primary' : 'adm-btn--secondary'}`}
            onClick={() => onChange(p.period)}
          >
            {p.label}
          </button>
        );
      })}
      <input
        className="adm-input adm-input--sm adm-period__month"
        type="month"
        value={value.from}
        max={monthKey(0)}
        onChange={(e) => e.target.value && set({ from: e.target.value })}
        aria-label="開始月"
      />
      <span className="adm-period__sep" aria-hidden="true">〜</span>
      <input
        className="adm-input adm-input--sm adm-period__month"
        type="month"
        value={value.to}
        max={monthKey(0)}
        onChange={(e) => e.target.value && set({ to: e.target.value })}
        aria-label="終了月"
      />
    </div>
  );
}

function UsageRow({
  user,
  priced,
  oneMonth,
}: {
  user: UserUsageSummary;
  /** Whether the cost column exists at all this month — see the header. */
  priced: boolean;
  /**
   * Whether the period is a single month, which is the only case where the
   * budget beside the money is a comparison rather than two unrelated figures.
   */
  oneMonth: boolean;
}) {
  const isTokenUnlimited = user.monthlyLimit === UNLIMITED;
  /*
   * The bar is drawn from the WEIGHTED figure, because that is the one the
   * server refuses on. A bar drawn from `totalTokens` beside a budget checked
   * against `weightedTokens` would show somebody comfortably inside their budget
   * on the request that gets refused. The two are equal until a price table
   * exists, so this changes nothing until it does.
   */
  const counted = user.weightedTokens ?? user.totalTokens;
  const percent = isTokenUnlimited ? 0 : user.monthlyLimit > 0
    ? Math.min((counted / user.monthlyLimit) * 100, 100)
    : 0;

  /*
   * The per-model split, and what it does not cover.
   *
   * `tok_<model>_*` was added part-way through a month, so the rows below can
   * add up to less than the totals above them — see `splitCoverage` on the
   * server. The remainder is named rather than dropped: a breakdown that
   * silently omits a third of a month is worse than no breakdown, because every
   * number in it looks right and the reader has no way to notice.
   */
  const byModel = (user.byModel ?? []).filter((m) => m.requestCount > 0 || m.inputTokens + m.outputTokens > 0);

  return (
    <tr className="adm-tr">
      <td className="adm-td" title={user.userId}>
        <span className="adm-email">{user.displayName || user.email || '—'}</span>
        {/* The address stays as the second line here, unlike on the user's own
            screen. Limits are set per account, names are not unique, and being
            sure which account is being changed matters more than tidiness. */}
        <span className="adm-uid">{user.email}</span>
      </td>
      <td className="adm-td adm-td--muted">{user.group ?? '—'}</td>
      {/*
        Counts, and where they went. The budget used to be drawn into these cells
        alongside them; it belongs with the money, which is the form it is set in.
      */}
      <td className="adm-td adm-td--num">
        <span
          className="adm-split-total"
          title={counted !== user.totalTokens
            ? `重み付け ${formatNumber(counted)} ／ 実トークン ${formatNumber(user.totalTokens)}`
            : undefined}
        >
          {formatNumber(user.totalTokens)}
        </span>
        <ByModel rows={byModel} of={(m) => formatNumber(m.inputTokens + m.outputTokens)} />
      </td>
      <td className="adm-td adm-td--num">
        <span className="adm-split-total">{formatNumber(user.requestCount)}</span>
        <ByModel rows={byModel} of={(m) => formatNumber(m.requestCount)} />
      </td>
      {priced && (
        <td className="adm-td adm-td--num">
          {/*
            Spent against allowed, in one cell. The bar is the weighted figure
            over the budget — the comparison the server actually makes — and the
            two dollar amounts under it are the same comparison in the unit the
            budget is decided in.
          */}
          {/*
            The value sits at the right, under a right-aligned heading.
            `adm-bar-label` pins itself to the LEFT of the bar, so the column
            read 「今月の金額 / 予算」 hard against one edge and its own figure
            hard against the other. The bar is now under the figure rather than
            behind it, which also stops the fill running through the text.
          */}
          <div className="adm-money-cell">
            <span
              className="adm-money-figure"
              title={byModel
                .map((m) => `${m.model}: ${m.cost === null ? '価格未設定' : usd(m.cost)}（${formatNumber(m.inputTokens + m.outputTokens)}トークン／${m.requestCount}回）`)
                .join('\n') || undefined}
            >
              {typeof user.cost === 'number' ? `${user.estimated ? '約 ' : ''}${usd(user.cost)}` : '—'}
              {/*
                The budget is monthly. Over a quarter the money is still the
                money and the ratio is not, so the comparison goes rather than
                reporting three correct months as three times over.
              */}
              {oneMonth && (
                <span className="adm-money-of">
                  {isTokenUnlimited ? '／ 無制限' : `／ ${usd(asMoney(user.monthlyLimit))}`}
                </span>
              )}
            </span>
            {oneMonth && !isTokenUnlimited && (
              <span className="adm-bar-wrap" aria-hidden="true">
                <span
                  className={`adm-bar-fill${percent > 80 ? ' adm-bar-fill--warn' : ''}`}
                  style={{ width: `${percent}%` }}
                />
              </span>
            )}
          </div>
        </td>
      )}
      <td className="adm-td adm-td--muted">{user.lastUpdated ? formatDate(user.lastUpdated) : '-'}</td>
    </tr>
  );
}

type SortKey = 'totalTokens' | 'requestCount' | 'lastUpdated' | 'displayName';

// --- Usage tab ---
/**
 * How much each account has spent this month, and nothing else.
 *
 * The limits and the model list live on the user tab now. This one had eight
 * columns because it answered two questions at once — what an account spent, and
 * what it is allowed to — and they are asked at different times by a person
 * looking for different things. The budget stays editable beside the usage it
 * bounds, because that is the one moment the two questions meet.
 */
function UsageTab({
  users,
  loading,
  period,
  onPeriodChange,
}: {
  users: UserUsageSummary[];
  loading: boolean;
  period: Period;
  onPeriodChange: (p: Period) => void;
}) {
  /*
   * A budget is monthly, so it is only a comparison when the period is one
   * month. Over a quarter the money is still the money — the ratio is not, and
   * drawing a bar of 「$26 / $10」 would report three months of correct spending
   * as three times over budget.
   */
  const oneMonth = period.from === period.to;
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('totalTokens');
  /*
   * Whether the server priced anything this month. Read from the rows rather
   * than from a separate setting: the cost is null for every user until a table
   * exists, and one priced row is the only proof the table is in place AND
   * covers what was actually run.
   */
  const priced = users.some((u) => typeof u.cost === 'number');
  const [sortAsc, setSortAsc] = useState(false);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc((v) => !v);
    else { setSortKey(key); setSortAsc(false); }
  };

  const sorted = useMemo(() => {
    const filtered = users.filter((u) =>
      !search
      || u.displayName.toLowerCase().includes(search.toLowerCase())
      || u.email.toLowerCase().includes(search.toLowerCase())
      || u.userId.toLowerCase().includes(search.toLowerCase())
    );
    return [...filtered].sort((a, b) => {
      let av: any = a[sortKey];
      let bv: any = b[sortKey];
      if (sortKey === 'lastUpdated') { av = av || ''; bv = bv || ''; }
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortAsc ? cmp : -cmp;
    });
  }, [users, search, sortKey, sortAsc]);

  /**
   * Drawn rather than typed. The arrows used to be the characters ↑ ↓ ↕, which
   * render in whatever the system font happens to supply — a different weight and
   * baseline from every other icon in the app, and at the mercy of font fallback.
   */
  const SortIcon = ({ k }: { k: SortKey }) => {
    const active = sortKey === k;
    return (
      <span className={`adm-sort-icon${active ? '' : ' adm-sort-icon--idle'}`} aria-hidden="true">
        <svg width="9" height="12" viewBox="0 0 10 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          {(!active || sortAsc) && <path d="M5 1.5 L5 6 M2.5 3.5 L5 1 L7.5 3.5" />}
          {(!active || !sortAsc) && <path d="M5 12.5 L5 8 M2.5 10.5 L5 13 L7.5 10.5" />}
        </svg>
      </span>
    );
  };

  return (
    <div>
      {/*
        The picker is drawn before the loading check, not after: it is the
        control that CAUSES the load, and hiding it while its own request is in
        flight makes the panel look like it lost the toolbar every time somebody
        changes the period.
      */}
      <div className="adm-toolbar adm-toolbar--period">
        <PeriodPicker value={period} onChange={onPeriodChange} />
      </div>
      {loading && users.length === 0 ? (
        <div className="adm-loading"><span className="adm-spinner" /><span>読み込み中…</span></div>
      ) : (
      <>
      {users.length > 0 && <SummaryBar users={users} period={period} />}
      <div className="adm-toolbar">
        <input
          type="search"
          className="adm-search"
          placeholder="ユーザー名/メールアドレスで検索"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="ユーザー名/メールアドレスで検索"
        />
        <button
          onClick={() => downloadCSV(sorted)}
          className="adm-btn adm-btn--secondary adm-btn--sm"
          type="button"
          title="CSVダウンロード"
          disabled={sorted.length === 0}
        >
          CSV
        </button>
      </div>
      <div className="adm-table-wrap">
        <table className="adm-table" aria-label="ユーザー使用量一覧">
          <thead>
            <tr>
              <th className="adm-th adm-th--sortable" onClick={() => handleSort('displayName')}>
                ユーザー <SortIcon k="displayName" />
              </th>
              <th className="adm-th">所属グループ</th>
              <th className="adm-th adm-th--num adm-th--sortable" onClick={() => handleSort('totalTokens')}>
                トークン数 <SortIcon k="totalTokens" />
              </th>
              <th className="adm-th adm-th--num adm-th--sortable" onClick={() => handleSort('requestCount')}>
                リクエスト数 <SortIcon k="requestCount" />
              </th>
              {/*
                The month's spend against the month's budget, in one column,
                because neither number answers anything on its own. Only when a
                price table is configured: a column of 「—」 is a column people
                learn to skip, and a 0 there would claim the month was free.
                The budget is set on the user tab; this reports it.
              */}
              {priced && (
                <th className="adm-th adm-th--num">
                  {oneMonth ? '今月の金額 / 予算' : '期間の金額'}
                </th>
              )}
              <th className="adm-th adm-th--date adm-th--sortable" onClick={() => handleSort('lastUpdated')}>
                更新日時 <SortIcon k="lastUpdated" />
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((user) => (
              <UsageRow key={user.userId} user={user} priced={priced} oneMonth={oneMonth} />
            ))}
            {sorted.length === 0 && (
              <tr>
                {/*
                  Five columns without a price table, six with one — the empty
                  row has to span whatever the header actually drew. It said
                  eight and seven, left over from when the limits and the model
                  list were on this tab, so the 「該当するユーザーがいません」
                  row ran two columns past the end of the table.
                */}
                <td colSpan={priced ? 6 : 5} className="adm-td adm-td--empty">
                  {search ? '該当するユーザーがいません' : '使用データがありません'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      </>
      )}
    </div>
  );
}

// --- Users tab ---
function UsersTab({
  cognitoUsers,
  cognitoLoading,
  usage,
  onRefresh,
  onCreateUser,
  onDeleteUser,
  onToggleEnabled,
  onRename,
  onSetLimit,
  onSetModels,
  canManageAccounts,
  canSetLimits,
}: {
  cognitoUsers: CognitoUser[];
  cognitoLoading: boolean;
  /**
   * The usage rows, for the limits they carry.
   *
   * Joined on the email address, because a Cognito listing has no `sub` on it
   * and the usage row has both. The pool's username IS the email, so the join
   * is on a unique key rather than on a name.
   *
   * A row is present for every account now, spending or not — the server fills
   * a zero one in. Before that, the accounts an administrator most wants to
   * configure, the new ones, were the ones with no row to configure.
   */
  usage: UserUsageSummary[];
  onRefresh: () => void;
  onCreateUser: (displayName: string, email: string, temporaryPassword: string) => Promise<void>;
  onDeleteUser: (username: string) => Promise<void>;
  onToggleEnabled: (username: string, enable: boolean) => Promise<void>;
  onRename: (username: string, displayName: string) => Promise<void>;
  onSetLimit: (userId: string, limit: number) => Promise<void>;
  onSetModels: (userId: string, models: ModelId[]) => Promise<void>;
  /** False for a group administrator: adding and removing accounts is not theirs. */
  canManageAccounts: boolean;
  /** And neither is what the account may spend. */
  canSetLimits: boolean;
}) {
  const usageOf = (email: string): UserUsageSummary | undefined =>
    usage.find((u) => u.email && u.email.toLowerCase() === email.toLowerCase());
  const [showForm, setShowForm] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deletingUsername, setDeletingUsername] = useState<string | null>(null);
  const [togglingUsername, setTogglingUsername] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const filtered = cognitoUsers.filter((u) => {
    if (!search) return true;
    const q = search.toLowerCase();
    // The name is what the list is read by now, so it has to be searchable —
    // otherwise typing what you can see finds nothing.
    return u.displayName.toLowerCase().includes(q)
      || u.email.toLowerCase().includes(q)
      || u.username.toLowerCase().includes(q);
  });

  const handleCreate = async () => {
    if (!displayName.trim() || !email.trim() || !password.trim()) {
      setFormError('ユーザー名・メールアドレス・仮パスワードは必須です');
      return;
    }
    setCreating(true);
    setFormError(null);
    try {
      await onCreateUser(displayName.trim(), email.trim(), password.trim());
      setDisplayName('');
      setEmail('');
      setPassword('');
      setShowForm(false);
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (username: string) => {
    if (!window.confirm(`ユーザー「${username}」を削除しますか？この操作は取り消せません。`)) return;
    setDeletingUsername(username);
    try {
      await onDeleteUser(username);
    } catch (e) {
      alert(`削除に失敗しました: ${(e as Error).message}`);
    } finally {
      setDeletingUsername(null);
    }
  };

  const handleToggle = async (u: CognitoUser) => {
    setTogglingUsername(u.username);
    try {
      await onToggleEnabled(u.username, !u.enabled);
    } catch (e) {
      alert(`${u.enabled ? '無効化' : '有効化'}に失敗しました: ${(e as Error).message}`);
    } finally {
      setTogglingUsername(null);
    }
  };

  const statusCounts = {
    total: cognitoUsers.length,
    confirmed: cognitoUsers.filter((u) => u.status === 'CONFIRMED').length,
    pending: cognitoUsers.filter((u) => u.status === 'FORCE_CHANGE_PASSWORD').length,
    disabled: cognitoUsers.filter((u) => !u.enabled).length,
  };

  return (
    <div className="adm-users-tab">
      {cognitoUsers.length > 0 && (
        <div className="adm-summary">
          <div className="adm-summary__item">
            <span className="adm-summary__val">{statusCounts.total}</span>
            <span className="adm-summary__label">合計</span>
          </div>
          <div className="adm-summary__item">
            <span className="adm-summary__val">{statusCounts.confirmed}</span>
            <span className="adm-summary__label">確認済み</span>
          </div>
          {statusCounts.pending > 0 && (
            <div className="adm-summary__item adm-summary__item--warn">
              <span className="adm-summary__val">{statusCounts.pending}</span>
              <span className="adm-summary__label">パスワード変更待ち</span>
            </div>
          )}
          {statusCounts.disabled > 0 && (
            <div className="adm-summary__item adm-summary__item--muted">
              <span className="adm-summary__val">{statusCounts.disabled}</span>
              <span className="adm-summary__label">無効</span>
            </div>
          )}
        </div>
      )}

      <div className="adm-users-toolbar">
        {canManageAccounts && (
          <button
            onClick={() => { setShowForm((s) => !s); setFormError(null); }}
            className="adm-btn adm-btn--primary"
            type="button"
          >
            {showForm ? '− キャンセル' : '+ ユーザーを追加'}
          </button>
        )}
        <button onClick={onRefresh} disabled={cognitoLoading} className="adm-btn adm-btn--secondary" type="button">
          {cognitoLoading ? '更新中…' : '更新'}
        </button>
      </div>

      {showForm && canManageAccounts && (
        <div className="adm-create-form">
          <div className="adm-create-form__title">新規ユーザー作成</div>
          {formError && <div className="adm-error-banner" role="alert">{formError}</div>}
          <div className="adm-create-form__row">
            <div className="adm-field">
              <label className="adm-field__label" htmlFor="adm-name">ユーザー名</label>
              <input
                id="adm-name"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="adm-input"
                placeholder="山田 太郎"
                maxLength={64}
                autoComplete="off"
              />
            </div>
            <div className="adm-field">
              <label className="adm-field__label" htmlFor="adm-email">メールアドレス（ログインID）</label>
              <input
                id="adm-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="adm-input"
                placeholder="user@example.com"
                autoComplete="off"
              />
            </div>
            <div className="adm-field">
              <label className="adm-field__label" htmlFor="adm-password">仮パスワード</label>
              <input
                id="adm-password"
                type="text"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="adm-input"
                placeholder="Temp@1234"
                autoComplete="off"
              />
            </div>
            <button
              onClick={handleCreate}
              disabled={creating}
              className="adm-btn adm-btn--primary adm-btn--create"
              type="button"
            >
              {creating ? '作成中…' : '作成'}
            </button>
          </div>
        </div>
      )}

      <div className="adm-toolbar">
        <input
          type="search"
          className="adm-search"
          placeholder="ユーザー名/メールアドレスで検索"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="ユーザー検索"
        />
      </div>

      {cognitoLoading && cognitoUsers.length === 0 ? (
        <div className="adm-loading">
          <span className="adm-spinner" />
          <span>読み込み中…</span>
        </div>
      ) : (
        <div className="adm-table-wrap">
          <table className="adm-table" aria-label="Cognitoユーザー一覧">
            <thead>
              <tr>
                <th className="adm-th">ユーザー</th>
                <th className="adm-th">メールアドレス（ログインID）</th>
                <th className="adm-th">所属グループ</th>
                <th className="adm-th">月間予算</th>
                <th className="adm-th">利用可能モデル</th>
                <th className="adm-th">ステータス</th>
                <th className="adm-th">有効</th>
                <th className="adm-th adm-th--date">作成日時</th>
                <th className="adm-th adm-th--act"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => (
                <tr key={u.username} className="adm-tr">
                  <td className="adm-td">
                    <NameEditor user={u} onRename={onRename} />
                  </td>
                  <td className="adm-td adm-td--muted">{u.email || u.username}</td>
                  {/*
                    What the account is allowed, where the account is managed.
                    These three lived on the usage tab, which is about what was
                    spent — a different question, asked at a different moment.
                  */}
                  <td className="adm-td adm-td--muted">
                    {u.group ?? '—'}
                    {u.isGroupAdmin && <span className="adm-badge adm-badge--neutral">管理者</span>}
                  </td>
                  {(() => {
                    const row = usageOf(u.email || u.username);
                    if (!row) {
                      /* No usage row means the directory and the ledger disagree
                         about this account, which is a state worth showing rather
                         than two blank cells. */
                      return (
                        <td className="adm-td adm-td--muted" colSpan={2} title="使用量の記録が見つかりません">
                          —
                        </td>
                      );
                    }
                    return (
                      <>
                        <td className="adm-td">
                          {/* The figure goes inside, so it steps aside while the
                              editor is open rather than sharing the line — see
                              the note on BudgetEditor's `children`. */}
                          <BudgetEditor
                            value={row.monthlyLimit}
                            onSave={(limit) => onSetLimit(row.userId, limit)}
                            disabled={!canSetLimits}
                          >
                            <span className="adm-limit-val">
                              {row.monthlyLimit === UNLIMITED ? '無制限' : usd(asMoney(row.monthlyLimit))}
                            </span>
                          </BudgetEditor>
                        </td>
                        <td className="adm-td">
                          {/* Recorded here, enforced in the pipeline: these boxes
                              change what the server will honour, not merely what
                              the composer offers. */}
                          <ModelPicker
                            models={row.allowedModels ?? ALL_MODELS}
                            onSave={(models) => onSetModels(row.userId, models)}
                          />
                        </td>
                      </>
                    );
                  })()}
                  <td className="adm-td">
                    <span className={`adm-badge ${u.status === 'CONFIRMED' ? 'adm-badge--success' : u.status === 'FORCE_CHANGE_PASSWORD' ? 'adm-badge--warn' : 'adm-badge--neutral'}`}>
                      {u.status === 'FORCE_CHANGE_PASSWORD' ? 'PW変更待ち' : u.status}
                    </span>
                  </td>
                  <td className="adm-td">
                    <button
                      onClick={() => handleToggle(u)}
                      disabled={togglingUsername === u.username}
                      className={`adm-toggle-btn${u.enabled ? ' adm-toggle-btn--on' : ' adm-toggle-btn--off'}`}
                      title={u.enabled ? 'クリックで無効化' : 'クリックで有効化'}
                      type="button"
                    >
                      {togglingUsername === u.username ? '…' : u.enabled ? '有効' : '無効'}
                    </button>
                  </td>
                  <td className="adm-td adm-td--muted">{formatDate(u.createdAt)}</td>
                  <td className="adm-td adm-td--action">
                    {canManageAccounts && (
                    <button
                      onClick={() => handleDelete(u.username)}
                      disabled={deletingUsername === u.username}
                      className="adm-btn adm-btn--danger-ghost adm-btn--sm"
                      type="button"
                      aria-label={`${u.displayName || u.email || u.username} を削除`}
                    >
                      {deletingUsername === u.username ? '…' : '削除'}
                    </button>
                    )}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={9} className="adm-td adm-td--empty">
                    {search ? '該当するユーザーがいません' : 'ユーザーがいません'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * What a user actually made.
 *
 * The usage tab answers how much someone spent; this answers on what. Three
 * levels, because that is how the data is shaped and because each level is a
 * separate request: a user's projects, a project's versions, and one version's
 * document.
 *
 * The prompt is the column that matters and is given the room. A project name is
 * usually something typed once and never revisited; the prompt is the thing that
 * explains why a run cost what it cost, and it is the only field here that a
 * person wrote.
 */
function ProjectsTab({
  users,
  openOn,
  fetchProjects,
  fetchProjectVersions,
  fetchVersion,
}: {
  users: UserUsageSummary[];
  /**
   * An account to open on, from somewhere else in the panel.
   *
   * Carries a token as well as an id so that asking twice for the SAME person
   * still reopens them: a plain id would be equal to the one already showing
   * and the effect would not fire, which reads as the button doing nothing.
   */
  openOn: { userId: string; token: number } | null;
  fetchProjects: (userId: string) => Promise<AdminProject[]>;
  fetchProjectVersions: (userId: string, projectId: string) => Promise<AdminVersion[]>;
  fetchVersion: (userId: string, versionId: string) => Promise<AdminVersion>;
}) {
  const [userId, setUserId] = useState<string>('');
  /** Which prompts have been opened out of their three-line clamp. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [userSearch, setUserSearch] = useState('');
  const [projectSearch, setProjectSearch] = useState('');
  const [projects, setProjects] = useState<AdminProject[]>([]);
  const [projectId, setProjectId] = useState<string>('');
  const [versions, setVersions] = useState<AdminVersion[]>([]);
  const [viewing, setViewing] = useState<AdminVersion | null>(null);
  const [busy, setBusy] = useState<'projects' | 'versions' | 'document' | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async (what: 'projects' | 'versions' | 'document', f: () => Promise<void>) => {
    setBusy(what);
    setErr(null);
    try {
      await f();
    } catch (e) {
      setErr((e as Error).message || '読み込みに失敗しました');
    } finally {
      setBusy(null);
    }
  };

  const openUser = (id: string) => {
    setUserId(id);
    setProjectId('');
    setVersions([]);
    setProjects([]);
    setViewing(null);
    if (id) run('projects', async () => setProjects(await fetchProjects(id)));
  };

  const openProject = (id: string) => {
    setProjectId(id);
    setVersions([]);
    setViewing(null);
    if (id) run('versions', async () => setVersions(await fetchProjectVersions(userId, id)));
  };

  const openVersion = (versionId: string) =>
    run('document', async () => setViewing(await fetchVersion(userId, versionId)));

  const togglePrompt = (versionId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(versionId)) next.delete(versionId);
      else next.add(versionId);
      return next;
    });
  };

  /*
   * Opened from another tab. `openOnRef` holds the token that has been acted
   * on, so a re-render for any other reason does not refetch — and the effect
   * depends on the token rather than the id, so the same person can be asked
   * for twice.
   */
  const openOnRef = useRef<number>(0);
  useEffect(() => {
    if (!openOn || openOn.token === openOnRef.current) return;
    openOnRef.current = openOn.token;
    setUserSearch('');
    setExpanded(new Set());
    openUser(openOn.userId);
    // `openUser` is redefined every render and starts a fetch; depending on it
    // would restart that fetch on every render, which is the shape of the
    // runaway-save loop this project has already had once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openOn]);

  const chosen = users.find((u) => u.userId === userId) ?? null;
  const matches = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) =>
      u.displayName.toLowerCase().includes(q)
      || u.email.toLowerCase().includes(q)
      || u.userId.toLowerCase().includes(q));
  }, [users, userSearch]);

  const project = projects.find((p) => p.projectId === projectId);
  /*
   * The project list narrows too, on the same rule as the user picker above it.
   *
   * One account has thirteen projects and the names are mostly 「Untitled」, so
   * what identifies a row is as often the framework or the design system as the
   * name — all three are on the row, so all three are searched. The chosen
   * project stays in the list whether or not it still matches: it is what the
   * right-hand pane is showing, and a row disappearing from under the history it
   * belongs to reads as the history belonging to nothing.
   */
  const shownProjects = useMemo(() => {
    const q = projectSearch.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) =>
      p.projectId === projectId
      || p.name.toLowerCase().includes(q)
      || (p.outputKind ?? '').toLowerCase().includes(q)
      || (p.preset ?? '').toLowerCase().includes(q));
  }, [projects, projectSearch, projectId]);
  /*
   * Summed from the projects rather than taken from the usage row. They answer
   * different questions — the usage row is this month across everything,
   * including runs whose project has since been deleted — and putting one under
   * the other with the same label would invite them to be compared.
   */
  const counted = projects.filter((p) => p.totalTokens !== undefined);

  return (
    <div className="adm-tabpane">
      <div className="adm-toolbar">
        {/*
          * A search box, not a dropdown.
          *
          * A <select> is fine for five accounts and wrong for fifty: it has to be
          * opened before it can be read, it cannot be typed into, and the name a
          * person is looking for is the one thing they already know. The list
          * below narrows as they type and the current pick stays visible whether
          * or not it still matches.
          */}
        <input
          className="adm-input adm-input--search"
          type="search"
          value={userSearch}
          onChange={(e) => setUserSearch(e.target.value)}
          placeholder="ユーザー名/メールアドレスで検索"
          aria-label="ユーザー名/メールアドレスで検索"
        />
        {chosen ? (
          <>
            <span className="adm-toolbar__chosen">
              {chosen.displayName || chosen.email}
              {chosen.group && <span className="adm-uid">{chosen.group}</span>}
            </span>
            <button
              className="adm-btn adm-btn--ghost adm-btn--sm"
              type="button"
              onClick={() => openUser('')}
            >
              選択を解除
            </button>
            <span className="adm-toolbar__note">
              {projects.length}プロジェクト
              {counted.length > 0 && ` ・ 合計 ${formatNumber(counted.reduce((n, p) => n + (p.totalTokens ?? 0), 0))} トークン`}
              {counted.length < projects.length && `（${projects.length - counted.length}件は計測前）`}
            </span>
          </>
        ) : (
          <span className="adm-toolbar__note">
            {matches.length} / {users.length} 件
          </span>
        )}
      </div>

      {!chosen && (
        <div className="adm-userpicks">
          {matches.map((u) => (
            <button
              key={u.userId}
              type="button"
              className="adm-userpick"
              onClick={() => openUser(u.userId)}
            >
              <span className="adm-userpick__line">
                <span className="adm-email">{u.displayName || u.email || u.userId}</span>
                {/*
                  How much there is to read, before the click rather than after.
                  This picker is a list of names with nothing to choose between
                  them, and the account with thirteen projects and the one with
                  none looked identical — so finding somebody's work meant
                  opening people one at a time.
                */}
                {typeof u.projectCount === 'number' && (
                  <span className="adm-userpick__count">{u.projectCount} 件</span>
                )}
              </span>
              {/* The address stays as the second line: names are not unique, and
                  this picker decides whose work is about to be read. The group
                  is on the same line because "which tenant" is the other half of
                  that question. */}
              <span className="adm-uid">{u.email}{u.group ? ` ・ ${u.group}` : ''}</span>
            </button>
          ))}
          {matches.length === 0 && (
            <div className="adm-empty">
              {userSearch ? '該当するユーザーがいません' : 'ユーザーがいません'}
            </div>
          )}
        </div>
      )}

      {err && <div className="adm-error-banner" role="alert">{err}</div>}

      {!userId ? null : busy === 'projects' ? (
        <div className="adm-loading"><span>読み込み中…</span></div>
      ) : (
        <div className="adm-split">
          <div className="adm-split__col">
            <div className="adm-split__head">
              プロジェクト
              {/*
                Always, not only while searching. 「何件あるか」 is the first
                thing asked of a list, and it was answered only once somebody
                had typed into the box — so an unfiltered list of thirteen
                showed no number at all.
              */}
              {userId && (
                <span className="adm-split__note">
                  {projectSearch
                    ? `${shownProjects.length} / ${projects.length} 件`
                    : `${projects.length} 件`}
                </span>
              )}
            </div>
            <div className="adm-subbar">
              <input
                className="adm-input adm-input--sm"
                type="search"
                value={projectSearch}
                onChange={(e) => setProjectSearch(e.target.value)}
                placeholder="プロジェクト名/フレームワークで検索"
                aria-label="プロジェクト名/フレームワークで検索"
              />
            </div>
            <div className="adm-table-wrap">
              <table className="adm-table">
                <thead>
                  <tr>
                    <th className="adm-th">プロジェクト</th>
                    <th className="adm-th adm-th--num adm-th--tok">トークン数</th>
                    <th className="adm-th adm-th--num adm-th--run">リクエスト数</th>
                    <th className="adm-th adm-th--date">更新日時</th>
                  </tr>
                </thead>
                <tbody>
                  {shownProjects.map((p) => (
                    <tr
                      key={p.projectId}
                      className={`adm-tr adm-tr--click${p.projectId === projectId ? ' adm-tr--active' : ''}`}
                      onClick={() => openProject(p.projectId)}
                    >
                      <td className="adm-td">
                        <span className="adm-email">{p.name}</span>
                        <span className="adm-uid">
                          {p.outputKind ?? '-'}
                          {p.preset && p.preset !== 'none' ? ` ・ ${p.preset}` : ''}
                          {p.archivedAt ? ' ・ アーカイブ済' : ''}
                        </span>
                      </td>
                      {/* Absent is not zero: these projects predate the counter. */}
                      <td className="adm-td adm-td--num">{p.totalTokens === undefined ? '—' : formatNumber(p.totalTokens)}</td>
                      <td className="adm-td adm-td--num">{p.requestCount ?? '—'}</td>
                      <td className="adm-td adm-td--muted">{formatDate(p.updatedAt)}</td>
                    </tr>
                  ))}
                  {shownProjects.length === 0 && (
                    <tr>
                      <td colSpan={4} className="adm-td adm-td--empty">
                        {projectSearch ? '該当するプロジェクトがありません' : 'プロジェクトがありません'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="adm-split__col">
            <div className="adm-split__head">
              {project ? `${project.name} の履歴` : '履歴'}
              {/*
                The project row's total is the sum over every RUN, including the
                ones whose document was rejected; these are the runs that
                produced a version. They do not add up to it and should not be
                read as if they do.
              */}
              {project && (
                <span className="adm-split__note">
                  {versions.length > 0 ? `${versions.length} 件 ・ ` : ''}実行ごとの消費
                </span>
              )}
            </div>
            {!projectId ? (
              <div className="adm-empty">プロジェクトを選ぶと、投入されたプロンプトと生成結果が表示されます</div>
            ) : busy === 'versions' ? (
              <div className="adm-loading"><span>読み込み中…</span></div>
            ) : (
              <div className="adm-table-wrap">
                <table className="adm-table">
                  <thead>
                    <tr>
                      <th className="adm-th">プロンプト</th>
                      <th className="adm-th adm-th--num adm-th--tok">トークン数</th>
                      <th className="adm-th adm-th--num adm-th--run">スコア</th>
                      <th className="adm-th adm-th--num adm-th--quality">要件・指摘</th>
                      <th className="adm-th adm-th--model">モデル</th>
                      <th className="adm-th adm-th--date">実行日時</th>
                      <th className="adm-th adm-th--act"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {versions.map((v) => (
                      <tr key={v.versionId} className="adm-tr">
                        <td className="adm-td">
                          {/*
                            * The clamp lives on a div inside the cell, not on the
                            * cell. `display: -webkit-box` on a <td> replaces the
                            * table-cell display and the clamp stops holding — it
                            * drew the ellipsis at line three and then a fourth
                            * line under it.
                            *
                            * And it opens. A prompt is the one field on this row
                            * somebody reads rather than scans, and three lines of
                            * it plus a `title` tooltip is not reading — a tooltip
                            * cannot be scrolled, cannot be selected, and goes
                            * away when the pointer moves. A button rather than a
                            * div with a handler, so it is reachable by keyboard
                            * and announces its state.
                            */}
                          <button
                            type="button"
                            className={`adm-prompt${expanded.has(v.versionId) ? ' adm-prompt--open' : ''}`}
                            onClick={() => togglePrompt(v.versionId)}
                            aria-expanded={expanded.has(v.versionId)}
                            title={expanded.has(v.versionId) ? 'クリックで折りたたむ' : 'クリックで全文を表示'}
                          >
                            {v.prompt || '（プロンプトなし）'}
                          </button>
                        </td>
                        {/* Absent is not zero — see AdminVersion.tokens. */}
                        <td
                          className="adm-td adm-td--num"
                          title={v.tokens ? `入力 ${v.tokens.input.toLocaleString()} / 出力 ${v.tokens.output.toLocaleString()}` : '記録前のバージョンです'}
                        >
                          {v.tokens ? formatNumber(v.tokens.input + v.tokens.output) : '—'}
                        </td>
                        <td className="adm-td adm-td--num">
                          {v.score}
                          {/*
                            * An edit is scored without a browser, so up to 173
                            * points of runtime deduction are unreachable on it.
                            * Saying which is which is the difference between a
                            * comparable number and a misleading one.
                            */}
                          {v.scoreVerified === false && <span className="adm-uid">静的のみ</span>}
                          {isOlderScoreScale(v) && (
                            <span className="adm-uid" title="計測方法の変更（2026-09-13）より前のスコアです。変更後のスコアとは直接比べられません。">
                              旧基準
                            </span>
                          )}
                        </td>
                        {/*
                          * What the score cannot say: whether the version does
                          * what was asked, and what it shipped still wrong. Both
                          * were only in the chat reply. A dash is "not recorded",
                          * never zero.
                          */}
                        <td
                          className="adm-td adm-td--num"
                          title={versionQualityTitle(v)}
                        >
                          {versionQualityLabel(v)}
                        </td>
                        <td className="adm-td adm-td--muted">{v.model || '-'}</td>
                        <td className="adm-td adm-td--muted">{formatDate(v.createdAt)}</td>
                        <td className="adm-td adm-td--action">
                          <button
                            className="adm-btn adm-btn--secondary adm-btn--sm"
                            type="button"
                            onClick={() => openVersion(v.versionId)}
                            disabled={busy === 'document'}
                          >
                            表示
                          </button>
                        </td>
                      </tr>
                    ))}
                    {versions.length === 0 && (
                      <tr><td colSpan={6} className="adm-td adm-td--empty">履歴がありません</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {viewing && <ViewerOverlay version={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

/**
 * The generated UI itself, with the prompt that asked for it above it.
 *
 * Renders through `Preview`, the same component the workspace uses, rather than
 * writing the stored document into an iframe directly. Writing it directly is
 * what shipped, and it showed the source: a stored project is not an HTML page,
 * it is the fenced multi-file transport — `@@@makeui:file src/App.tsx` and the
 * rest — which a browser renders as the text it is. Only React output is ever a
 * runnable document without a build, and none of the three frameworks is stored
 * that way.
 *
 * Reusing the component rather than repeating its three steps
 * (`splitHtmlToFiles` → `toProjectFiles` → `buildReactPreview`) is the point: an
 * admin looking at somebody's work should see what that person saw, and a second
 * compile path would eventually disagree about which projects render. It brings
 * its own `sandbox="allow-scripts"` with it — these are React, Vue and Svelte
 * projects built from user prompts, so they need scripts to render at all, but
 * not same-origin, which would put another user's generated code on this origin
 * with an admin session in it.
 */
function ViewerOverlay({ version, onClose }: { version: AdminVersion; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="adm-viewer" role="dialog" aria-label="生成されたUI">
      <div className="adm-viewer__bar">
        <div className="adm-viewer__meta">
          <span className="adm-viewer__prompt" title={version.prompt}>{version.prompt || '（プロンプトなし）'}</span>
          <span className="adm-uid">
            {formatDate(version.createdAt)} ・ {version.model || '-'} ・ スコア {version.score}
          </span>
        </div>
        <button className="adm-btn adm-btn--ghost adm-btn--icon" onClick={onClose} aria-label="閉じる" type="button">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>
      </div>
      {version.html ? (
        <div className="adm-viewer__frame">
          <Preview html={version.html} score={version.score} />
        </div>
      ) : (
        <div className="adm-empty">このバージョンのドキュメントは残っていません</div>
      )}
    </div>
  );
}

/**
 * User groups, and who administers each.
 *
 * Super-admin only, and the tab is not drawn for anyone else — a group
 * administrator who could create groups or move accounts between them could
 * appoint themselves over another one, which is the whole boundary this
 * introduces. The server refuses it too; this is the convenience.
 *
 * ## Shaped around the group, not around the row
 *
 * The first version put a `<select>` in every row of both tables: one to choose
 * a user's group, one to choose a group's administrator. It worked and it was
 * unpleasant. Three things were wrong with it and they compound.
 *
 * The two panes were unrelated, so moving three people into a group meant
 * finding each of them in a list of everybody and setting the same value three
 * times. Appointing an administrator needed the person to be in the group
 * ALREADY, because the menu was built from the group's members — so the natural
 * order, "make Taro the admin of Acme", was two operations in two tables with a
 * refetch between them. And neither list could be searched, which is fine for
 * five accounts and the reason a directory control has a search box.
 *
 * So the group is selected on the left and the right pane acts on it. Every
 * account is listed once, with the action that makes sense for it: in this
 * group, in another one, or in none. Appointing is a button on the member's own
 * row, and the server adds the membership if it is missing, so the order stops
 * mattering.
 *
 * The one pulldown left is the one a pulldown is right for — picking the
 * administrator out of the members — and it is the composer's `Dropdown` rather
 * than a native `<select>`, so every menu in the product looks the same.
 */
function GroupsTab({
  groups,
  users,
  onCreate,
  onDelete,
  onSetMembership,
  onSetAdmin,
  onSetLimit,
  onSetUserLimit,
  canSetGroupLimit,
  usage,
  onSetModels,
  onOpenProjects,
  onRefresh,
}: {
  groups: UserGroup[];
  users: CognitoUser[];
  onCreate: (name: string, description?: string) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
  onSetMembership: (username: string, group: string | null) => Promise<void>;
  onSetAdmin: (group: string, username: string | null) => Promise<void>;
  onSetLimit: (group: string, limit: number) => Promise<void>;
  /**
   * One member's own budget, set from the list they are being managed in.
   *
   * The same route the user tab uses, over the same account. Splitting a group's
   * budget among its people is the reason the group's total exists, and doing it
   * meant leaving this screen, opening the user tab and finding the same person
   * again — from a list that already has them in front of you. This tab is
   * super-admin only, so there is nothing further to gate.
   */
  onSetUserLimit: (userId: string, limit: number) => Promise<void>;
  /**
   * The usage rows, joined to the member list by email.
   *
   * A `CognitoUser` is the directory's answer and carries no allowance; which
   * models an account may pick is stored beside its budget, on the usage row.
   * The two are joined here for the same reason the user tab joins them — the
   * member list is where a group administrator is already standing.
   */
  usage: UserUsageSummary[];
  onSetModels: (userId: string, models: ModelId[]) => Promise<void>;
  /** Opens the projects tab on one account. Nothing else can reach it. */
  onOpenProjects: (userId: string) => void;
  /**
   * False for a group administrator. They divide their group's budget among
   * their people on the usage tab; the total is what the account is billed
   * against, and raising it is the account administrator's.
   */
  canSetGroupLimit: boolean;
  onRefresh: () => void;
}) {
  const [name, setName] = useState('');
  const [groupSearch, setGroupSearch] = useState('');
  const [userSearch, setUserSearch] = useState('');
  const [selected, setSelected] = useState<string>('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  /*
   * Which row is working, not merely that something is. The first version set a
   * single boolean and disabled every control on the tab, so one appointment
   * froze forty rows and the person who clicked could not tell which of them
   * they had clicked.
   */
  const run = async (what: string, f: () => Promise<void>) => {
    setBusy(what);
    setErr(null);
    try { await f(); } catch (e) { setErr((e as Error).message || '操作に失敗しました'); }
    finally { setBusy(null); }
  };

  const create = () => {
    if (!name.trim()) { setErr('グループ名を入力してください'); return; }
    run('create', async () => { await onCreate(name.trim()); setName(''); setSelected(name.trim()); });
  };

  const remove = (g: UserGroup) => {
    /*
     * The confirmation says what survives, because the fear is the opposite —
     * "delete the group" reads as "delete these people". It does not: the
     * accounts, their projects and their usage are untouched and simply belong
     * to nothing until they are placed again.
     */
    if (!window.confirm(
      `グループ「${g.name}」を削除しますか？\n\n所属している${g.memberCount}人のアカウントは削除されません。` +
      `プロジェクトも使用量もそのまま残り、どのグループにも属さない状態になります。`
    )) return;
    run(`del:${g.name}`, async () => { await onDelete(g.name); if (selected === g.name) setSelected(''); });
  };

  const shownGroups = useMemo(() => {
    const q = groupSearch.trim().toLowerCase();
    return q ? groups.filter((g) => g.name.toLowerCase().includes(q)) : groups;
  }, [groups, groupSearch]);

  const group = groups.find((g) => g.name === selected) ?? null;

  /*
   * Members first, then everyone else. A directory sorted by name puts the
   * people this group already has among fifty it does not, and the question the
   * pane answers is "who is in this group".
   */
  const shownUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    const matched = q
      ? users.filter((u) =>
          u.displayName.toLowerCase().includes(q)
          || u.email.toLowerCase().includes(q)
          || (u.group ?? '').toLowerCase().includes(q))
      : users;
    if (!group) return matched;
    const rank = (u: CognitoUser) => (u.group === group.name ? 0 : u.group ? 2 : 1);
    return [...matched].sort((a, b) => rank(a) - rank(b)
      || (a.displayName || a.username).localeCompare(b.displayName || b.username));
  }, [users, userSearch, group]);

  const members = group ? users.filter((u) => u.group === group.name) : [];

  return (
    <div className="adm-tabpane adm-tabpane--groups">
      <div className="adm-toolbar">
        <input
          className="adm-input adm-input--search"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') create(); }}
          placeholder="新しいグループ名"
          maxLength={63}
          aria-label="新しいグループ名"
        />
        <button className="adm-btn adm-btn--primary adm-btn--sm" type="button" onClick={create} disabled={busy !== null}>
          作成
        </button>
        <button className="adm-btn adm-btn--secondary adm-btn--sm" type="button" onClick={onRefresh} disabled={busy !== null}>
          更新
        </button>
        <span className="adm-toolbar__note">
          {groups.length}グループ ・ {users.filter((u) => u.group).length}/{users.length}人が所属
        </span>
      </div>

      {err && <div className="adm-error-banner" role="alert">{err}</div>}

      <div className="adm-split">
        <div className="adm-split__col">
          <div className="adm-split__head">
            グループ
            <span className="adm-split__note">選ぶと右で所属を編集できます</span>
          </div>
          <div className="adm-subbar">
            <input
              className="adm-input adm-input--sm"
              type="search"
              value={groupSearch}
              onChange={(e) => setGroupSearch(e.target.value)}
              placeholder="グループを検索"
              aria-label="グループを検索"
            />
          </div>
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th className="adm-th">グループ</th>
                  <th className="adm-th">管理者</th>
                  <th className="adm-th adm-th--num adm-th--run">人数</th>
                  <th className="adm-th adm-th--num adm-th--money">今月の金額 / 予算</th>
                  <th className="adm-th adm-th--act"></th>
                </tr>
              </thead>
              <tbody>
                {shownGroups.map((g) => {
                  const admin = users.find((u) => u.username === g.admin);
                  return (
                    <tr
                      key={g.name}
                      className={`adm-tr adm-tr--click${g.name === selected ? ' adm-tr--active' : ''}`}
                      onClick={() => setSelected(g.name)}
                    >
                      <td className="adm-td"><span className="adm-email">{g.name}</span></td>
                      <td className="adm-td adm-td--muted">
                        {g.admin ? (admin?.displayName || g.admin) : '（未設定）'}
                      </td>
                      <td className="adm-td adm-td--num">{g.memberCount}</td>
                      {/*
                        The whole group against the whole group's budget.
                        Members are each inside their own and the tenant can
                        still be past the figure the account is billed on, which
                        is the reason this number exists.
                      */}
                      <td className="adm-td adm-td--num" onClick={(e) => e.stopPropagation()}>
                        {g.monthlyLimit === null || g.monthlyLimit === undefined ? (
                          <span className="adm-uid" title="読み取れませんでした">—</span>
                        ) : (
                          /*
                            Stacked, because two amounts and an edit button on
                            one line do not fit a column in a split pane: the
                            cell clipped with an ellipsis, and what it clipped
                            was the budget — so the column read as one number
                            with a slash after it.

                            Inside the editor rather than beside it, because the
                            editor is the only thing that knows whether it is
                            open — and open, all three do not fit at all.
                          */
                          <BudgetEditor
                            value={g.monthlyLimit}
                            onSave={(limit) => onSetLimit(g.name, limit)}
                            disabled={!canSetGroupLimit}
                          >
                            <span className="adm-money-cell">
                              <span className="adm-money-figure">
                                {typeof g.cost === 'number' ? usd(g.cost) : '—'}
                              </span>
                              <span className="adm-money-of">
                                {g.monthlyLimit === UNLIMITED ? '予算 無制限' : `／ ${usd(asMoney(g.monthlyLimit))}`}
                              </span>
                            </span>
                          </BudgetEditor>
                        )}
                      </td>
                      <td className="adm-td adm-td--action">
                        <button
                          className="adm-btn adm-btn--danger-ghost adm-btn--sm"
                          type="button"
                          onClick={(e) => { e.stopPropagation(); remove(g); }}
                          disabled={busy !== null}
                        >
                          {busy === `del:${g.name}` ? '…' : '削除'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {shownGroups.length === 0 && (
                  <tr>
                    <td colSpan={5} className="adm-td adm-td--empty">
                      {groupSearch ? '該当するグループがありません' : 'グループがありません'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="adm-split__col">
          <div className="adm-split__head">
            {group ? `${group.name} の所属` : '所属'}
            {group && (
              <span className="adm-split__note">
                {members.length}人
              </span>
            )}
          </div>

          {!group ? (
            <div className="adm-empty">左でグループを選ぶと、所属の追加・解除と管理者の指名ができます</div>
          ) : (
            <>
              <div className="adm-subbar">
                {/*
                  The one pulldown, and the composer's own component rather than
                  a native <select>, so every menu in the product is the same
                  control. It is the right shape here: one administrator chosen
                  out of the members, which is a list that fits in a menu.
                */}
                <Dropdown
                  label="管理者"
                  value={group.admin ?? ''}
                  disabled={busy !== null}
                  options={[
                    { id: '', label: '（未設定）', description: 'このグループには管理者がいません' },
                    ...members.map((u) => ({
                      id: u.username,
                      label: u.displayName || u.username,
                      description: u.email,
                    })),
                  ]}
                  onChange={(id) => run('admin', () => onSetAdmin(group.name, id || null))}
                />
                <input
                  className="adm-input adm-input--sm"
                  type="search"
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                  placeholder="ユーザー名/メールアドレスで検索"
                  aria-label="ユーザー名/メールアドレスで検索"
                />
              </div>
              <div className="adm-table-wrap">
                <table className="adm-table">
                  <thead>
                    <tr>
                      <th className="adm-th">ユーザー</th>
                      {/*
                        `adm-th--model` is the 84px width for a column holding a
                        model name, and this one holds a group name — 「エンジニアリング」
                        was being clipped to fit a column sized for 「haiku」.
                      */}
                      <th className="adm-th adm-th--grp">所属グループ</th>
                      <th className="adm-th adm-th--num adm-th--money">今月の金額 / 予算</th>
                      <th className="adm-th adm-th--models">利用可能モデル</th>
                      <th className="adm-th adm-th--act2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownUsers.map((u) => {
                      const here = u.group === group.name;
                      const working = busy === `mem:${u.username}` || busy === `adm:${u.username}`;
                      /** Removing this person would leave the group unadministered. */
                      const stranding = here && u.isGroupAdmin && members.length > 1;
                      /*
                       * Joined by email, which is this pool's Cognito username
                       * as well — a usage row is keyed by `sub` and a directory
                       * row is not, and the address is the only field both hold.
                       */
                      const row = usage.find((x) => x.email && x.email === u.email);
                      return (
                        <tr key={u.username} className={`adm-tr${here ? ' adm-tr--active' : ''}`}>
                          <td className="adm-td">
                            <span className="adm-email">{u.displayName || u.username}</span>
                            <span className="adm-uid">{u.email}</span>
                          </td>
                          <td className="adm-td adm-td--muted">
                            {here
                              ? (u.isGroupAdmin ? '管理者' : '所属')
                              : u.group
                                ? u.group
                                : '—'}
                          </td>
                          {/*
                            What this member has spent against what they are
                            allowed. Same shape as the group's own cell one pane
                            over, because it is the same question one level down
                            — and dividing the group's budget among its people is
                            what that total exists for.
                          */}
                          <td className="adm-td adm-td--num">
                            {row ? (
                              <BudgetEditor
                                value={row.monthlyLimit}
                                onSave={(limit) => onSetUserLimit(row.userId, limit)}
                              >
                                <span className="adm-money-cell">
                                  <span className="adm-money-figure">
                                    {typeof row.cost === 'number' ? usd(row.cost) : '—'}
                                  </span>
                                  <span className="adm-money-of">
                                    {row.monthlyLimit === UNLIMITED ? '予算 無制限' : `／ ${usd(asMoney(row.monthlyLimit))}`}
                                  </span>
                                </span>
                              </BudgetEditor>
                            ) : (
                              <span className="adm-uid" title="使用量の記録が見つかりません">—</span>
                            )}
                          </td>
                          {/*
                            Which models this member may pick, set from the list
                            they are already being managed in. The same control
                            as the user tab's, over the same route, because a
                            second way of expressing the same setting is a second
                            thing to keep in step.
                          */}
                          <td className="adm-td">
                            {row ? (
                              <ModelPicker
                                models={row.allowedModels ?? ALL_MODELS}
                                onSave={(models) => onSetModels(row.userId, models)}
                              />
                            ) : (
                              <span className="adm-uid" title="使用量の記録が見つかりません">—</span>
                            )}
                          </td>
                          <td className="adm-td adm-td--action">
                            {/*
                              Straight to this person's projects.
                              Reaching them meant leaving the group, opening the
                              projects tab and typing the name into its search —
                              from a screen that already knows exactly who is
                              meant. Only when there is a usage row: the projects
                              tab is addressed by `sub`, which is what that row
                              carries and the directory entry does not.
                            */}
                            {row && (
                              <button
                                className="adm-btn adm-btn--secondary adm-btn--sm"
                                type="button"
                                onClick={() => onOpenProjects(row.userId)}
                                title={`${u.displayName || u.username} のプロジェクトを開く`}
                              >
                                プロジェクト
                              </button>
                            )}
                            {here ? (
                              <>
                                {/*
                                  Appointing from the member's own row, so the
                                  order stops mattering — the server adds the
                                  membership with the appointment.
                                */}
                                {!u.isGroupAdmin && (
                                  <button
                                    className="adm-btn adm-btn--secondary adm-btn--sm"
                                    type="button"
                                    disabled={busy !== null}
                                    onClick={() => run(`adm:${u.username}`, () => onSetAdmin(group.name, u.username))}
                                  >
                                    管理者にする
                                  </button>
                                )}
                                {/*
                                  The administrator cannot simply be taken out.
                                  Doing it left exactly what it says: a group
                                  with people in it and nobody able to open the
                                  panel for them, from a button that mentioned
                                  none of that. The group is handed over first —
                                  「管理者にする」 on any other member does it in
                                  one call and leaves this person a plain member.

                                  The last member is not blocked: an empty group
                                  has nothing to administer, and refusing there
                                  would be a dead end rather than a safeguard.
                                  The server refuses on the same rule; this is
                                  the half that says so before the click.
                                */}
                                <button
                                  className="adm-btn adm-btn--danger-ghost adm-btn--sm"
                                  type="button"
                                  disabled={busy !== null || stranding}
                                  title={stranding
                                    ? `${u.displayName || u.username} は「${group.name}」の管理者です。ほかの${members.length - 1}人が残るため、先に別のメンバーを管理者にしてください。`
                                    : undefined}
                                  onClick={() => run(`mem:${u.username}`, () => onSetMembership(u.username, null))}
                                >
                                  {working ? '…' : '外す'}
                                </button>
                              </>
                            ) : (
                              <button
                                className="adm-btn adm-btn--secondary adm-btn--sm"
                                type="button"
                                disabled={busy !== null}
                                onClick={() => run(`mem:${u.username}`, () => onSetMembership(u.username, group.name))}
                              >
                                {working ? '…' : u.group ? 'ここへ移す' : '追加'}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {shownUsers.length === 0 && (
                      <tr>
                        <td colSpan={5} className="adm-td adm-td--empty">
                          {userSearch ? '該当するユーザーがいません' : 'ユーザーがいません'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}


/** What a bar can measure. Three questions about the same months. */
const METRICS: { id: Metric; label: string }[] = [
  { id: 'cost', label: '金額' },
  { id: 'tokens', label: 'トークン数' },
  { id: 'requests', label: 'リクエスト数' },
];

/**
 * The period's months, stacked by model.
 *
 * Every bar is the month TOTAL and the models are its segments — not a stack
 * built from `byModel`, which would draw August 2026, a month with 165 requests
 * in it, as a month with nothing. The part no model claims is its own segment in
 * a neutral slot with a texture: it is not a model and must never be coloured as
 * one, and removing it would not remove the fact.
 *
 * Colours come from the categorical palette in `chartSeries.ts`, assigned to the
 * ENTITY rather than to its rank, so a period where Sonnet outspends Haiku does
 * not repaint them. Three of the four light-mode slots sit under 3:1 on this
 * surface, which obliges visible labels or a table view — the breakdown table is
 * directly below this chart, and every bar carries its total as a direct label.
 */
function TrendChart({
  series,
  tiers,
  metric,
}: {
  series: MonthSeries[];
  tiers: ModelTierInfo[];
  metric: Metric;
}) {
  /*
   * Which month the breakdown is showing.
   *
   * Null means "nobody has pointed at one yet", which resolves to the newest —
   * see `active`. Not a bare index, because the bars are rebuilt whenever the
   * metric or the period changes and an index would then point at a different
   * month than the one under the pointer.
   */
  const [hovered, setHovered] = useState<string | null>(null);

  const label = METRICS.find((x) => x.id === metric)?.label ?? '';
  const labelFor = (key: string) => {
    const t = tiers.find((x) => x.id === key);
    return t ? modelName(t.label, t.version) : key;
  };
  const order = useMemo(() => modelOrder(tiers, series), [tiers, series]);
  const bars = useMemo(
    () => chartBars(series, order, metric, labelFor),
    [series, order, metric, tiers]
  );
  const slot = (key: string) => (key === UNATTRIBUTED ? 'none' : String(order.indexOf(key) + 1));

  /*
   * 「約」 on an inferred figure, and only there.
   *
   * A month straddling the deploy that began recording the model prices its
   * uncounted requests at the counted ones' average — see `splitCoverage`. It is
   * the same number the budget is enforced on, so it is drawn, but a bar built
   * from three requests standing for eight must not read as a measurement.
   * Tokens and requests are counted, never inferred, so the mark is money only.
   */
  const shown = (v: number | null, estimated = false) =>
    v === null ? '—'
      : metric === 'cost' ? `${estimated ? '約 ' : ''}${usd(v)}`
      : formatNumber(v);

  if (series.length === 0) return <div className="adm-empty">この期間の記録がありません</div>;

  /** Which models appear anywhere in this period, for the legend. */
  const present = order.filter((k) => bars.some((b) => b.segments.some((s) => s.key === k)));
  const anyRest = bars.some((b) => b.segments.some((s) => s.unattributed));

  /*
   * The breakdown sits beside the chart rather than over it.
   *
   * As a tooltip it covered the bars it was describing — the thing the reader
   * was pointing at went behind the answer — and it existed only while a
   * pointer was held still, so the composition of a month was unreadable
   * without one. Beside the plot it is always on screen, it never occludes,
   * and it has room for the note about inferred figures that used to wrap.
   *
   * It defaults to the newest month, so the panel is never empty and never
   * appears from nowhere: pointing at a bar changes what it says, not whether
   * it is there. Nothing moves when the pointer enters the chart.
   */
  const active = bars.find((b) => b.month === hovered) ?? bars[bars.length - 1];

  return (
    <div className="adm-chart">
      <div className="adm-chart__body">
      <div
        className="adm-chart__plot"
        role="img"
        aria-label={`${label}の推移。${bars.map((b) => `${b.month} ${shown(b.total, b.estimated)}`).join('、')}`}
      >
        {bars.map((b) => (
          <div
            className={`adm-chart__col${active?.month === b.month ? ' adm-chart__col--active' : ''}`}
            key={b.month}
            onPointerEnter={() => setHovered(b.month)}
            onPointerLeave={() => setHovered((h) => (h === b.month ? null : h))}
            onFocus={() => setHovered(b.month)}
            onBlur={() => setHovered((h) => (h === b.month ? null : h))}
            tabIndex={0}
          >
            {/*
              The total above the bar, not only on hover. A chart whose values can
              only be read by hovering is a picture of a table.
            */}
            <span className="adm-chart__value">{shown(b.total, b.estimated)}</span>
            <div className="adm-chart__bar-wrap">
              <div
                className={`adm-chart__bar${b.total === null ? ' adm-chart__bar--unknown' : ''}`}
                style={{ height: `${b.percent}%` }}
              >
                {b.segments.map((s) => (
                  <span
                    key={s.key}
                    className={`adm-chart__seg adm-chart__seg--${slot(s.key)}`}
                    style={{ height: `${s.percent}%` }}
                  />
                ))}
              </div>
            </div>
            <span className="adm-chart__label">{b.month}</span>
          </div>
        ))}
      </div>

      {/*
        One panel per month listing every model, rather than one per segment:
        the question is what a month was made of, and a segment too thin to
        point at still has to be readable.

        `role="status"` so moving between bars with the keyboard reads the new
        month out — the panel is the only place the composition is stated, and
        a sighted reader gets it by pointing.
      */}
      {active && (
        <div className="adm-chart__break" role="status" aria-live="polite">
          <div className="adm-chart__break-head">
            {active.month}
            <span className="adm-chart__break-total">{shown(active.total, active.estimated)}</span>
          </div>
          {active.segments.length > 0 ? (
            active.segments.map((s) => (
              <div className="adm-chart__break-row" key={s.key}>
                <span className={`adm-chart__key adm-chart__key--${slot(s.key)}`} aria-hidden="true" />
                <span className="adm-chart__break-val">
                  {metric === 'cost' ? usd(s.value) : formatNumber(s.value)}
                </span>
                <span className="adm-chart__break-name">{s.label}</span>
              </div>
            ))
          ) : (
            <div className="adm-chart__break-note">この月の内訳はありません</div>
          )}
          {active.attributed.requests < active.requestCount && (
            <div className="adm-chart__break-note">
              モデルを記録したのは {formatNumber(active.attributed.requests)} / {formatNumber(active.requestCount)} リクエスト
              {metric === 'cost' && '。残りは記録分の平均で計上しています'}
            </div>
          )}
          {/* Said once, here, rather than left for the reader to discover. */}
          <div className="adm-chart__break-hint">棒にカーソルを合わせると、その月の内訳になります</div>
        </div>
      )}
      </div>

      {/* Identity is never colour alone: two or more series always carry a legend. */}
      {(present.length > 0 || anyRest) && (
        <div className="adm-chart__legend">
          {present.map((k) => (
            <span className="adm-chart__legend-item" key={k}>
              <span className={`adm-chart__key adm-chart__key--${slot(k)}`} aria-hidden="true" />
              {labelFor(k)}
            </span>
          ))}
          {anyRest && (
            <span className="adm-chart__legend-item" title="モデルの記録が始まる前の実行です">
              <span className="adm-chart__key adm-chart__key--none" aria-hidden="true" />
              {UNATTRIBUTED_LABEL}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * What each model costs, per million tokens.
 *
 * The four figures the 金額 column is computed from, read from the same table
 * the server prices with — `MODEL_PRICING` in Parameter Store. Without it that
 * column is a number whose derivation appears nowhere on screen.
 */
function PriceTable({ tiers, currency }: { tiers: ModelTierInfo[]; currency: string }) {
  const priced = tiers.filter((t) => t.prices);
  if (priced.length === 0) {
    return <div className="adm-empty">価格表が設定されていません</div>;
  }
  return (
    <div className="adm-table-wrap">
      <table className="adm-table" aria-label="モデルの価格表">
        <thead>
          <tr>
            <th className="adm-th">モデル</th>
            <th className="adm-th adm-th--num">入力</th>
            <th className="adm-th adm-th--num">出力</th>
            <th className="adm-th adm-th--num">キャッシュ読取</th>
            <th className="adm-th adm-th--num">キャッシュ書込</th>
          </tr>
        </thead>
        <tbody>
          {priced.map((t) => (
            <tr key={t.id} className="adm-tr">
              <td className="adm-td">
                <span className="adm-email">{modelName(t.label, t.version)}</span>
                {t.withdrawn && <span className="adm-badge adm-badge--warn">停止中</span>}
              </td>
              <td className="adm-td adm-td--num">{money(t.prices!.input)} {currency}</td>
              <td className="adm-td adm-td--num">{money(t.prices!.output)} {currency}</td>
              <td className="adm-td adm-td--num">{money(t.prices!.cacheRead)} {currency}</td>
              <td className="adm-td adm-td--num">{money(t.prices!.cacheWrite)} {currency}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * What the deployment runs, what it charges, and where the period's money went.
 *
 * Three blocks, in the order the questions are asked: what each model costs, how
 * the spend has moved month to month, and where this period's went.
 *
 * Its own period, separate from the usage tab's. The two tabs answer different
 * questions — 「誰が」 and 「何に」 — and somebody comparing three months of
 * models does not want the account table to have moved with them.
 */
function ModelsTab({
  inventory,
  period,
  onPeriodChange,
  loading,
  error,
}: {
  inventory: ModelInventory | null;
  period: Period;
  onPeriodChange: (p: Period) => void;
  loading: boolean;
  error: string | null;
}) {
  const [metric, setMetric] = useState<Metric>('cost');
  const span = period.from === period.to
    ? (period.from === THIS_MONTH.from ? '今月' : period.from)
    : `${period.from}〜${period.to}`;

  /*
   * The table is built from the series, not from the usage tab's rows.
   *
   * Each month of the series carries the same three fields a user row does, so
   * the existing join takes it unchanged — and this way the chart and the table
   * under it are two readings of one answer, over one period, from one request.
   */
  const rows = useMemo(
    () => (inventory ? modelRows(inventory.series, inventory.tiers) : []),
    [inventory]
  );
  const covered = useMemo(
    () => (inventory ? attribution(inventory.series) : { requests: 0, total: 0 }),
    [inventory]
  );
  const anyCost = rows.some((r) => r.priced && r.cost > 0);

  return (
    <div className="adm-tabpane adm-tabpane--scroll">
      <div className="adm-toolbar adm-toolbar--period">
        <PeriodPicker value={period} onChange={onPeriodChange} />
      </div>

      {loading && !inventory ? (
        <div className="adm-loading"><span className="adm-spinner" /><span>読み込み中…</span></div>
      ) : error ? (
        <div className="adm-error-banner" role="alert">{error}</div>
      ) : inventory ? (
        <>
          {/*
            The trend and the price table, side by side, with the trend on the
            left. They are read together — 「今月いくら使ったか」 and 「なぜその額
            なのか」 — and stacked they were a scroll apart. The trend takes the
            wider column because it carries the period; the price table is four
            short numeric columns and does not grow.
          */}
          <div className="adm-modelrow">
            <div className="adm-modeltotals">
              <div className="adm-modeltotals__head">
                {span}の推移
                <span className="adm-metrics motion-track" role="group" aria-label="表示する指標">
                  <SlidingIndicator active={metric} />
                  {METRICS.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className={`adm-metric${metric === m.id ? ' adm-metric--active' : ''}`}
                      aria-pressed={metric === m.id}
                      onClick={() => setMetric(m.id)}
                    >
                      {m.label}
                    </button>
                  ))}
                </span>
              </div>
              <TrendChart series={inventory.series} tiers={inventory.tiers} metric={metric} />
            </div>

            <div className="adm-modeltotals">
              <div className="adm-modeltotals__head">
                価格表
                <span className="adm-modeltotals__note">
                  100万トークンあたり
                  {/*
                    Reported or enforced is the whole question when an account is
                    over budget and still running: the flag is read in
                    `checkUsageLimit` and nowhere else.
                  */}
                  {inventory.pricing && (inventory.pricing.enforced ? ' ・ 上限に適用' : ' ・ 表示のみ')}
                </span>
              </div>
              <PriceTable tiers={inventory.tiers} currency={inventory.pricing?.currency ?? 'USD'} />
            </div>
          </div>

          <div className="adm-modeltotals adm-modeltotals--wide">
            <div className="adm-modeltotals__head">
              {span}のモデル別内訳
              {/*
                One note, not two: the head is a two-child flex row and a third
                child would push the caption off its own edge.

                The second half is what the removed 「内訳なし」 row used to say,
                said once. `tok_<model>_*` began part-way through the product's
                life, so a period can carry a complete total and almost no
                attribution — August is 0 of 165 requests. Without it the table
                adds up to a fraction of the period and looks complete.
              */}
              <span className="adm-modeltotals__note">
                {inventory.provider} ・ {inventory.region}
                {covered.total > covered.requests
                  && ` ・ モデル別に記録されているのは ${formatNumber(covered.requests)} / ${formatNumber(covered.total)} リクエスト`}
              </span>
            </div>
            <div className="adm-table-wrap">
              <table className="adm-table" aria-label="モデル別内訳">
                <thead>
                  <tr>
                    <th className="adm-th">モデル</th>
                    {/*
                      Named for the thing, not for the format. Every value here is
                      a full inference-profile ARN today, and the same field takes
                      a bare profile id — 「ARN」 would be a claim about the string.
                    */}
                    <th className="adm-th">推論プロファイル</th>
                    <th className="adm-th adm-th--num">トークン数</th>
                    <th className="adm-th adm-th--num">リクエスト数</th>
                    {anyCost && <th className="adm-th adm-th--num">金額</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="adm-tr">
                      <td className="adm-td">
                        <span className="adm-email">{r.name}</span>
                        {r.isDefault && <span className="adm-badge adm-badge--neutral">既定</span>}
                        {/*
                          A withdrawn tier keeps its row. Removing it would answer
                          「Opusはどうなっているのか」 with silence, which is the
                          question this tab exists for.
                        */}
                        {r.withdrawn && <span className="adm-badge adm-badge--warn">停止中</span>}
                      </td>
                      <td className="adm-td">
                        {r.profile
                          ? <span className="adm-modelid">{r.profile}</span>
                          : <span className="adm-uid" title="設定されたティアではありません">—</span>}
                      </td>
                      <td className="adm-td adm-td--num">{formatNumber(r.tokens)}</td>
                      <td className="adm-td adm-td--num">{formatNumber(r.requests)}</td>
                      {anyCost && (
                        <td className="adm-td adm-td--num">
                          {r.priced
                            ? usd(r.cost)
                            : <span className="adm-uid" title="金額の出ない実行が含まれています">—</span>}
                        </td>
                      )}
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr><td colSpan={anyCost ? 5 : 4} className="adm-td adm-td--empty">モデルの記録がありません</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

// --- Main AdminPanel ---
export function AdminPanel() {
  const { fetchModelInventory, users, loading, error, fetchUsers, setUserLimit, setUserAllowedModels, setGroupLimit, cognitoUsers, cognitoLoading, cognitoError, fetchCognitoUsers, createUser, renameUser, deleteUser, toggleUserEnabled, fetchProjects, fetchProjectVersions, fetchVersion, groups, fetchGroups, createGroup, deleteGroup, setMembership, setGroupAdmin } = useAdmin();
  const { membership } = useAuth();
  /*
   * What this administrator may change, decided once. Every control below reads
   * it rather than asking about roles itself — the server applies the same rule,
   * so a control drawn by mistake would be refused rather than obeyed, but a
   * control that is drawn and then refused is a worse experience than one that
   * was never offered.
   */
  const superAdmin = isSuperAdmin(membership);
  const [visible, setVisible] = useState(false);
  const [tab, setTab] = useState<'usage' | 'models' | 'users' | 'projects' | 'groups'>('usage');
  /*
   * An account the projects tab has been sent to, from the group member list.
   *
   * The token rises on every request so that asking for the SAME person twice
   * still opens them — a bare id would be equal to the one already showing and
   * the tab would sit there looking broken.
   */
  const [openProjectsOn, setOpenProjectsOn] = useState<{ userId: string; token: number } | null>(null);
  /*
   * The model inventory, held here rather than inside the tab.
   *
   * The chip beside the tab counts the models the tab lists, and the panel is
   * where every other chip's number already lives. Reporting it up from the pane
   * is the shape the projects badge had and was removed for: a child calling a
   * parent's setState on every render.
   *
   * Cheap enough to fetch with the panel: three SSM reads behind a five-minute
   * cache. The Parameter Store listing that made this expensive is gone.
   */
  const [inventory, setInventory] = useState<ModelInventory | null>(null);
  const [inventoryBusy, setInventoryBusy] = useState(false);
  /** Which request is the current one. See the effect below for why not a flag. */
  const inventoryRequestRef = useRef(0);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  /*
   * Every account's projects added up, for the tab's badge.
   *
   * The badge used to be whatever the pane happened to be showing — one
   * account's total, and nothing at all until somebody had been chosen. The
   * other three tabs count the whole account, so a number that meant "the
   * person I am currently reading" sat in the same row of chips meaning
   * something else entirely.
   *
   * Null when no row carries the field, which is a response from a server
   * older than the count. Zero would read as an account with no work in it.
   */
  /*
   * The model tab's own period. The usage tab answers 「誰が」 and this one
   * answers 「何に」, and moving one should not move the other.
   */
  const [modelPeriod, setModelPeriod] = useState<Period>(THIS_MONTH);
  const modelTable = useMemo(
    () => (inventory ? modelRows(inventory.series, inventory.tiers) : []),
    [inventory]
  );

  const totalProjects = useMemo(() => {
    const counted = users.filter((u) => typeof u.projectCount === 'number');
    return counted.length === 0 ? null : counted.reduce((n, u) => n + (u.projectCount ?? 0), 0);
  }, [users]);
  /*
   * The period the usage tab reports on, held here because the fetch is here.
   * Defaults to this month, which is what the server answers when asked for
   * nothing.
   */
  const [period, setPeriod] = useState<Period>(THIS_MONTH);
  const openProjectsFor = (userId: string) => {
    setOpenProjectsOn({ userId, token: Date.now() });
    setTab('projects');
  };

  /*
   * Keyed on the period as well as on opening, so changing it refetches — and
   * NOT on `users.length`, which was the guard against refetching on every
   * render and would now also stop a period change from ever loading a month
   * that happens to have the same number of rows.
   */
  useEffect(() => {
    if (visible) fetchUsers(period);
  }, [visible, period, fetchUsers]);

  /*
   * Once the panel opens, not once the tab does: the chip beside 「モデル」 is
   * drawn while another tab is showing, so the count has to exist before the tab
   * is ever chosen. Super-admin only, because the route is.
   *
   * A counter, not a `cancelled` flag closed over by the effect, and NOTHING the
   * effect sets appears in its own dependency list. The first version guarded on
   * `inventoryBusy` and listed it as a dependency, which deadlocks on every
   * open:
   *
   *   the effect runs and sets busy -> the dependency changed, so React tears
   *   the effect down (cancelled = true) and re-runs it -> the re-run returns at
   *   the `|| inventoryBusy` guard -> the first fetch resolves into handlers
   *   that are all `if (!cancelled)`, so busy is never cleared.
   *
   * The tab then shows its spinner for ever, which is exactly what it did.
   * A superseded request can no longer clear the flag for a newer one, and a
   * re-run — the token refreshing is the real case — simply supersedes.
   */
  useEffect(() => {
    if (!visible || !superAdmin) return;
    const id = ++inventoryRequestRef.current;
    const current = () => inventoryRequestRef.current === id;
    setInventoryBusy(true);
    setInventoryError(null);
    fetchModelInventory(modelPeriod)
      .then((d) => { if (current()) setInventory(d); })
      .catch((e) => { if (current()) setInventoryError((e as Error).message || '読み込みに失敗しました'); })
      .finally(() => { if (current()) setInventoryBusy(false); });
  }, [visible, superAdmin, modelPeriod, fetchModelInventory]);

  useEffect(() => {
    if (visible && (tab === 'users' || tab === 'groups') && cognitoUsers.length === 0) {
      fetchCognitoUsers();
    }
    if (visible && tab === 'groups') fetchGroups().catch(() => {});
  }, [visible, tab, cognitoUsers.length, fetchCognitoUsers, fetchGroups]);

  // Kept on screen while it slides away — see usePresence.
  const sheet = usePresence(visible);

  if (!sheet.mounted) {
    return (
      <button
        onClick={() => { setVisible(true); }}
        className="app__header-btn admin-panel__toggle"
        aria-label="管理画面を開く"
        title="Admin"
        type="button"
      >
        Admin
      </button>
    );
  }

  return (
    <>
      <div className="adm-overlay" onClick={() => setVisible(false)} aria-hidden="true" data-state={sheet.state} />
      <div className="adm-panel" role="region" aria-label="管理画面" data-state={sheet.state}>
        {/* Header */}
        <div className="adm-header">
          <div className="adm-header__left">
            <span className="adm-header__icon">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="1" y="1" width="6" height="6" rx="1" fill="currentColor" opacity="0.7"/>
                <rect x="9" y="1" width="6" height="6" rx="1" fill="currentColor" opacity="0.7"/>
                <rect x="1" y="9" width="6" height="6" rx="1" fill="currentColor" opacity="0.7"/>
                <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor"/>
              </svg>
            </span>
            <h2 className="adm-header__title">Admin Panel</h2>
            {/*
              A group administrator's panel shows their group and nothing else,
              and saying so is the difference between "there is one user" and
              "there is one user IN MY GROUP".
            */}
            {!superAdmin && membership.group && (
              <span className="adm-header__scope">{membership.group}</span>
            )}
          </div>
          <div className="adm-header__actions">
            <button
              /* Wrapped: `fetchUsers` takes a period now, and a bare handler
                 would hand it the click event as one. */
              onClick={() => (tab === 'users' ? fetchCognitoUsers() : fetchUsers(period))}
              disabled={tab === 'users' ? cognitoLoading : loading}
              className="adm-btn adm-btn--secondary adm-btn--sm"
              type="button"
            >
              {(tab === 'usage' ? loading : cognitoLoading) ? '更新中…' : '更新'}
            </button>
            <button onClick={() => setVisible(false)} className="adm-btn adm-btn--ghost adm-btn--icon" aria-label="閉じる" type="button">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="adm-tabs motion-track">
          <SlidingIndicator active={tab} selector=".adm-tab--active" />
          <button
            className={`adm-tab${tab === 'usage' ? ' adm-tab--active' : ''}`}
            onClick={() => setTab('usage')}
            type="button"
          >
            使用量
            {users.length > 0 && <span className="adm-tab-badge">{users.length}</span>}
          </button>
          {/*
            Beside 使用量 rather than inside it. The money on that tab is a
            consequence of what is on this one — which model each tier resolves
            to, what the price table says, whether it is enforced — and none of
            it was visible anywhere: answering 「今月なぜこの金額なのか」 meant an
            `aws ssm get-parameter` on a machine with credentials.

            Super-admin only, like the groups tab: it reports the account's own
            infrastructure, which is not a group administrator's business.
          */}
          {superAdmin && (
            <button
              className={`adm-tab${tab === 'models' ? ' adm-tab--active' : ''}`}
              onClick={() => setTab('models')}
              type="button"
            >
              モデル
              {modelTable.length > 0 && (
                <span className="adm-tab-badge">{modelCount(modelTable)}</span>
              )}
            </button>
          )}
          <button
            className={`adm-tab${tab === 'users' ? ' adm-tab--active' : ''}`}
            onClick={() => setTab('users')}
            type="button"
          >
            ユーザー管理
            {cognitoUsers.length > 0 && <span className="adm-tab-badge">{cognitoUsers.length}</span>}
          </button>
          <button
            className={`adm-tab${tab === 'projects' ? ' adm-tab--active' : ''}`}
            onClick={() => setTab('projects')}
            type="button"
          >
            プロジェクト
            {totalProjects !== null && <span className="adm-tab-badge">{totalProjects}</span>}
          </button>
          {superAdmin && (
            <button
              className={`adm-tab${tab === 'groups' ? ' adm-tab--active' : ''}`}
              onClick={() => setTab('groups')}
              type="button"
            >
              グループ
              {groups.length > 0 && <span className="adm-tab-badge">{groups.length}</span>}
            </button>
          )}
        </div>

        {/* Error banner */}
        {error && tab === 'usage' && <div className="adm-error-banner" role="alert">{error}</div>}
        {cognitoError && tab === 'users' && <div className="adm-error-banner" role="alert">{cognitoError}</div>}

        {/* Tab content */}
        <div className="adm-body motion-swap" key={tab}>
          {tab === 'usage' && (
            <UsageTab users={users} loading={loading} period={period} onPeriodChange={setPeriod} />
          )}
          {tab === 'models' && superAdmin && (
            <ModelsTab
              inventory={inventory}
              period={modelPeriod}
              onPeriodChange={setModelPeriod}
              loading={inventoryBusy}
              error={inventoryError}
            />
          )}
          {tab === 'groups' && superAdmin && (
            <GroupsTab
              groups={groups}
              users={cognitoUsers}
              onCreate={createGroup}
              onDelete={deleteGroup}
              onSetMembership={setMembership}
              onSetAdmin={setGroupAdmin}
              onSetLimit={setGroupLimit}
              onSetUserLimit={setUserLimit}
              canSetGroupLimit={superAdmin}
              usage={users}
              onSetModels={setUserAllowedModels}
              onOpenProjects={openProjectsFor}
              onRefresh={() => { fetchGroups().catch(() => {}); fetchCognitoUsers(); }}
            />
          )}
          {tab === 'projects' && (
            <ProjectsTab
              users={users}
              openOn={openProjectsOn}
              fetchProjects={fetchProjects}
              fetchProjectVersions={fetchProjectVersions}
              fetchVersion={fetchVersion}
            />
          )}
          {tab === 'users' && (
            <UsersTab
              cognitoUsers={cognitoUsers}
              cognitoLoading={cognitoLoading}
              usage={users}
              onRefresh={fetchCognitoUsers}
              onCreateUser={createUser}
              onDeleteUser={deleteUser}
              onToggleEnabled={toggleUserEnabled}
              onRename={renameUser}
              onSetLimit={setUserLimit}
              onSetModels={setUserAllowedModels}
              canManageAccounts={superAdmin}
              /*
               * A group administrator divides their own group's budget. The
               * server narrows it to their members either way — this only
               * decides whether the control is drawn.
               */
              canSetLimits={true}
            />
          )}
        </div>
      </div>
    </>
  );
}
