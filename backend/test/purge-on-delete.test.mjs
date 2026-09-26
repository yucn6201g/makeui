/**
 * Deleting something deletes what it owned, and dividing a budget is not raising it.
 *
 * Four things that were each reasonable alone:
 *
 *   deleting an account removed the Cognito user and nothing else, leaving the
 *     whole `USER#<sub>` partition and every document under it. What made that
 *     invisible rather than untidy is that the usage panel had by then started
 *     HIDING rows belonging to no live account — the orphans stopped being
 *     listed at the same moment they stopped being deleted.
 *   deleting a group removed the Cognito group and left `GROUP#<name>`, which
 *     holds the budget and the month's spend and is keyed by the NAME. Make
 *     another group with the same name and it opens with its predecessor's
 *     budget set and its predecessor's spending already counted.
 *   `mayActOnUser` answers "is this one of my people", and a group
 *     administrator is one of their own people, and `-1` was an accepted
 *     budget, and a group's own budget defaults to unlimited. Composed: any
 *     group administrator may grant themselves an unlimited budget.
 *   a super-admin who is also in a group satisfies "in my group", so the routes
 *     a group administrator may reach became a way to configure the person who
 *     administers the account.
 *
 * And one that turned out not to be a defect — see the last block. `saveOutput`
 * has no reader in production and two outside it, so the assertions about it
 * say KEEP.
 *
 *   node test/purge-on-delete.test.mjs      (from backend/)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const handler = read('src/handlers/lambda-handler.ts');
const purge = read('src/services/account-purge.ts');
const storage = read('src/services/output-storage.ts');
const graph = read('src/orchestration/generate/graph.ts');
const groups = read('src/services/user-groups.ts');

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
  const end = handler.indexOf('    if (method ===', at + 10);
  return handler.slice(at, end === -1 ? at + 4000 : end);
}

// --- an account takes its storage with it -------------------------------------
{
  // The method as well as the path: `PUT /admin/users/:username` matches the
  // same prefix and comes first in the file.
  const del = route("method === 'DELETE' && path.startsWith('/admin/users/')");
  check('the delete route exists', del.length > 0, true);
  check('and purges the account', /purgeAccount\(sub\)/.test(del), true);

  /*
   * The `sub` is read BEFORE the account is deleted. Every row this user wrote
   * is under `USER#<sub>` and every document under `projects/<sub>/`, while the
   * route addresses people by username — so the only handle on their storage
   * has to be taken while the account holding it still exists. Read after, it
   * is unobtainable and the data is unreachable for good.
   */
  const subAt = del.indexOf('AdminGetUserCommand');
  const gone = del.indexOf('AdminDeleteUserCommand');
  check('the sub is resolved before the account is deleted', subAt > 0 && subAt < gone, true);

  /*
   * And the purge runs after. The account has to stop being able to sign in and
   * write more before its storage is swept, or the sweep races the person it is
   * sweeping.
   */
  check('and the purge runs after it', del.indexOf('purgeAccount') > gone, true);

  // A deletion that could not find the sub leaves exactly what the old
  // behaviour left, so it must be loud rather than silent.
  check('a purge that could not run is logged as an error',
    /Account deleted without purging its storage/.test(del), true);

  check('every partition the account owns is taken', [
    /USER\$\{userId\}/.test(purge.replace(/#/g, '')),
    /RATE\$\{userId\}/.test(purge.replace(/#/g, '')),
  ], [true, true]);
  check('and both document prefixes', [
    purge.includes('`projects/${userId}/`'),
    purge.includes('`versions/${userId}/`'),
  ], [true, true]);

  /*
   * Queried, not scanned, and projected to the keys. The partition key is
   * exactly what is being removed, and RCU is billed on the item as stored — so
   * reading three hundred whole version rows to learn their keys would cost
   * more than deleting them.
   */
  /*
   * Scoped to the purge. `sweepOrphans` further down DOES scan, and correctly:
   * its question is "which partitions exist", which no key condition answers and
   * no index answers more cheaply than reading the keys. A purge knows its
   * partition, so scanning there would be reading the whole table to delete
   * three hundred rows.
   */
  const partition = purge.slice(purge.indexOf('async function purgePartition'), purge.indexOf('export async function purgeAccount'));
  check('the partition is queried, not scanned', [
    /new QueryCommand/.test(partition), /ScanCommand/.test(partition),
  ], [true, false]);
  check('and read down to the keys', /ProjectionExpression: 'pk, sk'/.test(purge), true);

  /*
   * `BatchWriteItem` returns items instead of failing when a partition
   * throttles. Dropping them is how a purge reports success while leaving rows
   * behind, which is the failure this whole test exists about.
   */
  check('unprocessed deletes are retried', /UnprocessedItems/.test(purge), true);
}

// --- a group takes its budget and its month with it -----------------------------
{
  const del = route("method === 'DELETE' && groupPath");
  check('the group delete route purges the group', /purgeGroup\(name\)/.test(del), true);

  /*
   * No S3. A group owns no documents: its members' work belongs to the members,
   * who survive the group. Deleting one is an administrative regrouping and
   * must never be a way to delete people or their work.
   */
  check('a group purge touches no documents', /deletePrefix/.test(purge.slice(purge.indexOf('export async function purgeGroup'))), false);
  check('the accounts are explicitly left alone', /must never be a way to delete people/.test(purge), true);
}

// --- dividing a budget is not raising one ---------------------------------------
{
  const limit = route("path === '/admin/usage/limit'");
  check('the per-user budget route exists', limit.length > 0, true);

  // Unlimited is the account administrator's word.
  check('a group administrator may not grant unlimited',
    /!isSuperAdmin\(auth\.membership\)/.test(limit) && /input\.limit === -1/.test(limit), true);

  /*
   * And no share may exceed the ceiling it is a share of. Not enforcement — the
   * group's budget is checked on the same request either way — but a figure
   * larger than the group's would only mean showing somebody an allowance that
   * refuses them before they reach it.
   */
  check('nor a share larger than the group', /input\.limit > ceiling/.test(limit), true);

  /*
   * An unreadable ceiling is not an absent one. Reading it as unlimited would
   * make a DynamoDB throttle the way to set any budget at all, which is the
   * same failure `checkUsageLimit` refuses for.
   */
  check('an unreadable ceiling refuses rather than defaults',
    /ceiling === null/.test(limit) && /503/.test(limit), true);

  // The account administrator is unaffected by all three.
  const guardAt = limit.indexOf('!isSuperAdmin(auth.membership)');
  check('and none of it applies to the account administrator', guardAt > 0, true);
}

// --- never upwards --------------------------------------------------------------
{
  const may = handler.slice(handler.indexOf('async function mayActOnUser'), handler.indexOf('const ALLOWED_ORIGIN'));
  check('acting on a user reads their role, not only their group',
    /membershipOfSub\(targetSub\)/.test(may), true);
  check('and a super-admin is never a target', /target\?\.role === 'super-admin'/.test(may), true);
  check('the directory can answer with a role', /export async function membershipOfSub/.test(groups), true);
}

// --- the write that only looks unread -------------------------------------------
{
  /*
   * `saveOutput` writes every finished document a second time under
   * `outputs/<user>/<date>/<request>.html`, and no route, handler or screen
   * reads it — the key reaches `FinalOutput.outputKey` and stops there. It was
   * removed once for looking exactly like that, and put back, because two
   * things outside production read the prefix:
   *
   *   `scripts/score-items.mjs` reads the preset each document was BUILT for
   *     off the S3 object's own metadata. `versions/` holds the same documents
   *     and carries none, so it cannot answer that — and the script's own
   *     comment describes scoring without the preset as a 20-point hole.
   *   `test/framework-confusion.probe.mjs` pins one object here by key, and is
   *     one of the two probes .gitignore keeps on purpose.
   *
   * Asserted so it is not removed a third time on the same reasoning: a write
   * whose only readers are a script and a probe is exactly the kind that a grep
   * for its return value declares dead.
   */
  check('the corpus copy is still written', /saveOutput\(/.test(graph), true);
  check('and still defined', /export async function saveOutput/.test(storage), true);
  check('with the preset the document was built for', /preset: presetName/.test(graph), true);
  check('and the reason it exists is written down', [
    /score-items\.mjs/.test(storage),
    /framework-confusion\.probe\.mjs/.test(storage),
  ], [true, true]);

  /*
   * A deleted account's share of it still goes. Those objects belong to nobody,
   * and a corpus sampling a deleted user's work samples data the rule says
   * should not exist.
   */
  check('but a deleted account takes its own out of the corpus',
    purge.includes('`outputs/${userId}/`'), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
