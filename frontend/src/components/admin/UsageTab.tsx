/**
 * The usage tab: what each account spent in a period, split by model, against its budget.
 */
import { useState, useMemo } from 'react';
import { type UserUsageSummary } from '../../hooks/useAdmin';
import { UNLIMITED, formatNumber, formatDate, downloadCSV, asMoney, usd, Period, THIS_MONTH } from './shared';
import { ByModel, PeriodPicker } from './editors';

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

export type SortKey = 'totalTokens' | 'requestCount' | 'lastUpdated' | 'displayName';

/**
 * How much each account has spent this month, and nothing else.
 *
 * The limits and the model list live on the user tab now. This one had eight
 * columns because it answered two questions at once — what an account spent, and
 * what it is allowed to — and they are asked at different times by a person
 * looking for different things. The budget stays editable beside the usage it
 * bounds, because that is the one moment the two questions meet.
 */
export function UsageTab({
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

