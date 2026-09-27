/**
 * The E2E tests' mocked API, held to the real one (docs/09_e2e_testing.md, layer L2).
 *
 * The Playwright tests answer every request from e2e/fixtures/api.ts. That makes
 * them fast and free, and it is also how they could drift into testing an API
 * that does not exist: a mock for a route the backend never had passes forever,
 * which is the 404-behind-a-green-suite failure this project has had before.
 * So, read from the backend's own source:
 *
 *   1. every route a mock answers is a route the backend serves, for that method;
 *   2. every field a mock answer carries is one the backend's answer carries.
 *
 * The mock is run for real (bundled, called without a browser); the backend is
 * read as text, because running it needs AWS.
 *
 *   node test/e2e-contract.test.mjs      (from frontend/)
 */
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backend = path.resolve(root, '../backend/src');
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const out = path.join(root, 'dist-test/e2e-contract.test.mjs');
fs.mkdirSync(path.dirname(out), { recursive: true });
const entry = path.join(root, 'dist-test/e2e-contract-entry.ts');
fs.writeFileSync(entry, "export { MockApi } from '../e2e/fixtures/api';\nexport { mockAdmin } from '../e2e/fixtures/admin';\n");
await esbuild.build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out, external: ['@playwright/test'] });
const { MockApi, mockAdmin } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- the backend's routes, from its source ---------------------------------------
const handlers = read(path.join(backend, 'handlers/lambda-handler.ts')) + '\n' + read(path.join(backend, 'handlers/share-routes.ts'));
const served = [];
for (const m of handlers.matchAll(/method === '([A-Z]+)' && path === '([^']+)'/g)) served.push({ method: m[1], test: (p) => p === m[2], text: m[0] });
for (const m of handlers.matchAll(/method === '([A-Z]+)' && path\.startsWith\('([^']+)'\)/g)) served.push({ method: m[1], test: (p) => p.startsWith(m[2]), text: m[0] });
// `const chatMatch = path.match(/^\/projects\/([^/]+)\/messages$/)`, then `method === 'GET' && chatMatch`
// or a method checked inside the branch — in which case any method the branch names.
for (const m of handlers.matchAll(/const (\w+) = path\.match\(\/(\^.*?\$)\/\)/g)) {
  const re = new RegExp(m[2]);
  const methods = [
    ...[...handlers.matchAll(new RegExp(`method === '([A-Z]+)' && ${m[1]}\\b`, 'g'))].map((x) => x[1]),
    ...[...handlers.matchAll(new RegExp(`\\b${m[1]} && method === '([A-Z]+)'`, 'g'))].map((x) => x[1]),
  ];
  const branch = handlers.slice(handlers.indexOf(`if (${m[1]})`), handlers.indexOf(`if (${m[1]})`) + 4000);
  const inner = handlers.includes(`if (${m[1]})`) ? [...branch.matchAll(/method === '([A-Z]+)'/g)].map((x) => x[1]) : [];
  for (const method of new Set([...methods, ...inner])) served.push({ method, test: (p) => re.test(p), text: m[0] });
}
check('the backend\'s routes were found in its source', served.length > 30, true);

// A concrete path for each mocked pattern: every `[^/]+` segment becomes an id.
const samplePath = (pattern) => pattern.source.replace(/^\^/, '').replace(/\$$/, '').replace(/\(\[\^\/\]\+\)|\[\^\/\]\+/g, 'e2e-id').replace(/\\\//g, '/').replace(/\\(.)/g, '$1');

const api = new MockApi();
mockAdmin(api);
const unserved = api.routeList()
  .map(({ method, pattern }) => ({ method, path: samplePath(pattern) }))
  .filter(({ method, path: p }) => !served.some((r) => r.method === method && r.test(p)))
  .map(({ method, path: p }) => `${method} ${p}`);
check('every route the E2E mock answers is one the backend serves', unserved, []);

// --- the fields of the answers the screens depend on -----------------------------
/** The source of one route's branch, from its condition to the next top-level route. */
function branch(condition) {
  const at = handlers.indexOf(condition);
  if (at < 0) return '';
  const next = handlers.indexOf('\n    if (method ===', at + condition.length);
  return handlers.slice(at, next > 0 ? next : at + 6000);
}
/** Keys of `body` that the backend's branch never writes, as `key:` or shorthand `key,`/`key }`. */
const missingKeys = (body, source) => Object.keys(body ?? {}).filter((k) => !new RegExp(`\\b${k}\\s*[:,}]|\\.\\.\\.${k}\\b`).test(source));
const ask = async (method, url, body = null) => {
  const [p, q = ''] = url.split('?');
  const reply = await api.respond({ method, path: p, query: new URLSearchParams(q), body, headers: {} });
  return { status: reply.status ?? 200, body: reply.body };
};

const models = await ask('GET', '/models');
check('GET /models carries only fields the backend sends', missingKeys(models.body, branch("method === 'GET' && path === '/models'")), []);
check('and each model the fields the backend gives it',
  [...new Set(models.body.models.flatMap((m) => missingKeys(m, branch("method === 'GET' && path === '/models'"))))], []);

const usage = await ask('GET', '/usage');
check('GET /usage carries only fields the backend sends', missingKeys(usage.body, branch("method === 'GET' && path === '/usage'")), []);

const started = await ask('POST', '/generate', { prompt: 'x' });
check('POST /generate answers 202, as the backend does', started.status, 202);
check('with the job id and status the backend sends', /jsonResponse\(202, \{ jobId, status: 'pending' \}\)/.test(branch("method === 'GET' && path === '/health'") + handlers), true);
check('and the same two fields', Object.keys(started.body).sort(), ['jobId', 'status']);
for (const route of ['/modify', '/plan']) {
  const reply = await ask('POST', route, {});
  check(`POST ${route} answers the same way`, [reply.status, Object.keys(reply.body).sort()], [202, ['jobId', 'status']]);
}

const polled = await ask('GET', `/jobs/${started.body.jobId}`);
const jobsBranch = branch("method === 'GET' && path.startsWith('/jobs/')");
check('GET /jobs/{id} carries only fields the backend sends', missingKeys(polled.body, jobsBranch), []);
check('its statuses are the backend\'s', ['pending', 'running', 'completed', 'failed'].every((s) => read(path.join(backend, 'services/job-service.ts')).includes(`'${s}'`)), true);

// A project row is what project-service stores, plus `access` for a shared one.
const projectRecord = read(path.join(backend, 'services/project-service.ts'));
const recordFields = /export interface ProjectRecord \{([\s\S]*?)\n\}/.exec(projectRecord)[1];
const listRoutes = read(path.join(backend, 'handlers/share-routes.ts'));
const listItemFields = /interface ProjectListItem extends ProjectRecord \{([\s\S]*?)\n\}/.exec(listRoutes)[1];
const listedProject = api.addProject({ lastHtml: '<html></html>', archivedAt: new Date().toISOString() });
api.share(listedProject.projectId, [{ type: 'user', id: 'sub-hanako', label: '佐藤 花子', role: 'edit' }]);
const listed = await ask('GET', '/projects');
check('GET /projects rows carry only ProjectRecord and ProjectListItem fields',
  Object.keys(listed.body.projects[0]).filter((k) => !new RegExp(`\\b${k}\\??:`).test(recordFields + listItemFields)), []);
// listProjects never reads the document; the mock listing one hid the lost-document bug (2026-09-27).
check('and never the document — hasDocument instead, as listProjects answers',
  ['lastHtml' in listed.body.projects[0], listed.body.projects[0].hasDocument, /hasDocument: Boolean\(item\.lastHtmlS3Key/.test(projectRecord)], [false, true, true]);
check('a shared row names who else, with the fields shareMembers gives',
  [listed.body.projects[0].sharedWith, /\.map\(\(g\) => \(\{ type: g\.type, label: g\.label, role: g\.role \}\)\)/.test(read(path.join(backend, 'services/project-shares.ts')))],
  [[{ type: 'user', label: '佐藤 花子', role: 'edit' }], true]);
const created = await ask('POST', '/projects', { name: 'x' });
check('POST /projects answers 201 with the project, as the backend does',
  [created.status, /return jsonResponse\(201, project\)/.test(branch("method === 'POST' && path === '/projects'"))], [201, true]);
const saved = await ask('POST', '/versions', { html: 'x', projectId: 'p' });
check('POST /versions answers 201 with the id and score', [saved.status, Object.keys(saved.body).sort()], [201, ['score', 'versionId']]);

const adminUsage = await ask('GET', '/admin/usage?from=2026-09&to=2026-09');
check('the admin mocks answer', [adminUsage.status], [200]);
check('GET /admin/usage carries only fields the backend sends', missingKeys(adminUsage.body, branch("method === 'GET' && path === '/admin/usage'")), []);
const inventory = /export interface ModelInventory \{([\s\S]*?)\n\}/.exec(read(path.join(backend, 'services/model-inventory.ts')))?.[1] ?? '';
const adminModels = await ask('GET', '/admin/models?from=2026-09&to=2026-09');
check('GET /admin/models carries the inventory, the period and the series, and nothing else',
  Object.keys(adminModels.body).filter((k) => !['period', 'series'].includes(k) && !new RegExp(`\\b${k}\\??:`).test(inventory)), []);

const published = await ask('POST', '/publish', { html: '<html></html>' });
check('POST /publish carries only fields the backend sends', missingKeys(published.body, branch("method === 'POST' && path === '/publish'")), []);

const refineSource = read(path.join(backend, 'orchestration/edit/refine-prompt.ts'));
const refinedFields = /interface RefinedPrompt \{([\s\S]*?)\n\}/.exec(refineSource)?.[1] ?? '';
const refined = await ask('POST', '/refine-prompt', { prompt: '在庫管理' });
check('POST /refine-prompt answers with the RefinedPrompt fields and nothing else',
  Object.keys(refined.body).filter((k) => !new RegExp(`\\b${k}\\??:`).test(refinedFields)), []);

const found = await ask('GET', '/users/search?q=花子');
check('GET /users/search carries only fields the backend sends', missingKeys(found.body, branch("method === 'GET' && path === '/users/search'")), []);
const directory = read(path.join(backend, 'services/user-directory.ts'));
check('and each person the fields the directory returns',
  Object.keys(found.body.users[0]).filter((k) => !new RegExp(`\\b${k}\\b`).test(/return \{ userId: sub, email, name[^}]*\}/.exec(directory)?.[0] ?? '')), []);
const granted = await ask('PUT', '/projects/p/shares', { type: 'user', id: 'sub-hanako', role: 'edit' });
const shareRoutes = read(path.join(backend, 'handlers/share-routes.ts'));
check('PUT /projects/{id}/shares answers with the grants, as the handler does',
  [Object.keys(granted.body), /return respond\(200, \{ shares: grants \}\)/.test(shareRoutes)], [['shares'], true]);
const grantFields = /target: \{ type: input\.type, id: input\.id, label, email \}[\s\S]{0,200}role:[\s\S]{0,200}grantedByName/.test(shareRoutes);
check('and each grant the fields a grant is stored with', grantFields && Object.keys(granted.body.shares[0]).every((k) => ['type', 'id', 'label', 'email', 'role', 'grantedByName', 'grantedAt'].includes(k)), true);

check('nothing the contract asked for went unanswered', api.unhandled, []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
