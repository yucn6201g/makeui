/**
 * The tab that says what the deployment is configured to run.
 *
 * Every figure on the usage tab is a consequence of three things stored outside
 * the code — which model id each tier resolves to, what the price table says,
 * and whether that table is enforced — and none of them was visible anywhere.
 * Answering 「今月なぜこの金額なのか」 meant an `aws ssm get-parameter` on a
 * machine with credentials.
 *
 * The per-model breakdown moved here rather than being copied — a table about
 * models under a table about people was the wrong tab — and then merged with the
 * tier configuration it was stacked on. Both were keyed on the same thing, so
 * reading them meant matching a name in one against a name in the other by eye.
 *
 * What the merged table contains is asserted in model-rows.test.mjs, against the
 * function that builds its rows. This file is about the tab: where it sits, who
 * may see it, and how its data arrives.
 *
 *   node test/admin-models-tab.test.mjs      (from frontend/)
 */
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const panel = fs.readFileSync(path.join(root, 'src/components/AdminPanel.tsx'), 'utf8');
const hook = fs.readFileSync(path.join(root, 'src/hooks/useAdmin.ts'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/index.css'), 'utf8');

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

const tab = panel.slice(panel.indexOf('function ModelsTab('), panel.indexOf('// --- Main AdminPanel ---'));

// --- where it sits ----------------------------------------------------------
check('the tab exists', tab.length > 0, true);
check('the panel can be on it', /useState<'usage' \| 'models' \| 'users'/.test(panel), true);
check('it is the second tab', [
  panel.indexOf("setTab('models')") > panel.indexOf("setTab('usage')"),
  panel.indexOf("setTab('models')") < panel.indexOf("setTab('users')"),
], [true, true]);
// It reports the account's own infrastructure — model ids, bucket names, pool
// ids, role ARNs — which is not a group administrator's business, and their
// panel is scoped to their own people by design.
check('and only a super-admin sees it',
  /\{superAdmin && \(\s*\n\s*<button\s*\n\s*className=\{`adm-tab\$\{tab === 'models'/.test(panel), true);
check('rendered under the same guard', /\{tab === 'models' && superAdmin && \(/.test(panel), true);

/*
 * What the single table contains is asserted in model-rows.test.mjs, against the
 * function that builds its rows. What is left here is the tab itself: where it
 * sits, who may see it, and how its data arrives.
 */

// --- one table, not three ---------------------------------------------------
// It was the usage split, the tier configuration, and a Parameter Store listing
// stacked. The first two were keyed on the same thing and are joined; the third
// answered a question nobody asks on this screen and cost a permission
// (`ssm:GetParametersByPath`) that went with it.
check('the tab draws exactly one table', (tab.match(/<table className="adm-table"/g) ?? []).length, 1);
const markup = panel.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('and the parameter listing is gone from the markup', /Parameter Store/.test(markup), false);
check('the hook no longer types one', /ParameterInfo/.test(hook), false);
check('nor the payload', /parametersError/.test(hook), false);

// --- the badge counts what the tab lists ------------------------------------
check('the tab carries a count', /<span className="adm-tab-badge">\{modelCount\(modelTable\)\}<\/span>/.test(panel), true);
// Held by the panel like every other chip's number. Reported up from the pane is
// the shape the projects badge had and was removed for.
check('from data the panel holds', /const \[inventory, setInventory\] = useState<ModelInventory \| null>\(null\)/.test(panel), true);
// The tab is handed the answer and the period; it does not fetch, and the count
// beside its chip comes from the same rows it draws.
check('the tab is given the inventory rather than fetching it',
  /<ModelsTab[\s\S]{0,60}inventory=\{inventory\}/.test(panel), true);
check('and its own period, separate from the usage tab',
  /period=\{modelPeriod\}[\s\S]{0,60}onPeriodChange=\{setModelPeriod\}/.test(panel), true);

// --- the fetch --------------------------------------------------------------
check('the hook can ask for it', /const fetchModelInventory = useCallback/.test(hook), true);
check('over the admin route', /\$\{apiUrl\}\/admin\/models/.test(hook), true);
check('and it is returned from the hook', /return \{ fetchModelInventory,/.test(hook), true);
// When the panel opens, not when the tab does: the chip is drawn while another
// tab is showing, so the count has to exist before the tab is ever chosen.
check('fetched once the panel is visible',
  /if \(!visible \|\| !superAdmin\) return;/.test(panel), true);
/*
 * And a superseded request cannot answer for the current one.
 *
 * The first version guarded on `inventoryBusy` and listed it as a dependency,
 * which deadlocks: the effect set busy, the dependency change tore the effect
 * down, the re-run stopped at the guard, and the completion that would have
 * cleared busy was behind a `cancelled` flag the teardown had already set. The
 * tab showed its spinner for ever. The rule that forbids the shape is in
 * effect-deps.test.mjs; this is the shape that replaced it.
 */
check('and a late answer is superseded rather than stranded',
  /const current = \(\) => inventoryRequestRef\.current === id/.test(panel), true);
check('with the spinner cleared by whichever request is current',
  /finally\(\(\) => \{ if \(current\(\)\) setInventoryBusy\(false\)/.test(panel), true);
check('a failure is shown rather than swallowed', /setInventoryError\(/.test(panel), true);

// --- layout -----------------------------------------------------------------
// As flex items the blocks shrank to share the pane's height and the table was
// cut off mid-row.
check('the pane stacks rather than sharing its height',
  /display:\s*block/.test(rule('.adm-tabpane--scroll')), true);
check('and scrolls as one', /overflow-y:\s*auto/.test(rule('.adm-tabpane--scroll')), true);
// The profile column is 70 characters; the narrow block was sized for four short
// ones and wrapped it across four lines.
check('the table gets the full width', /max-width:\s*none/.test(rule('.adm-modeltotals--wide')), true);
check('which it asks for', /adm-modeltotals adm-modeltotals--wide/.test(tab), true);
// An identifier is compared character by character.
check('the profile is set in a monospace face',
  /font-family: ui-monospace/.test(rule('.adm-modelid')), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
