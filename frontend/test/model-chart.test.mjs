/**
 * The three blocks above the model breakdown, and the one row that went.
 *
 *   the price table — the four figures the 金額 column is computed from, from the
 *     same `MODEL_PRICING` the server prices with. Without it that column is a
 *     number whose derivation appears nowhere on screen.
 *   the trend — one bar per month of the period.
 *   the period — the tab's own, separate from the usage tab's.
 *
 * And 「内訳なし」 is gone from the whole panel on the operator's instruction.
 * What it named has not gone: `tok_<model>_*` began part-way through the
 * product's life, so a period can carry a complete total and almost no
 * attribution — measured against the live table on 2026-09-10, August is 0 of
 * 165 requests and September 3 of 8. The coverage is now said once in the
 * caption, because a table that adds up to a fraction of the month and looks
 * complete is the one failure a breakdown must not have.
 *
 *   node test/model-chart.test.mjs      (from frontend/)
 */
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const panel = fs.readFileSync(path.join(root, 'src/components/AdminPanel.tsx'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/index.css'), 'utf8');
const hook = fs.readFileSync(path.join(root, 'src/hooks/useAdmin.ts'), 'utf8');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const rule = (sel) => {
  const out = [];
  const needle = `\n${sel} {`;
  for (let i = css.indexOf(needle); i !== -1; i = css.indexOf(needle, i + 1)) {
    out.push(css.slice(i + needle.length, css.indexOf('}', i)));
  }
  return out.join('\n');
};

const chart = panel.slice(panel.indexOf('function TrendChart('), panel.indexOf('function PriceTable('));
const prices = panel.slice(panel.indexOf('function PriceTable('), panel.indexOf('function ModelsTab('));
const tab = panel.slice(panel.indexOf('function ModelsTab('), panel.indexOf('// --- Main AdminPanel ---'));

// --- 内訳なし, everywhere ------------------------------------------------------
const markup = panel.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('no 内訳なし is drawn anywhere in the panel', /内訳なし/.test(markup), false);
// The per-cell version on the usage tab took a `rest` prop; it has no reason to
// exist now and leaving it would be a prop nothing supplies.
check('the per-cell breakdown no longer takes a remainder', /rest: number/.test(panel), false);
check('nor computes one', /restTokens|restRequests/.test(panel), false);
// What replaced it, once, where the table is.
check('the coverage is stated in the caption',
  /モデル別に記録されているのは/.test(markup), true);
// Only when there is something to say: a fully recorded period draws no note.
check('and only when the split is incomplete',
  /covered\.total > covered\.requests[\s\S]{0,20}&& `/.test(tab), true);

// --- the period ---------------------------------------------------------------
check('the tab has its own picker', /<PeriodPicker value=\{period\} onChange=\{onPeriodChange\} \/>/.test(tab), true);
// Separate from the usage tab's: the two answer 「誰が」 and 「何に」, and moving
// one should not move the other.
check('held apart from the usage tab', /const \[modelPeriod, setModelPeriod\] = useState<Period>\(THIS_MONTH\)/.test(panel), true);
check('and the fetch carries it', /fetchModelInventory\(modelPeriod\)/.test(panel), true);
check('a change refetches', /\}, \[visible, superAdmin, modelPeriod, fetchModelInventory\]\)/.test(panel), true);
check('the request sends it as a query', /\?from=\$\{period\.from\}&to=\$\{period\.to\}/.test(hook), true);

// --- the price table ----------------------------------------------------------
check('all four rates have a column',
  ['>入力<', '>出力<', '>キャッシュ読取<', '>キャッシュ書込<'].filter((h) => !prices.includes(h)), []);
check('a tier the table does not price is not a row of zeros',
  /tiers\.filter\(\(t\) => t\.prices\)/.test(prices), true);
check('and no price table at all says so rather than drawing an empty one',
  /価格表が設定されていません/.test(prices), true);
check('the unit is stated once, in the caption', /100万トークンあたり/.test(tab), true);
// Reported or enforced is the whole question when an account is over budget and
// still running.
check('with whether the prices gate anything',
  /enforced \? ' ・ 上限に適用' : ' ・ 表示のみ'/.test(tab), true);

// --- the chart -----------------------------------------------------------------
/*
 * What a bar is made of is asserted in chart-series.test.mjs, against the
 * function that builds the segments. What is left here is the switch above it.
 */
// Declared above the chart, so read from the file rather than the slice.
check('three metrics, one at a time',
  ['金額', 'トークン数', 'リクエスト数'].filter((m) => !panel.includes(`label: '${m}'`)), []);
check('and nothing else', (panel.match(/id: '(tokens|requests|cost)', label:/g) ?? []).length, 3);
check('money is the one it opens on', /useState<Metric>\('cost'\)/.test(tab), true);
check('the switch says which is chosen', /aria-pressed=\{metric === m\.id\}/.test(tab), true);
check('and is beside the trend, not the table', tab.indexOf('adm-metrics') < tab.indexOf('価格表'), true);
// A chart whose values can only be read by hovering is a picture of a table.
check('every bar carries its total', /adm-chart__value/.test(chart), true);
check('and its month', /adm-chart__label/.test(chart), true);
// Screen readers get the values, not just "a chart".
check('the whole series is in the label', /aria-label=\{`\$\{label\}の推移。/.test(chart), true);

// --- an inferred figure says so ----------------------------------------------
/*
 * A month straddling the deploy that began recording the model prices its
 * uncounted requests at the counted ones' average. It is the same number the
 * budget is enforced on, so it is drawn — but a bar built from three requests
 * standing for eight must not read as a measurement.
 */
check('inferred money is marked', /estimated \? '約 ' : ''/.test(chart), true);
check('and the breakdown says what it was inferred from',
  /残りは記録分の平均で計上しています/.test(chart), true);
// Tokens and requests are counted, never inferred.
check('only money carries the mark', /metric === 'cost' \? `\$\{estimated/.test(chart), true);
check('the server sends the flag', /estimated: boolean;/.test(hook), true);

// --- layout -------------------------------------------------------------------
check('the bars share a floor', /align-items:\s*flex-end/.test(rule('.adm-chart__plot')), true);
check('a column takes an equal share of the width', /flex:\s*1 1 0/.test(rule('.adm-chart__col')), true);

// --- the breakdown is beside the chart, not over it ---------------------------
/*
 * It was a tooltip, absolutely positioned over the plot. Two things were wrong
 * with that and neither is a detail: it covered the bars it was describing — the
 * mark the reader was pointing at went behind the answer — and it existed only
 * while a pointer was held still, so what a month was made of could not be read
 * without a mouse.
 */
check('the plot and the breakdown share a row',
  /grid-template-columns:\s*minmax\(0, 1fr\) \d+px/.test(rule('.adm-chart__body')), true);
check('the breakdown is not positioned over anything',
  /position:\s*absolute/.test(rule('.adm-chart__break')), false);
check('and the bar no longer anchors one',
  /position:\s*relative/.test(rule('.adm-chart__bar-wrap')), false);
check('the old tooltip rules are gone', rule('.adm-chart__tip').length, 0);
/*
 * It defaults to the newest month. A panel that appears when the pointer enters
 * the chart is a panel that moves the chart, and the composition of a month
 * should be readable before anyone points at anything.
 */
check('it shows the newest month when nothing is hovered',
  /bars\.find\(\(b\) => b\.month === hovered\) \?\? bars\[bars\.length - 1\]/.test(chart), true);
check('and the plot says which column it is describing',
  /adm-chart__col--active/.test(chart) && rule('.adm-chart__col--active').length > 0, true);
// Moving between bars with the keyboard has to read the new month out: the panel
// is the only place the composition is stated.
check('the breakdown announces itself', /role="status" aria-live="polite"/.test(chart), true);
check('every column is reachable from the keyboard', /tabIndex=\{0\}/.test(chart), true);
check('the metric switch has a style', rule('.adm-metric').length > 0, true);
check('and marks the active one', rule('.adm-metric--active').length > 0, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
