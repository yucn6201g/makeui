/**
 * A month's bar, split into the models that made it up.
 *
 * The bars were plain totals. They are stacked now, and the split cannot simply
 * be `byModel`: `tok_<model>_*` began part-way through the product's life, so a
 * month can carry a complete total and no attribution at all — measured against
 * the live table on 2026-09-10, August is 0 of 165 requests. A stack built from
 * `byModel` alone would draw that month, 165 requests, as a month with nothing.
 *
 * So every bar is the TOTAL and the part no model claims is its own segment. It
 * is not a model and never takes a hue: neutral, textured, the way an untagged
 * bucket appears in a cost explorer.
 *
 *   node test/chart-series.test.mjs      (from frontend/)
 */
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/utils/chartSeries.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'node_modules/.cache/cs.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const { chartBars, modelOrder, UNATTRIBUTED, UNATTRIBUTED_LABEL } = await import(
  pathToFileURL(path.join(root, 'node_modules/.cache/cs.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const bm = (model, inp, out, req, cost) =>
  ({ model, inputTokens: inp, outputTokens: out, cacheReadTokens: 0, cacheWriteTokens: 0, requestCount: req, cost });
const month = (m, tokens, requests, cost, byModel = [], estimated = false) => ({
  month: m, totalTokens: tokens, requestCount: requests, cost, byModel, estimated,
  attributed: {
    tokens: byModel.reduce((a, b) => a + b.inputTokens + b.outputTokens, 0),
    requests: byModel.reduce((a, b) => a + b.requestCount, 0),
  },
});
const TIERS = [{ id: 'haiku' }, { id: 'sonnet' }, { id: 'opus' }];
const label = (k) => k;

// --- colour follows the entity, not its rank --------------------------------
/*
 * A period where Sonnet outspends Haiku must not repaint them, and adding a
 * month to the range must not recolour what is already on screen. So the order
 * is the configured ladder first, then anything else as it first appears.
 */
check('the configured tiers come first, in their ladder order',
  modelOrder(TIERS, []), ['haiku', 'sonnet', 'opus']);
check('and an unconfigured model is appended, not inserted',
  modelOrder(TIERS, [month('2026-09', 10, 1, 1, [bm('direct-edit', 5, 5, 1, 1)])]),
  ['haiku', 'sonnet', 'opus', 'direct-edit']);
check('a model that is also a tier is not repeated',
  modelOrder(TIERS, [month('2026-09', 10, 1, 1, [bm('haiku', 5, 5, 1, 1)])]),
  ['haiku', 'sonnet', 'opus']);
// Two months, two new models: the first one seen keeps the earlier slot however
// heavily the second one spends.
check('order is first-appearance, not size', modelOrder(TIERS, [
  month('2026-08', 10, 1, 1, [bm('plan', 5, 5, 1, 1)]),
  month('2026-09', 999, 9, 9, [bm('direct-edit', 500, 499, 9, 9)]),
]), ['haiku', 'sonnet', 'opus', 'plan', 'direct-edit']);

// --- the bar is the total, and the rest is its own segment ------------------
const order = ['haiku', 'sonnet', 'opus'];
// August, as it is: a complete total and nothing attributed.
const aug = chartBars([month('2026-08', 17616592, 165, 62.4)], order, 'tokens', label)[0];
check('a month with no attribution still has a bar', aug.percent, 100);
check('made of one segment', aug.segments.length, 1);
check('which is the unattributed one', aug.segments[0].key, UNATTRIBUTED);
check('named rather than blank', aug.segments[0].label, UNATTRIBUTED_LABEL);
check('carrying the whole total', aug.segments[0].value, 17616592);
check('and marked as not a model', aug.segments[0].unattributed, true);

// September: three requests recorded of eight.
const sep = chartBars([
  month('2026-09', 1837269, 8, 7.62, [bm('haiku', 167578, 180868, 2, 1.07), bm('sonnet', 79138, 103102, 1, 1.78)], true),
], order, 'tokens', label)[0];
check('a partly attributed month splits into its models plus the rest',
  sep.segments.map((s) => s.key), ['haiku', 'sonnet', UNATTRIBUTED]);
check('the models carry what they recorded',
  sep.segments.find((s) => s.key === 'haiku').value, 348446);
check('and the remainder is the difference',
  sep.segments.find((s) => s.key === UNATTRIBUTED).value, 1837269 - 348446 - 182240);
check('the segments fill the bar exactly',
  Math.round(sep.segments.reduce((a, s) => a + s.percent, 0)), 100);
// The segments are in ladder order regardless of size, bottom up.
check('and are in the fixed order', sep.segments.map((s) => s.key).slice(0, 2), ['haiku', 'sonnet']);

// --- nothing left over --------------------------------------------------------
const whole = chartBars([
  month('2026-09', 400, 4, 2, [bm('haiku', 100, 100, 2, 1), bm('sonnet', 100, 100, 2, 1)]),
], order, 'tokens', label)[0];
check('a fully attributed month has no remainder segment',
  whole.segments.some((s) => s.unattributed), false);
check('and still fills its bar', Math.round(whole.segments.reduce((a, s) => a + s.percent, 0)), 100);

// --- the three metrics ---------------------------------------------------------
const series = [month('2026-09', 400, 4, 3, [bm('haiku', 100, 100, 1, 1), bm('sonnet', 50, 50, 1, 1)])];
check('tokens are input plus output',
  chartBars(series, order, 'tokens', label)[0].segments.find((s) => s.key === 'haiku').value, 200);
check('requests are requests',
  chartBars(series, order, 'requests', label)[0].segments.find((s) => s.key === 'haiku').value, 1);
check('money is money',
  chartBars(series, order, 'cost', label)[0].segments.find((s) => s.key === 'haiku').value, 1);
/*
 * And the money remainder is the inference the product already makes.
 *
 * The month's `cost` is the recorded requests' cost scaled to cover the ones
 * that recorded no model — `splitCoverage`, which gates every budget. The
 * segment is the difference rather than a second inference, so the bar adds up
 * to the number the limit is enforced on.
 */
check('the money remainder is what the scaling added',
  chartBars(series, order, 'cost', label)[0].segments.find((s) => s.key === UNATTRIBUTED).value, 1);

// --- the cases that must not throw --------------------------------------------
const zero = chartBars([month('2026-07', 0, 0, 0)], order, 'tokens', label)[0];
check('an empty month has no segments', zero.segments, []);
check('and no height', zero.percent, 0);
// A flat run of zeros must not divide by zero.
check('a period of nothing but zeros is drawn flat',
  chartBars([month('2026-07', 0, 0, 0), month('2026-08', 0, 0, 0)], order, 'tokens', label)
    .map((b) => b.percent), [0, 0]);
// A month the price table does not cover is not a month that cost nothing.
const unpriced = chartBars([month('2026-08', 100, 1, null)], order, 'cost', label)[0];
check('an unpriced month has no total', unpriced.total, null);
check('no segments', unpriced.segments, []);
check('and no height rather than a floor-height bar', unpriced.percent, 0);
// An unpriced MODEL contributes no segment; its share lands in the remainder,
// which is where an unpriced request's money is anyway.
const partly = chartBars([
  month('2026-09', 300, 3, 3, [bm('haiku', 50, 50, 1, 2), bm('direct-edit', 50, 50, 1, null)]),
], ['haiku', 'direct-edit'], 'cost', label)[0];
check('an unpriced model is not a zero-height segment',
  partly.segments.map((s) => s.key), ['haiku', UNATTRIBUTED]);

// --- heights are relative to the tallest month --------------------------------
const two = chartBars([month('2026-08', 1000, 10, 10), month('2026-09', 250, 3, 3)], order, 'tokens', label);
check('the tallest month is the full height', two[0].percent, 100);
check('and the others are its share', two[1].percent, 25);

// --- and it is what the chart draws -------------------------------------------
const panel = fs.readFileSync(path.join(root, 'src/components/AdminPanel.tsx'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/index.css'), 'utf8');
const chart = panel.slice(panel.indexOf('function TrendChart('), panel.indexOf('function PriceTable('));
check('the chart uses this function', /chartBars\(series, order, metric, labelFor\)/.test(chart), true);
check('and this order', /modelOrder\(tiers, series\)/.test(chart), true);
// Fixed slots, never cycled: the index in the order IS the colour.
check('the colour is the slot in that order',
  /order\.indexOf\(key\) \+ 1/.test(chart), true);
check('and the unattributed segment takes none of them',
  /key === UNATTRIBUTED \? 'none'/.test(chart), true);

// The palette, validated with the skill's script against this surface: worst
// adjacent CVD ΔE 9.1, normal-vision 22.9, all four inside the lightness band.
check('four categorical slots have a colour',
  ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'].filter((c) => !css.includes(c)), []);
// Not a hue, and not a solid: an untagged bucket must not read as a series.
check('the neutral is a texture', /adm-chart__seg--none[\s\S]{0,120}repeating-linear-gradient/.test(css), true);
// A 2px gap in the surface colour, never a border: the gap is what makes
// neighbouring hues read as separate marks.
check('the segments are separated by a gap', /gap:\s*2px/.test(css.slice(css.indexOf('\n.adm-chart__bar {'))), true);
check('and not by a stroke', /\.adm-chart__seg \{[^}]*border:/.test(css), false);

// Identity is never colour alone.
check('a legend is drawn', /adm-chart__legend/.test(chart), true);
check('naming the unattributed slot too', /UNATTRIBUTED_LABEL/.test(chart), true);
// One panel per month listing every model — a segment too thin to point at
// still has to be readable, and the hit target is the whole column.
check('the column carries the hover, not the segment', /onPointerEnter=\{\(\) => setHovered\(b\.month\)\}/.test(chart), true);
check('and the keyboard too', /onFocus=\{\(\) => setHovered\(b\.month\)\}/.test(chart), true);
check('the breakdown lists every segment', /active\.segments\.map\(\(s\) => \(/.test(chart), true);
check('and says how much of the month was recorded',
  /モデルを記録したのは \{formatNumber\(active\.attributed\.requests\)\}/.test(chart), true);
// It reads the same month the plot is highlighting, not whichever bar the loop
// happens to be on — the two used to be the same variable and are no longer.
check('the breakdown and the highlight are the same month',
  /active\?\.month === b\.month/.test(chart), true);

// --- side by side, trend first -------------------------------------------------
const tab = panel.slice(panel.indexOf('function ModelsTab('), panel.indexOf('// --- Main AdminPanel ---'));
check('the two blocks share a row', /<div className="adm-modelrow">/.test(tab), true);
check('with the trend before the price table',
  tab.indexOf('の推移') < tab.indexOf('価格表'), true);
check('and the trend gets the wider column',
  /grid-template-columns:\s*minmax\(0, 3fr\) minmax\(0, 2fr\)/.test(css), true);
// Two half-width tables of numbers are worse than one full-width one.
check('they stack when there is no room', /@media \(max-width: 1100px\)/.test(css), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
