import { useState } from 'react';
import { usePresence } from '../hooks/usePresence';

interface UsageMenuProps {
  /**
   * The name this account is shown by — not the address it signs in with.
   *
   * The address used to be here. It is still what a user types to log in and it
   * is still what an administrator identifies an account by, but it is no
   * longer what the app calls anybody.
   */
  name: string;
  /**
   * The group this account belongs to, or null.
   *
   * Beside the name rather than inside the panel: which tenant somebody is in is
   * a thing they and anybody looking over their shoulder should be able to read
   * without opening anything.
   */
  group?: string | null;
  /**
   * This month's usage against this month's limits, or null while the ledger is
   * still being fetched.
   */
  limits: UsageLimits | null;
  /**
   * Why there are no figures, when that is the reason. Without it a failed
   * fetch reaches the panel as absent limits, which look exactly like limits
   * that have not arrived yet.
   */
  error?: string | null;
  /** Called each time the panel opens, so the host can refresh what it holds. */
  onOpen?: () => void;
}

export interface UsageLimits {
  /** The plain token count, not the weighted figure the budget is checked on. */
  tokensUsed: number;
  /** The budget, in millionths of a unit of currency. -1 means unlimited. */
  tokensLimit: number;
  requestsUsed: number;
  /**
   * The month's spend, or null when no price table is configured. Null rather
   * than 0, which would read as a free month.
   */
  cost: number | null;
  /** Whether `cost` is an estimate rather than a sum — drawn with a 「約」. */
  costEstimated?: boolean;
  /**
   * The group's combined budget, when the account is in a group.
   *
   * Shown to every member. A person inside their own budget can still be
   * refused because the tenant is past its total, and this is the only place
   * that says so.
   */
  groupBudget?: { limit: number; used: number; cost: number | null } | null;
}

/**
 * The budget as money.
 *
 * The server weighs each request by what it cost and stores the answer in
 * millionths of a unit of currency, so a limit of 10,000,000 IS ten dollars —
 * see backend/src/config/pricing.ts.
 */
const PER_UNIT_CURRENCY = 1_000_000;
const asMoney = (limit: number): number => limit / PER_UNIT_CURRENCY;
const money = (n: number): string => n.toFixed(2);
/**
 * Money with its unit attached, everywhere money is drawn.
 *
 * `$` alone is ambiguous — a dozen currencies use the sign — and the table
 * these figures come from carries a `currency` field precisely because the
 * amount and the unit are two facts. A budget somebody is held to should say
 * which money it is in.
 */
const usd = (n: number): string => `$${money(n)} USD`;

/** One figure and its label, for the things that are simply counts. */
function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="usage-menu__figure">
      <span>{label}</span>
      <span className="usage-menu__allowance-figure">{value}</span>
    </div>
  );
}

/**
 * Spend against budget, with the bar that makes the ratio readable at a glance.
 *
 * The only pair left. It was one of two — tokens against a token limit and
 * requests against a request limit — and neither is what anything is measured
 * against now: the request limit is gone, and the token limit is a budget, which
 * is money. The counts are still shown, as counts.
 */
function Allowance({ label, used, limit, approx = false }: { label: string; used: number | null; limit: number; approx?: boolean }) {
  const unlimited = limit === -1;
  const pct = unlimited || limit <= 0 || used === null ? 0 : Math.min((used / limit) * 100, 100);
  // 80% is where a limit stops being background information and starts being
  // something to act on before the next build is refused.
  const near = !unlimited && pct >= 80;
  const left = unlimited || used === null ? null : Math.max(limit - used, 0);
  return (
    <div className="usage-menu__allowance">
      {/*
        The label and the percentage, then the amount on its own line.
        These two numbers used to share one line at the size of a caption —
        「今月の金額 / 予算  $0.81 / $10.00」 — where the slash was doing all the
        work of separating them and the figure people actually open this to read
        was the same weight as its own label. The amount is now the largest thing
        in the block, the budget sits under it as the thing it is measured
        against, and what is LEFT is spelled out rather than left to be worked
        out from a bar.
      */}
      <div className="usage-menu__allowance-head">
        <span>{label}</span>
        {!unlimited && used !== null && (
          <span className="usage-menu__allowance-pct">{Math.round(pct)}%</span>
        )}
      </div>
      <p className="usage-menu__allowance-amount">
        <span className={`usage-menu__allowance-spent${near ? ' usage-menu__allowance-spent--near' : ''}`}>
          {used === null ? '—' : `${approx ? '約 ' : ''}${usd(used)}`}
        </span>
        <span className="usage-menu__allowance-of">
          {unlimited ? '予算 無制限' : `／ 予算 ${usd(limit)}`}
        </span>
      </p>
      {!unlimited && (
        <div
          className="usage-menu__allowance-bar"
          role="progressbar"
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${label}の使用率`}
        >
          <div
            className={`usage-menu__allowance-fill${near ? ' usage-menu__allowance-fill--near' : ''}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {left !== null && (
        <p className="usage-menu__allowance-rest">残り {usd(left)}</p>
      )}
    </div>
  );
}

/**
 * This month's allowance, behind the address.
 *
 * The address is the button, because that is where someone looks for "my
 * account". It exists on both the project list and the workspace, and the two
 * are the same component rather than the same design twice — the numbers are
 * the thing a user compares between screens, and two copies of this markup
 * would eventually disagree about what they mean.
 *
 * It used to show a lifetime total as well — tokens, requests and projects
 * summed from the project records — with the allowance below it under a rule.
 * Two figures for one word is a question the panel was answering twice, so the
 * cumulative half is gone and what remains is the one people open this to
 * check: how much of this month is left.
 */
export function UsageMenu({ name, group = null, limits, error = null, onOpen }: UsageMenuProps) {
  const [open, setOpen] = useState(false);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) onOpen?.();
  };

  const panel = usePresence(open);

  return (
    <div className="usage-menu">
      <button
        className={`usage-menu__email${open ? ' usage-menu__email--on' : ''}`}
        onClick={toggle}
        aria-expanded={open}
        type="button"
        title="今月の上限を表示"
      >
        {/*
          A placeholder rather than a guess while the name is unknown.
          The address's local part used to stand in from the first frame and be
          replaced the moment `/usage` answered, which flashed a different name
          on every load for anyone whose stored name is not their address. An
          empty string here would also collapse the button, so the space is
          held.
        */}
        {name || <span className="usage-menu__name-wait" aria-label="読み込み中" />}
        {group && <span className="usage-menu__group">{group}</span>}
      </button>
      {panel.mounted && (
        <>
          {/* Click-away, so the panel does not need a close button. */}
          <div className="usage-menu__scrim" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="usage-menu__panel" role="dialog" aria-label="今月の上限" data-state={panel.state}>
            <p className="usage-menu__who">
              {name || <span className="usage-menu__name-wait" aria-label="読み込み中" />}
              {group && <span className="usage-menu__group">{group}</span>}
            </p>
            {error ? (
              <p className="usage-menu__error" role="alert">使用状況を取得できませんでした。</p>
            ) : limits === null ? (
              <p className="usage-menu__loading" aria-live="polite">読み込み中...</p>
            ) : (
              <>
                <p className="usage-menu__limits-title">今月の使用状況</p>
                <Figure label="トークン数" value={limits.tokensUsed.toLocaleString()} />
                <Figure label="リクエスト数" value={limits.requestsUsed.toLocaleString()} />
                {/*
                  The money and the budget together, because neither answers
                  anything alone. Absent when no price table is configured: a
                  「$0.00 / 無制限」 row would be two numbers that mean nothing.
                */}
                {(limits.cost !== null || limits.tokensLimit !== -1) && (
                  <Allowance
                    label="あなたの利用金額"
                    used={limits.cost}
                    limit={asMoney(limits.tokensLimit)}
                    approx={limits.costEstimated === true}
                  />
                )}
                {/*
                  Both blocks were headed 「今月の金額 / 予算」, so two identical
                  captions sat one above the other and the only thing telling
                  them apart was a title above the second. They now say whose
                  money each one is.
                */}
                {limits.groupBudget && group && (
                  <>
                    <p className="usage-menu__limits-title">グループ「{group}」全体</p>
                    <Allowance
                      label="グループ合計の利用金額"
                      used={limits.groupBudget.cost}
                      limit={asMoney(limits.groupBudget.limit)}
                    />
                  </>
                )}
                <p className="usage-menu__note">使用量と予算は月ごとにリセットされます。</p>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
