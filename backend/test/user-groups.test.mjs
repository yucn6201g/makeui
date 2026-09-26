// Three roles, and the boundary between two of them.
//
// A group administrator gets the admin panel over their own group. They do not
// get the account's spending controls — token limit, request limit — and they do
// not get to add or remove accounts. The super administrator keeps everything
// and gains group management.
//
// Two things are worth a test here and they are different in kind:
//
//   - the rule that reads a token's claims, which is a pure function and is
//     executed;
//   - the shape of every admin route, which is control flow and is read. A route
//     that forgets its guard is a 403 that never happens, and what it hands over
//     is one customer's briefs and generated UI to another customer's
//     administrator. Nothing in a build would notice.
//
//   node test/user-groups.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/services/user-groups.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/ug.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'pipe', cwd: root }
);
const { membershipOf, canOpenAdminPanel, isSuperAdmin, mayActOn, isValidGroupName, GROUP_PREFIX, GROUP_ADMIN_PREFIX } =
  await import(pathToFileURL(path.join(root, 'dist/ug.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- reading a token's claims ---------------------------------------------------
check('no groups is an ordinary user', membershipOf([]), { role: 'user', group: null });
check('a member of a group', membershipOf(['grp:acme']), { role: 'user', group: 'acme' });
check('its administrator', membershipOf(['grp:acme', 'grpadm:acme']), { role: 'group-admin', group: 'acme' });
check('the account administrator', membershipOf(['admin']), { role: 'super-admin', group: null });

/*
 * `admin` wins over a membership, and this is the case that matters: reading it
 * the other way would let anyone lock the last account administrator out of
 * everything by putting them in a group.
 */
check('an account administrator who is also in a group stays one',
  membershipOf(['admin', 'grp:acme']), { role: 'super-admin', group: 'acme' });
check('and even if they administer it',
  membershipOf(['admin', 'grp:acme', 'grpadm:acme']), { role: 'super-admin', group: 'acme' });

// Order of the claim array is not a fact about anything.
check('claim order does not matter', membershipOf(['grpadm:acme', 'grp:acme']),
  membershipOf(['grp:acme', 'grpadm:acme']));

// A prefix that only looks like one.
check('a group literally named "admin" is not the admin group',
  membershipOf(['grp:admin']), { role: 'user', group: 'admin' });

// --- who may open the panel -------------------------------------------------------
check('a user may not', canOpenAdminPanel(membershipOf(['grp:acme'])), false);
check('a group administrator may', canOpenAdminPanel(membershipOf(['grpadm:acme'])), true);
check('an account administrator may', canOpenAdminPanel(membershipOf(['admin'])), true);
check('only the account administrator is super', [
  isSuperAdmin(membershipOf(['admin'])),
  isSuperAdmin(membershipOf(['grpadm:acme'])),
  isSuperAdmin(membershipOf([])),
], [true, false, false]);

// --- and whose data they may touch --------------------------------------------------
{
  const superA = membershipOf(['admin']);
  const groupA = membershipOf(['grp:acme', 'grpadm:acme']);
  check('an account administrator reaches any group', [
    mayActOn(superA, 'acme'), mayActOn(superA, 'other'), mayActOn(superA, null),
  ], [true, true, true]);
  check('a group administrator reaches their own', mayActOn(groupA, 'acme'), true);
  check('and not another', mayActOn(groupA, 'other'), false);
  /*
   * The one worth stating: an ungrouped account is not everybody's. A usage row
   * outlives the account it was written for, and "belongs to no group" must not
   * read as "belongs to mine".
   */
  check('and not an account with no group', mayActOn(groupA, null), false);
  check('a plain user reaches nothing', mayActOn(membershipOf(['grp:acme']), 'acme'), false);
}

// --- names people type ---------------------------------------------------------------
check('an ordinary name', isValidGroupName('acme'), true);
check('spaces and punctuation', isValidGroupName('Acme Corp_2.0-jp'), true);
check('empty is not a name', isValidGroupName(''), false);
/*
 * `:` is the delimiter. Without this rule `grp:a:b` is ambiguous between a group
 * called `a:b` and a prefix nobody defined, and the ambiguity would surface as a
 * membership that silently belongs to the wrong group.
 */
check('a colon is refused', isValidGroupName('a:b'), false);
check('a prefix cannot be smuggled in', isValidGroupName('grp:acme'), false);
check('it must start with a word character', isValidGroupName('-acme'), false);
check('and is bounded', isValidGroupName('a'.repeat(64)), false);
check('a non-string is not a name', isValidGroupName(null), false);

// --- every admin route is guarded, and correctly ---------------------------------------
{
  const src = fs.readFileSync(path.join(root, 'src/handlers/lambda-handler.ts'), 'utf8');

  /** Each `/admin/...` route block, from its match to the end of its `if`. */
  const blocks = [];
  const flat = src.split('\n');
  for (let i = 0; i < flat.length; i += 1) {
    const line = flat[i];
    if (!/^\s*(if \(method|const admin\w+ = path\.match|const groupPath = path\.match)/.test(line)) continue;
    /*
     * `admin`, not `/admin/`. Three of these routes match with a regex literal,
     * where the path reads \`/^\\/admin\\/projects...`\ — the escapes mean a search
     * for `/admin/` finds nothing, and the first version of this scan quietly
     * skipped exactly the routes that serve another account's projects.
     */
    const window = flat.slice(i, i + 4).join(String.fromCharCode(10));
    if (!/[\'/]admin/.test(window)) continue;
    // To the next route start, which is enough to hold the guard.
    const body = flat.slice(i, i + 40).join('\n');
    blocks.push({ line: i + 1, head: window.split('\n')[0].trim().slice(0, 90), body });
  }
  check('the admin routes were found', blocks.length >= 14, true);

  const unguarded = blocks
    .filter((b) => !b.body.includes('canOpenAdminPanel(auth.membership)') && !b.body.includes('isSuperAdmin(auth.membership)'))
    .map((b) => `${b.line}: ${b.head}`);
  check('every admin route checks a role', unguarded, []);

  /*
   * The four the operator named, plus group management. Each must be
   * super-admin only — a `canOpenAdminPanel` guard on any of them is a group
   * administrator changing the account's spending or its people.
   */
  const SUPER_ONLY = [
    /*
     * A group's TOTAL budget, but no longer each member's.
     *
     * Dividing a ceiling among the people under it is the tenant's business and
     * the one thing their administrator knows better than anybody; raising the
     * ceiling is the account's, because the account is what is billed. So
     * `/admin/groups/limit` is super-admin only and `/admin/usage/limit` is
     * guarded by `mayActOnUser`, which is asserted separately below.
     */
    "path === '/admin/groups/limit'",
    "method === 'POST' && path === '/admin/users'",
    "method === 'DELETE' && path.startsWith('/admin/users/')",
    "method === 'POST' && path === '/admin/groups'",
    "const groupPath = path.match",
    "path === '/admin/groups/membership'",
    "path === '/admin/groups/admin'",
  ];
  const wrong = [];
  for (const marker of SUPER_ONLY) {
    const at = src.indexOf(marker);
    if (at === -1) { wrong.push(`${marker} (route missing)`); continue; }
    const body = src.slice(at, at + 900);
    if (!body.includes('isSuperAdmin(auth.membership)')) wrong.push(marker);
  }
  check('the account-wide actions are account-administrator only', wrong, []);

  /*
   * And the per-user budget is narrowed instead of forbidden.
   *
   * `canOpenAdminPanel` alone would let a group administrator set the budget of
   * somebody in another tenant; `mayActOnUser` is what makes the route theirs
   * only for their own people. Asserted here because the guard changed from a
   * flat refusal to a narrowing, and a narrowing that is missing looks exactly
   * like a route that was always open.
   */
  const limitAt = src.indexOf("path === '/admin/usage/limit'");
  const limitBody = limitAt === -1 ? '' : src.slice(limitAt, limitAt + 1400);
  check('setting one user\'s budget is narrowed to the caller\'s group',
    limitBody.includes('canOpenAdminPanel(auth.membership)') && limitBody.includes('mayActOnUser(auth, input.userId)'),
    true);

  /*
   * And the routes that serve someone else's data narrow it. A guard alone is
   * not enough here: `canOpenAdminPanel` lets a group administrator in, and what
   * stops them reading another tenant is the filter.
   */
  /*
   * Each route's own block, bounded by the next route. The first version of this
   * searched 1,800 characters forward from the marker, which on this file
   * reaches the NEXT route — so deleting the scope filter from the projects
   * route left the check passing, because the versions route twenty lines below
   * had one. A window that spans two routes cannot tell you about either.
   */
  /*
   * Each route's own block, bounded by the next route.
   *
   * Two attempts before this one were wrong in opposite directions, and both
   * PASSED while the code was broken. Searching 1,800 characters forward from
   * the marker reaches the NEXT route, so deleting the scope filter from the
   * projects route left the check green because the versions route below it had
   * one. Bounding on every `const x = path.match` instead cut three routes in
   * half, because that line and the `if (method ...)` under it are one route.
   *
   * So the boundaries are the `if (method` lines alone, and a marker on a
   * `path.match` line belongs to the `if` that follows it.
   */
  const starts = [...src.matchAll(/^\s*if \(method/gm)].map((m) => m.index);
  const blockAt = (marker) => {
    const at = src.indexOf(marker);
    if (at === -1) return null;
    const lineStart = src.lastIndexOf(String.fromCharCode(10), at) + 1;
    const line = src.slice(lineStart, src.indexOf(String.fromCharCode(10), at));
    /*
     * Three cases, and conflating any two of them is how the earlier versions
     * measured the wrong block: a marker ON an `if (method` line starts there; a
     * marker on the `path.match` line above one starts at the `if` below it; a
     * marker anywhere else is INSIDE a block and starts at the one before it.
     */
    const begin = starts.includes(lineStart)
      ? lineStart
      : /path\.match/.test(line)
        ? starts.find((i) => i > lineStart)
        : starts.filter((i) => i <= lineStart).pop();
    if (begin === undefined) return null;
    const end = starts.find((i) => i > begin) ?? src.length;
    return src.slice(begin, end);
  };

  const SCOPED = [
    // The marker is the call, not the line it used to sit on: the route now
     // enriches each row with its group before returning, so `getAllUsersUsage()`
     // is no longer the whole statement.
     // And it takes a period, so the call is no longer bare either.
     ['usage table', 'await getAllUsersUsage(', 'membersOf('],
    ['user directory', "if (method === 'GET' && path === '/admin/users') {", 'membersOf('],
    ['projects', 'const adminProjects = path.match', 'mayActOnUser(auth'],
    ['project versions', 'const adminVersions = path.match', 'mayActOnUser(auth'],
    ['one version', 'const adminVersion = path.match', 'mayActOnUser(auth'],
    ['usage history', "path.startsWith('/admin/usage/')", 'mayActOnUser(auth'],
    ['model allowance', "path === '/admin/usage/model-allowance'", 'mayActOnUser(auth'],
    ['rename', "method === 'PATCH' && path.startsWith('/admin/users/')", 'membersOf('],
  ];
  const unscoped = SCOPED
    .filter(([, marker, needle]) => {
      const block = blockAt(marker);
      return block === null || !block.includes(needle);
    })
    .map(([name]) => name);
  check("every route serving another account narrows to the caller's group", unscoped, []);
}

// --- the composer's copy of the rule ------------------------------------------------
//
// The panel has to decide what to draw before any request is made, so it reads
// the same claim. Two copies of a rule is the arrangement this repository has
// been burned by; both are executed here and compared.
{
  execSync(
    `npx esbuild "${path.resolve(root, '..', 'frontend', 'src/utils/account/membership.ts')}" ` +
      `--bundle --platform=node --format=esm --outfile="${path.join(root, 'dist/ug-client.test.mjs')}"`,
    { stdio: 'pipe', cwd: root }
  );
  const client = await import(pathToFileURL(path.join(root, 'dist/ug-client.test.mjs')).href);
  check('the composer helper exists', typeof client.membershipOf, 'function');
  check('the prefixes agree', [client.GROUP_PREFIX, client.GROUP_ADMIN_PREFIX], [GROUP_PREFIX, GROUP_ADMIN_PREFIX]);
  for (const claims of [
    [], ['admin'], ['grp:acme'], ['grpadm:acme'], ['grp:acme', 'grpadm:acme'],
    ['admin', 'grp:acme'], ['grp:admin'], ['grpadm:acme', 'grp:acme'],
  ]) {
    check(`both read ${JSON.stringify(claims)} the same`, client.membershipOf(claims), membershipOf(claims));
    check(`  and agree on who is super`, client.isSuperAdmin(client.membershipOf(claims)), isSuperAdmin(membershipOf(claims)));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
