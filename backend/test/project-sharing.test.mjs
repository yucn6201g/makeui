// Sharing a project with named users and user groups, at three roles.
//
//   full  the owner's equivalent, including adding people
//   edit  everything except adding people
//   view  reading only
//
// The project never moves: its row, document, conversation and versions stay in
// the owner's partition, every route resolves the caller's role first and then
// works on the owner's records, and a run's tokens go to whoever ran it.
//
//   node test/project-sharing.test.mjs      (from backend/)
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = async (entry, out) => {
  await esbuild.build({
    entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'esm',
    outfile: path.join(root, out), external: ['@aws-sdk/*', '@smithy/*'], logLevel: 'error',
  });
  return import(pathToFileURL(path.join(root, out)).href);
};
const shares = await bundle('src/services/project-shares.ts', 'dist/project-sharing.shares.test.mjs');
const chat = await bundle('src/services/chat-history.ts', 'dist/project-sharing.chat.test.mjs');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- what each role may do ------------------------------------------------------------
{
  const { CAN } = shares;
  const matrix = Object.fromEntries(['owner', 'full', 'edit', 'view', null].map((r) =>
    [String(r), ['read', 'write', 'delete', 'manage'].filter((c) => CAN[c](r))]));
  check('owner and full may do everything', [matrix.owner, matrix.full], [['read', 'write', 'delete', 'manage'], ['read', 'write', 'delete', 'manage']]);
  check('edit may do everything but add people', matrix.edit, ['read', 'write', 'delete']);
  check('view may only read', matrix.view, ['read']);
  check('no role, nothing', matrix.null, []);
}

// --- a person's role, directly and through their group ------------------------------------
{
  const g = (type, id, role) => ({ type, id, role, label: id, grantedBy: 'o', grantedByName: 'o', grantedAt: '' });
  const grants = [g('user', 'alice', 'view'), g('group', 'design', 'edit'), g('user', 'bob', 'full')];
  check('a direct grant', shares.roleFromGrants(grants, 'bob', null), 'full');
  check('a group grant', shares.roleFromGrants(grants, 'carol', 'design'), 'edit');
  check('the higher of the two when a person has both', shares.roleFromGrants(grants, 'alice', 'design'), 'edit');
  check('nothing for someone in neither', shares.roleFromGrants(grants, 'dave', 'sales'), null);
  check('a group grant never matches someone in no group', shares.roleFromGrants([g('group', '', 'edit')], 'erin', null), null);
  check('roles are only the three', [shares.isShareRole('full'), shares.isShareRole('owner'), shares.isShareRole('admin')], [true, false, false]);
}

// --- one conversation, whoever saves it ---------------------------------------------------
{
  const stored = [{ id: 'a', timestamp: 1, content: 'owner asked' }, { id: 'b', timestamp: 2, content: 'reply' }];
  const incoming = [{ id: 'a', timestamp: 1, content: 'owner asked' }, { id: 'c', timestamp: 3, content: 'editor asked' }];
  const merged = chat.mergeThreads(stored, incoming);
  check('a collaborator\'s save keeps what the other said', merged.map((m) => m.id), ['a', 'b', 'c']);
  check('and the incoming copy wins on the same id', chat.mergeThreads([{ id: 'a', timestamp: 1, content: 'old' }], [{ id: 'a', timestamp: 1, content: 'new' }])[0].content, 'new');
}

// --- every project route asks first, and works on the owner's records -----------------------
const api = read('src/handlers/lambda-handler.ts');
const slice = (from, to) => api.slice(api.indexOf(from), api.indexOf(to, api.indexOf(from) + from.length));
{
  const preview = slice('const previewMatch', 'const chatMatch');
  check('the preview needs read, from the owner', [/requireProject\(auth, projectId, 'read'\)/.test(preview), /getLatestProjectHtml\(gate\.access\.ownerId/.test(preview)], [true, true]);
  const messages = slice('const chatMatch', "if (method === 'PUT' && path.startsWith('/projects/'))");
  check('the conversation is read with read and saved with write, in the owner\'s partition',
    [/'read'\)[\s\S]*getChatMessages\(gate\.access\.ownerId/.test(messages), /'write'\)[\s\S]*saveChatMessages\(gate\.access\.ownerId/.test(messages)], [true, true]);
  check('a shared thread is merged, and an empty save still clears', /shared && incoming\.length > 0\s*\? mergeThreads/.test(messages), true);
  const update = slice("if (method === 'PUT' && path.startsWith('/projects/'))", "if (method === 'DELETE' && path.startsWith('/projects/'))");
  check('renaming and archiving need write', /requireProject\(auth, projectId, 'write'\)[\s\S]*updateProject\(gate\.access\.ownerId/.test(update), true);
  const del = api.slice(api.indexOf("if (method === 'DELETE' && path.startsWith('/projects/'))"));
  check('deleting needs delete, on the owner\'s project', /requireProject\(auth, projectId, 'delete'\)[\s\S]*deleteProject\(gate\.access\.ownerId/.test(del), true);
  const versions = slice("if (method === 'GET' && path === '/versions')", "if (method === 'POST' && path === '/versions')");
  check('a project\'s history needs read, from the owner', /'read'\)[\s\S]*getVersionHistory\(gate\.access\.ownerId, 20, projectId\)/.test(versions), true);
  const save = slice("if (method === 'POST' && path === '/versions')", "if (method === 'GET' && path.startsWith('/versions/'))");
  check('a hand edit needs write and names its author', [/'write'\)/.test(save), /actorId: auth\.userId/.test(save), /updateProject\(partition,/.test(save)], [true, true, true]);
  const one = slice("if (method === 'GET' && path.startsWith('/versions/'))", '/*');
  check('one version through a project must belong to it', /version\.projectId !== forProject/.test(one), true);
  for (const route of ["path === '/generate'", "path === '/modify'"]) {
    const src = slice(route, 'dispatchJob(');
    check(`${route}: a run on a project needs write`, /requireProject\(auth, input\.projectId, 'write'\)/.test(src), true);
    check(`${route}: and tells the job whose project it is`, /projectOwnerId: gate\.access\.ownerId/.test(src) && /\.\.\.projectOwner/.test(src), true);
  }
  check('a client cannot aim a run at someone else\'s partition', /projectOwnerId: _spoofedOwner, actorName: _spoofedActor/.test(api), true);
  check('404, not 403, for a project the caller cannot see', /if \(!access\) return \{ refused: jsonResponse\(404/.test(api), true);
}

// --- a run on a shared project -------------------------------------------------------------
{
  const runner = read('src/handlers/job-runner.ts');
  check('tokens go to whoever ran it', (runner.match(/await recordUsage\(userId, \{/g) ?? []).length >= 2, true);
  check('versions go to the project\'s owner, naming the actor', (runner.match(/userId: projectPartition\(input, userId\),\s*actorId: userId,/g) ?? []).length, 2);
  check('and so does the project\'s own record', (runner.match(/recordProjectRun\(projectPartition\(input, userId\), input\.projectId/g) ?? []).length, 2);
}

// --- nothing outlives the project, the account or the group ---------------------------------
{
  check('deleting a project removes its shares', /await deleteAllShares\(projectId\)/.test(read('src/services/project-service.ts')), true);
  const purge = read('src/services/account-purge.ts');
  check('deleting an account removes its projects\' shares and its own grants',
    [/if \(p\.sharedAt\) await deleteAllShares\(p\.projectId\)/.test(purge), /revokeShare\(ref\.projectId, \{ type: 'user', id: userId \}\)/.test(purge)], [true, true]);
  check('deleting a group removes its grants', /GROUPSHARE#\$\{group\}[\s\S]{0,300}revokeShare\(projectId, \{ type: 'group', id: group \}\)/.test(purge), true);
}

// --- the routes exist -----------------------------------------------------------------------
{
  const routes = read('src/handlers/share-routes.ts');
  for (const r of ["path === '/users/search'", "path === '/share-groups'", '/shares$/', '/shares\\/(user|group)\\/']) {
    check(`route: ${r}`, routes.includes(r), true);
  }
  check('only owner and full may add people', /if \(!CAN\.manage\(access\.role\)\) return respond\(403/.test(routes), true);
  // A user group is a customer: the directory is scoped to the caller's own.
  check('the search returns only people in scope', /const users = \(await Promise\.all\(found\.map\(async \(u\) => \(\(await inScope\(caller, u\.userId\)\) \? u : null\)\)\)\)/.test(routes), true);
  check('the groups offered are only the caller\'s', /\(await listUserGroups\(\)\)\.filter\(\(g\) => groupInScope\(caller, g\.name\)\)/.test(routes), true);
  check('and a crafted grant outside it is refused', [/!user \|\| !\(await inScope\(caller, input\.id\)\)/.test(routes), /!group \|\| !groupInScope\(caller, group\.name\)/.test(routes)], [true, true]);
  check('scope is one group, or everyone for the account administrator', /if \(caller\.superAdmin\) return true;\s*return \(await groupOfSub\(userId\)\) === caller\.group;/.test(routes), true);
  check('anyone may leave', /const leaving = type === 'user' && id === caller\.userId/.test(routes), true);
  check('the main handler routes them', /handleShareRoutes\(/.test(api) && /listProjectsFor\(callerOf\(auth\)\)/.test(api), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
