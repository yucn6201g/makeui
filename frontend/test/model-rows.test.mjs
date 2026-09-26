/**
 * One row per model: what it is, and what it spent.
 *
 * The model tab carried two tables — the period's usage split by model, and the
 * tiers this deployment is configured to run — stacked and keyed on the same
 * thing, so reading them meant matching a name in one against a name in the
 * other by eye. They are one table now, joined on the tier name, which is what
 * both sides already use: usage is recorded as `tok_haiku_in` and the
 * configuration is keyed `haiku`. That is a fact about the store — verified
 * against the live table, whose only per-model attributes are `tok_haiku_*` and
 * `tok_sonnet_*` — not a convention introduced here.
 *
 * Three kinds of row come out and two of them are the reason this is a function:
 * a configured tier that never ran is a row of zeros rather than an absence, and
 * a model that ran without being a configured tier still has to appear or the
 * column totals stop agreeing with the usage tab.
 *
 *   node test/model-rows.test.mjs      (from frontend/)
 */
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN_FILES, readAdminPanel, adminSection } from './lib/admin-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/utils/admin/modelRows.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'node_modules/.cache/mr.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const { modelRows, modelCount, modelName, attribution } = await import(
  pathToFileURL(path.join(root, 'node_modules/.cache/mr.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const ARN = (id) => `arn:aws:bedrock:ap-northeast-1:123456789012:inference-profile/${id}`;
const TIERS = [
  { id: 'haiku', label: 'Haiku', profile: ARN('jp.anthropic.claude-haiku-4-5-20251001-v1:0'), version: '4.5', withdrawn: false, isDefault: false },
  { id: 'sonnet', label: 'Sonnet', profile: ARN('jp.anthropic.claude-sonnet-4-6'), version: '4.6', withdrawn: false, isDefault: true },
  { id: 'opus', label: 'Opus', profile: ARN('jp.anthropic.claude-opus-4-8'), version: '4.8', withdrawn: true, isDefault: false },
];
const m = (model, inp, out, req, cost) => ({ model, inputTokens: inp, outputTokens: out, requestCount: req, cost });

// --- the name is the model AND its version ---------------------------------
// 「Haiku」 alone does not say which Haiku, and the version is the half that
// changes under the same name.
check('a model is named with its version', modelName('Haiku', '4.5'), 'Haiku 4.5');
check('and without one when none is known', modelName('Haiku', null), 'Haiku');

// --- the ordinary case ------------------------------------------------------
const rows = modelRows([
  { totalTokens: 600, requestCount: 6, byModel: [m('haiku', 100, 100, 2, 1.5), m('sonnet', 200, 200, 4, 8)] },
], TIERS);
check('one row per configured tier, in ladder order', rows.map((r) => r.id), ['haiku', 'sonnet', 'opus']);
check('named with their versions', rows.map((r) => r.name), ['Haiku 4.5', 'Sonnet 4.6', 'Opus 4.8']);
check('carrying the profile Bedrock is called with',
  rows[1].profile, ARN('jp.anthropic.claude-sonnet-4-6'));
check('and the usage joined on the tier name', [rows[0].tokens, rows[0].requests, rows[0].cost], [200, 2, 1.5]);
check('the default tier is marked', rows.filter((r) => r.isDefault).map((r) => r.id), ['sonnet']);
check('and a withdrawn one', rows.filter((r) => r.withdrawn).map((r) => r.id), ['opus']);

// A tier that has not run is a row of zeros, not an absence: 「使われていない」
// and 「設定されていない」 are different answers and the table must say the first.
check('a tier with no usage still has a row', rows[2].id, 'opus');
check('showing zero rather than nothing', [rows[2].tokens, rows[2].requests], [0, 0]);
// And it is priced, because there is nothing unpriced in it — otherwise every
// unused model would draw 「—」 in the money column.
check('an unused tier does not read as unpriced', rows[2].priced, true);

// --- a model that ran without being a configured tier ----------------------
// `direct-edit` is one. Dropping it would make this table's totals disagree with
// the usage tab's.
const withExtra = modelRows([
  { totalTokens: 800, requestCount: 8, byModel: [m('haiku', 100, 100, 2, 1), m('direct-edit', 200, 400, 6, null)] },
], TIERS);
check('an unconfigured model gets a row', withExtra.map((r) => r.id).includes('direct-edit'), true);
check('after the configured tiers', withExtra.map((r) => r.id),
  ['haiku', 'sonnet', 'opus', 'direct-edit']);
check('with no profile, because it is not a tier', withExtra.find((r) => r.id === 'direct-edit').profile, '');
check('but its spend intact', withExtra.find((r) => r.id === 'direct-edit').tokens, 600);
// An unpriced request poisons its own row only — the rule modelTotals sets.
check('and its money withheld rather than partial',
  withExtra.find((r) => r.id === 'direct-edit').priced, false);
check('while the tier beside it stays priced', withExtra.find((r) => r.id === 'haiku').priced, true);

// Several extras sort heaviest first: the question is where the spend went.
const twoExtras = modelRows([
  // Totals that match the split exactly, so no remainder row joins the tail.
  { totalTokens: 700, requestCount: 5, byModel: [m('direct-edit', 50, 50, 1, 1), m('plan', 300, 300, 4, 2)] },
], TIERS);
check('extras are heaviest first',
  twoExtras.slice(3).map((r) => r.id), ['plan', 'direct-edit']);

// --- the part no model claims ------------------------------------------------
/*
 * There was a 「内訳なし」 row for it, removed on the operator's instruction.
 *
 * What it named is still there, and currently dominant: `tok_<model>_*` began
 * part-way through the product's life, so a period can carry a complete total
 * and almost no attribution. Measured against the live table on 2026-09-10,
 * August is 0 of 165 requests and September 3 of 8. A table that dropped the
 * rest silently would add up to a third of the month and look complete, which is
 * the one failure a breakdown must not have — so `attribution` says the coverage
 * once, in the caption, instead.
 */
const straddling = [
  { totalTokens: 1000, requestCount: 10, byModel: [m('haiku', 200, 200, 4, 2)] },
];
const straddlingRows = modelRows(straddling, TIERS);
check('no row is added for the unattributed part',
  straddlingRows.map((r) => r.name), ['Haiku 4.5', 'Sonnet 4.6', 'Opus 4.8']);
check('and nothing is labelled 内訳なし',
  straddlingRows.some((r) => r.name.includes('内訳')), false);
// The rows still only add up to what was recorded — which is the reason the
// caption exists.
check('the rows are the recorded part only',
  straddlingRows.reduce((a, r) => a + r.requests, 0), 4);

check('the coverage is reported instead', attribution(straddling), { requests: 4, total: 10 });
// A period recorded entirely after the change needs no caption at all, and the
// component draws none: the two numbers are equal.
check('a fully attributed period reports itself complete',
  attribution([{ totalTokens: 400, requestCount: 4, byModel: [m('haiku', 200, 200, 4, 2)] }]),
  { requests: 4, total: 4 });
// August, as it actually is.
check('a period with no attribution at all says so',
  attribution([{ totalTokens: 17616592, requestCount: 165 }]), { requests: 0, total: 165 });
check('and an empty period is not a division by zero',
  attribution([]), { requests: 0, total: 0 });

// --- the badge counts models ------------------------------------------------
check('the badge counts the configured tiers', modelCount(rows), 3);
check('plus anything else that ran', modelCount(withExtra), 4);
check('and there is no longer a remainder to exclude', modelCount(straddlingRows), 3);

// --- the empty cases ---------------------------------------------------------
check('no usage at all still lists the tiers', modelRows([], TIERS).map((r) => r.id),
  ['haiku', 'sonnet', 'opus']);
check('and no configuration lists only what ran',
  modelRows([{ totalTokens: 200, requestCount: 2, byModel: [m('haiku', 100, 100, 2, 1)] }], [])
    .map((r) => r.id), ['haiku']);
check('with nothing at all, there is nothing to draw', modelRows([], []), []);

// --- and it is what the panel draws -----------------------------------------
const panel = readAdminPanel();
const tab = adminSection('ModelsTab.tsx', 'function ModelsTab(');
check('the tab draws one table', (tab.match(/<table className="adm-table"/g) ?? []).length, 1);
check('with the five columns asked for',
  ['>モデル<', '>推論プロファイル<', '>トークン数<', '>リクエスト数<', '>金額<'].filter((h) => !tab.includes(h)), []);
// 「ARN」 would be a claim about the string's format; the field also takes a bare
// profile id, and what it identifies is the profile either way.
check('the column is named for the thing, not the format', /<th className="adm-th">ARN<\/th>/.test(tab), false);
/*
 * The prose still mentions it — the comment on ModelsTab says why the table
 * went. What must be gone is the table, so this reads the markup rather than the
 * file: a check that cannot tell a heading from a sentence about a heading would
 * fail on its own explanation.
 */
const markup = panel.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('the Parameter Store listing is gone', /Parameter Store/.test(markup), false);
check('and so is the second table it sat in', /adm-paramvalue/.test(panel), false);
// From the series the same request carries, so the chart above the table and
// the table itself are two readings of one answer over one period.
check('the rows come from this function', /modelRows\(inventory\.series, inventory\.tiers\)/.test(panel), true);
check('and the caption from its companion', /attribution\(inventory\.series\)/.test(panel), true);
check('and the badge from its counter', /modelCount\(modelTable\)/.test(panel), true);
// Held by the panel, not reported up from the pane: the chip is drawn while
// another tab is showing, so the count must exist before the tab is chosen.
check('the inventory is fetched when the panel opens',
  /if \(!visible \|\| !superAdmin\) return;/.test(panel), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
