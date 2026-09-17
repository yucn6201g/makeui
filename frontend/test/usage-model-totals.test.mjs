/**
 * The month, split by model, for the whole account.
 *
 * The usage tab's summary bar says how many tokens, how many requests and how
 * much money. The tiers differ by five times in price, so none of those three
 * can be acted on without the fourth question — on what. Every user row already
 * carried the split; nothing added them up.
 *
 * Two of the rules here look like arithmetic and are not, which is why the sums
 * are a function rather than a `useMemo`:
 *
 *   - a model with one unpriced request is an unpriced model. Printing the
 *     priced part as the total understates the bill and looks exactly like a
 *     correct figure.
 *   - the part no model claims is named. A breakdown that silently drops a third
 *     of a month is worse than none: every number in it is right.
 *
 *   node test/usage-model-totals.test.mjs      (from frontend/)
 */
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/utils/modelTotals.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'node_modules/.cache/mt.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const { modelTotals } = await import(
  pathToFileURL(path.join(root, 'node_modules/.cache/mt.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const m = (model, inp, out, req, cost) => ({ model, inputTokens: inp, outputTokens: out, requestCount: req, cost });

// --- adding two accounts together ------------------------------------------
const two = modelTotals([
  { totalTokens: 300, requestCount: 3, byModel: [m('haiku', 100, 100, 2, 1.5), m('sonnet', 50, 50, 1, 4)] },
  { totalTokens: 200, requestCount: 2, byModel: [m('haiku', 80, 120, 2, 2.5)] },
]);
check('one row per model, not per account', two.rows.map((r) => r.model), ['haiku', 'sonnet']);
check('tokens are input plus output, summed across accounts',
  two.rows.find((r) => r.model === 'haiku').tokens, 400);
check('so are requests', two.rows.find((r) => r.model === 'haiku').requests, 4);
check('and money', two.rows.find((r) => r.model === 'haiku').cost, 4);
// Heaviest first: the question is "where did it go", and the answer is the top row.
check('heaviest first', two.rows.map((r) => r.tokens), [400, 100]);
check('everything is accounted for', [two.restTokens, two.restRequests], [0, 0]);
check('and a money column is worth drawing', two.anyCost, true);
check('with nothing missing from it', two.partialCost, false);

// --- an unpriced request poisons its own row, and nothing else -------------
const mixed = modelTotals([
  { totalTokens: 400, requestCount: 4, byModel: [m('haiku', 100, 100, 2, 3), m('direct-edit', 100, 100, 2, null)] },
]);
check('a model with an unpriced request is not priced',
  mixed.rows.find((r) => r.model === 'direct-edit').priced, false);
// The point of the rule. The priced half is still in `cost`; `priced` is what
// says whether it may be shown, and the component draws 「—」 when it is false.
check('the model beside it still is', mixed.rows.find((r) => r.model === 'haiku').priced, true);
check('and its figure is untouched', mixed.rows.find((r) => r.model === 'haiku').cost, 3);
check('the table says some of it could not be priced', mixed.partialCost, true);
// Tokens and requests are counted whether or not there was a price for them:
// the split is complete even when the money is not.
check('an unpriced model still counts its tokens',
  mixed.rows.find((r) => r.model === 'direct-edit').tokens, 200);

// --- the part no model claims ----------------------------------------------
// A month straddling the deploy that began recording the model has a total
// larger than its own split.
const straddling = modelTotals([
  { totalTokens: 1000, requestCount: 10, byModel: [m('haiku', 300, 300, 4, 2)] },
]);
check('the unclaimed tokens are named', straddling.restTokens, 400);
check('and the unclaimed requests', straddling.restRequests, 6);
// Not negative. The split is recorded per request and the total per month, and
// the two are written by different code paths.
const overcounted = modelTotals([
  { totalTokens: 100, requestCount: 1, byModel: [m('haiku', 200, 200, 5, 1)] },
]);
check('a split larger than the total does not go negative',
  [overcounted.restTokens, overcounted.restRequests], [0, 0]);

// --- the empty and nearly-empty cases --------------------------------------
check('no accounts is no rows', modelTotals([]).rows, []);
check('and nothing unclaimed', [modelTotals([]).restTokens, modelTotals([]).restRequests], [0, 0]);
const noSplit = modelTotals([{ totalTokens: 500, requestCount: 5 }]);
check('an account with no split at all is entirely unclaimed',
  [noSplit.rows.length, noSplit.restTokens, noSplit.restRequests], [0, 500, 5]);
// A model key recorded with nothing spent against it is not a row.
const emptyModel = modelTotals([
  { totalTokens: 0, requestCount: 0, byModel: [m('opus', 0, 0, 0, 0)] },
]);
check('a model with nothing against it is not drawn', emptyModel.rows, []);
// No prices configured at all: the column is not worth a heading.
const unpriced = modelTotals([
  { totalTokens: 200, requestCount: 2, byModel: [m('haiku', 100, 100, 2, null)] },
]);
check('with no prices anywhere there is no money column', unpriced.anyCost, false);
check('and the table says so', unpriced.partialCost, true);
// Priced at zero is still priced — a free tier is a fact, not a missing value.
const free = modelTotals([
  { totalTokens: 200, requestCount: 2, byModel: [m('haiku', 100, 100, 2, 0)] },
]);
check('a zero price is not a missing one', free.partialCost, false);

/*
 * What draws these numbers is asserted in model-rows.test.mjs.
 *
 * They are one half of a join now — the other half is the tier configuration —
 * and the component that used to render them directly is gone. The one thing
 * worth pinning from here is that the join starts from this function rather than
 * from a second copy of the two rules above.
 */
const rowsSrc = fs.readFileSync(path.join(root, 'src/utils/modelRows.ts'), 'utf8');
check('the row builder starts from these totals', /const totals = modelTotals\(users\)/.test(rowsSrc), true);
check('and does not re-derive the split itself', /inputTokens \+ [a-z.]*outputTokens/.test(rowsSrc), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
