/**
 * A group cannot be left with members and no administrator.
 *
 * `setUserGroup(user, null)` removes every `grp:` and `grpadm:` membership the
 * account holds, which is right for a move and wrong for the administrator of a
 * group that still has people in it: the members stay, nobody can open the panel
 * for them, and the button that did it said 「外す」 and nothing else. The panel
 * offers no way back — appointing an administrator lists the group's MEMBERS,
 * and the person who was one is no longer in it.
 *
 * So: refused while others remain, allowed when they are the last one out, and
 * never in the way of an ordinary member.
 *
 * The Cognito client is stubbed at the prototype, because the bundle keeps the
 * SDK external and therefore shares the class with this file. Every call it
 * makes is recorded, so the test can assert what did NOT happen — a refusal that
 * threw after removing the membership would pass a test that only checked for
 * the throw.
 *
 *   node test/group-admin-guard.test.mjs      (from backend/)
 */
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.COGNITO_USER_POOL_ID = 'ap-northeast-1_test';

execSync(
  `npx esbuild "${path.join(root, 'src/services/user-groups.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/ug-guard.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'pipe', cwd: root }
);

const { CognitoIdentityProviderClient } = await import('@aws-sdk/client-cognito-identity-provider');

/** group -> members, and who administers it. The directory, as far as this goes. */
let directory = {};
let calls = [];
CognitoIdentityProviderClient.prototype.send = async function stub(command) {
  const name = command.constructor.name;
  const input = command.input ?? {};
  calls.push({ name, ...input });
  if (name === 'AdminListGroupsForUserCommand') {
    const groups = [];
    for (const [g, d] of Object.entries(directory)) {
      if (d.members.includes(input.Username)) groups.push({ GroupName: `grp:${g}` });
      if (d.admin === input.Username) groups.push({ GroupName: `grpadm:${g}` });
    }
    return { Groups: groups };
  }
  if (name === 'ListUsersInGroupCommand') {
    const g = String(input.GroupName).replace(/^grp(adm)?:/, '');
    const d = directory[g];
    if (!d) return { Users: [] };
    const users = input.GroupName.startsWith('grpadm:')
      ? (d.admin ? [d.admin] : [])
      : d.members;
    return { Users: users.map((u) => ({ Username: u })) };
  }
  if (name === 'AdminRemoveUserFromGroupCommand' || name === 'AdminAddUserToGroupCommand') return {};
  throw new Error(`unstubbed command: ${name}`);
};

const { setUserGroup, GroupWouldLoseAdminError } =
  await import(pathToFileURL(path.join(root, 'dist/ug-guard.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};
const attempt = async (f) => {
  calls = [];
  try { await f(); return null; } catch (e) { return e; }
};
const wrote = () => calls.filter((c) =>
  c.name === 'AdminRemoveUserFromGroupCommand' || c.name === 'AdminAddUserToGroupCommand').length;

// --- the administrator of a group that still has people --------------------
directory = { acme: { members: ['boss', 'alice', 'bob'], admin: 'boss' } };
let err = await attempt(() => setUserGroup('boss', null));
check('removing the administrator is refused', err instanceof GroupWouldLoseAdminError, true);
check('and nothing was changed on the way out', wrote(), 0);
check('the message names the group', err.message.includes('acme'), true);
check('and how many people would be stranded', err.message.includes('2人'), true);
// The way out is stated, because the panel offers no other: appointing an
// administrator lists the group's members, and this one would no longer be in it.
check('and what to do instead', err.message.includes('別のメンバーを管理者にしてください'), true);
check('the error carries the group', err.group, 'acme');
check('and the count, for a caller that wants to phrase it differently', err.remaining, 2);

// Moving them to another group is the same removal wearing a different hat.
err = await attempt(() => setUserGroup('boss', 'other'));
check('moving them elsewhere is refused too', err instanceof GroupWouldLoseAdminError, true);
check('and again changed nothing', wrote(), 0);

// --- what must still work --------------------------------------------------
err = await attempt(() => setUserGroup('alice', null));
check('an ordinary member is removed', err, null);
check('and it took a write', wrote() > 0, true);

// The last one out. An empty group has nothing to administer, and refusing here
// would be a dead end rather than a safeguard.
directory = { acme: { members: ['boss'], admin: 'boss' } };
err = await attempt(() => setUserGroup('boss', null));
check('the last member may leave even as administrator', err, null);
check('and both memberships go with them',
  calls.filter((c) => c.name === 'AdminRemoveUserFromGroupCommand').map((c) => c.GroupName).sort(),
  ['grp:acme', 'grpadm:acme']);

// Re-appointing them to the group they already administer is not a removal.
directory = { acme: { members: ['boss', 'alice'], admin: 'boss' } };
err = await attempt(() => setUserGroup('boss', 'acme'));
check('setting the administrator to their own group is allowed', err, null);

// Somebody in no group at all cannot strand anything.
directory = { acme: { members: ['alice'], admin: 'alice' } };
err = await attempt(() => setUserGroup('stranger', 'acme'));
check('an unaffiliated account joins freely', err, null);

// --- the route answers 409, not 500 ----------------------------------------
// A refusal the caller can act on, phrased once and passed through. Flattened
// into the generic handler it becomes 「サーバーエラー」 and the sentence saying
// what to do instead is lost.
const handler = (await import('node:fs')).readFileSync(
  path.join(root, 'src/handlers/lambda-handler.ts'), 'utf8');
const route = handler.slice(
  handler.indexOf("path === '/admin/groups/membership'"),
  handler.indexOf("path === '/admin/groups/admin'"));
check('the membership route catches it', route.includes('GroupWouldLoseAdminError'), true);
check('and answers 409', /jsonResponse\(409, \{ error: e\.message \}\)/.test(route), true);
check('anything else still throws', /throw e/.test(route), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
