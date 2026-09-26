import { useState, useMemo } from 'react';
import { type ModelInventory, type ModelTierInfo, type MonthSeries } from '../../hooks/useAdmin';
import { modelRows, modelName, attribution } from '../../utils/admin/modelRows';
import { chartBars, modelOrder, UNATTRIBUTED, UNATTRIBUTED_LABEL, type Metric } from '../../utils/admin/chartSeries';
import { SlidingIndicator } from '../common/SlidingIndicator';
import { formatNumber, money, usd, Period, THIS_MONTH } from './shared';
import { PeriodPicker } from './editors';

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
export function ModelsTab({
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

