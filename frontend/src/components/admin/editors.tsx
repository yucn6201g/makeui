/**
 * The inline editors the admin tabs use: budget, permitted models, display name,
 * the per-model split of a figure, and the period picker.
 */
import { useState } from 'react';
import { type UserUsageSummary, type CognitoUser, type ModelId } from '../../hooks/useAdmin';
import { UNLIMITED, ALL_MODELS, MODEL_OPTIONS, asMoney, asLimit, usd, Period, monthKey } from './shared';

/**
 * The month's budget, editable where it is read.
 *
 * A dollar figure rather than a token count. The number stored is the same; what
 * changed is that it is now readable — 「10,000,000」 answered no question anybody
 * was asking, and 「$10.00」 is the question they were asking.
 */
export function BudgetEditor({
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
export function ModelPicker({
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
export function NameEditor({
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

/** One entry of a month's per-model split, as the row carries it. */
export type ModelSplit = NonNullable<UserUsageSummary['byModel']>[number];

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
export function ByModel({
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
export function PeriodPicker({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
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

