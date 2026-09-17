/**
 * A group is billed as one, so it has one budget — and who may move it.
 *
 * Per-user budgets bound what one person can do and say nothing about what forty
 * can do together, which is the number on the invoice. Three rules, and each is
 * a different person's:
 *
 *   the account administrator sets a group's TOTAL. Raising the ceiling is the
 *     account's business, because the account is what is billed.
 *   the group's administrator divides it among their own members. They are the
 *     one who knows how a team's month should be split, and until now every such
 *     change went through the account administrator.
 *   every member can READ their group's total. Somebody refused while still
 *     inside their own budget is being stopped by a number their colleagues
 *     moved, and without it the refusal has no explanation on their screen.
 *
 *   node test/group-budget.test.mjs      (from backend/)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const usage = read('src/services/token-usage.ts');
const handler = read('src/handlers/lambda-handler.ts');
const runner = read('src/handlers/job-runner.ts');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/** One route block, from its path match to the next one. */
function route(marker) {
  const at = handler.indexOf(marker);
  if (at === -1) return '';
  const end = handler.indexOf("    if (method ===", at + 10);
  return handler.slice(at, end === -1 ? at + 1600 : end);
}

// --- the group's month is a row, not a scan --------------------------------------
{
  check('a group has its own budget', /export async function setGroupLimit/.test(usage), true);
  check('and its own month', /export async function getGroupMonth/.test(usage), true);
  check('written from the same figures as the user\'s',
    /GROUP#\$\{usage\.group\}/.test(usage), true);

  /*
   * A second aggregate rather than a sum over members: the group's budget is
   * checked before every build, and answering it by reading every member's
   * month would put the whole tenant's usage on the path of one person's run.
   */
  check('the group total is read as one item',
    /Key: \{ pk: \{ S: `GROUP\$\{'\}'\}/.test(usage) || /pk: \{ S: `GROUP#\$\{group\}` \}/.test(usage), true);

  /*
   * The user's row is written first and the group's is best-effort. A group
   * total that misses a request is a budget slightly too generous for a month;
   * a user total that misses one is the guard everybody is held to.
   */
  const userAt = usage.indexOf("'monthly aggregate'");
  const groupAt = usage.indexOf("'group aggregate'");
  check('the user\'s aggregate is written first', userAt > 0 && userAt < groupAt, true);

  /*
   * And the group comes from the caller. Looking it up here would put a Cognito
   * call on the end of every recorded request to answer what the request carried.
   */
  check('the group is passed in, not looked up', /group\?: string \| null;/.test(usage), true);
  check('the job carries it', /group\?: string \| null;/.test(runner), true);
  const calls = [...runner.matchAll(/recordUsage\(userId, \{([\s\S]*?)\}\);/g)].map((m) => m[1]);
  check('every recordUsage call passes it', calls.filter((c) => !/\bgroup,/.test(c)), []);
}

// --- both budgets are checked, and the refusal says which ---------------------------
{
  check('the check takes a group', /checkUsageLimit\(userId: string, group: string \| null/.test(usage), true);
  check('and reads both budgets in one round trip',
    /group \? getGroupLimit\(group\) :/.test(usage) && /group \? getGroupMonth\(group\) :/.test(usage), true);
  check('a request must fit both', /allowed: withinOwn && withinGroup/.test(usage), true);

  /*
   * On the same figure the user's is checked on — weighted where a price table
   * is enforced, plain otherwise. Comparing a weighted budget against a plain
   * total would make the group's ceiling roughly three times what it says.
   */
  check('on the same figure as the user\'s',
    /const groupUsed = priced \? groupMonth\.weighted : groupMonth\.total;/.test(usage), true);

  /*
   * Unreadable refuses, for the reason the user's own always has: the failure
   * that produces it is a throttle, which arrives under load.
   */
  check('an unreadable group budget refuses',
    /userTokenLimit === null \|\| groupLimit === null \|\| groupMonth === null/.test(usage), true);

  /*
   * The two failures send a person to different places — their administrator,
   * or nowhere, because a colleague spent it — so they cannot share a message.
   */
  check('the refusal names which budget', /function usageRefusal/.test(handler), true);
  check('and says the group when it was the group', /scope: 'group'/.test(handler), true);
  const checks = [...handler.matchAll(/await checkUsageLimit\(auth\.userId([^)]*)\)/g)].map((m) => m[1]);
  check('every check passes the group', checks.filter((c) => !c.includes('auth.membership.group')), []);
}

// --- who may move what -------------------------------------------------------------
{
  const groupLimit = route("path === '/admin/groups/limit'");
  check('the group total route exists', groupLimit.length > 0, true);
  check('and is account-administrator only', /isSuperAdmin\(auth\.membership\)/.test(groupLimit), true);
  // A budget on a name nobody belongs to binds nothing and reports nothing.
  check('it refuses a group that does not exist', /そのグループはありません/.test(groupLimit), true);

  const userLimit = route("path === '/admin/usage/limit'");
  check('a group administrator may reach the per-user budget',
    /canOpenAdminPanel\(auth\.membership\)/.test(userLimit), true);
  check('but only for their own people', /mayActOnUser\(auth, input\.userId\)/.test(userLimit), true);
  /*
   * And a group administrator is not refused outright. `isSuperAdmin` still
   * appears in the route — it narrows WHAT they may set, not WHOSE budget: a
   * share may not be unlimited and may not exceed the group's own, both of
   * which are the account administrator's to grant. See purge-on-delete.test.mjs
   * for those. What must not come back is the flat 403 that used to stand here.
   */
  const gateAt = userLimit.indexOf('isSuperAdmin');
  const scopeAt = userLimit.indexOf('mayActOnUser(auth, input.userId)');
  check('and a group administrator is no longer refused outright',
    gateAt === -1 || gateAt > scopeAt, true);
  check('what is left of it narrows the value instead',
    /if \(!isSuperAdmin\(auth\.membership\)\) \{[\s\S]{0,400}?input\.limit === -1/.test(userLimit), true);
}

// --- every member can read the total -------------------------------------------------
{
  const usageRoute = route("path === '/usage'");
  check('the usage route returns the group budget', /groupBudget: limitResult\.group/.test(usageRoute), true);
  /*
   * From the token's own membership, not a directory lookup: /usage is on the
   * path of every page load.
   */
  check('and the group name from the token', /group: auth\.membership\.group,/.test(usageRoute), true);

  const menu = read('../frontend/src/components/UsageMenu.tsx');
  check('the panel shows it', /グループ「\{group\}」全体/.test(menu), true);
  check('to whoever is looking, not only an administrator',
    /limits\.groupBudget && group/.test(menu), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
