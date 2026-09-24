// Every endpoint the client calls must be one the server serves.
//
// This is written because it happened. The Design panel shipped calling three
// routes — GET /design-system/systems, POST /design-system/import, and
// DELETE /design-system/systems/:id — that existed nowhere in the handler. The
// importer behind them was written and tested, the store was written and
// tested, and the pipeline that reads a stored system was PROVEN against the
// deployed Runtime. Every part worked. The panel still 404'd on every open,
// because nothing had ever asserted that the parts were connected by an API.
//
// The reason it survived is worth stating, because it is structural rather than
// careless: the probe that proved the pipeline called `saveDesignSystem`
// directly, and the deployed app cannot be logged into from here. The HTTP
// layer was the only layer neither could reach — so it was the only layer that
// turned out not to be there. A test that reads both sides needs no credential,
// which is exactly why it can cover the gap the other two cannot.
//
// Textual on purpose. The question is "does the server mention this path", and
// bundling or invoking would answer a harder question less reliably.
//
//   node test/api-routes.test.mjs      (from backend/)
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = path.resolve(root, '..', 'frontend', 'src');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const sources = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.tsx?$/.test(e.name)) sources.push([path.relative(FRONTEND, p), fs.readFileSync(p, 'utf8')]);
  }
})(FRONTEND);

/**
 * Every `fetch(`${base}/path`, { method })` in the client.
 *
 * Scanned rather than matched in one regex: the paths interpolate too
 * (`${encodeURIComponent(projectId)}`), and a single pattern that tries to hold
 * both the outer template and the inner ones gets one of them wrong.
 *
 * A call with no options object is a GET, which is what fetch does.
 */
/*
 * `fetch(` and the URL literal, with any whitespace allowed between them.
 *
 * It used to require them adjacent, and a call formatted as
 *
 *     await fetch(
 *       `${apiUrl}/admin/projects/${a}/${b}/versions`,
 *
 * was not seen at all. That is the quiet direction: an undetected call is not a
 * failure here, it is one fewer assertion — so wrapping a long URL silently
 * removed a route from the only thing checking that the client and the server
 * agree about it. Found by counting what the scan returned against the three
 * calls that had just been added, and getting two.
 */
const CALL = /fetch\(\s*`\$\{/g;

function clientCalls(file, src) {
  const out = [];
  CALL.lastIndex = 0;
  let match;
  while ((match = CALL.exec(src)) !== null) {
    const i = match.index;
    // Back up two so `close` lands on the brace of this `${`, not a later one.
    const close = src.indexOf('}', i + match[0].length - 2);
    const tick = src.indexOf('`', close);
    if (close === -1 || tick === -1) break;
    // Every interpolated segment becomes one concrete segment. `[^/]+` in a
    // server pattern must match it, and it must not contain a slash.
    /*
     * A trailing interpolation with no slash in front of it is a QUERY STRING,
     * not a path segment — `${apiUrl}/admin/usage${query}` asks for
     * `/admin/usage`, and reading it as `/admin/usagePARAM` reports a route the
     * server does not serve. Every real path parameter is preceded by a slash.
     */
    const route = src.slice(close + 1, tick)
      .replace(/(?<!\/)\$\{[^}]*\}$/, '')
      .replace(/\$\{[^}]*\}/g, 'PARAM');
    const after = src.slice(tick, tick + 240);
    const m = after.match(/method:\s*'([A-Z]+)'/);
    out.push({ file, path: route, method: m ? m[1] : 'GET', line: src.slice(0, i).split('\n').length });
    CALL.lastIndex = tick + 1;
  }
  return out;
}

/**
 * Every route the handler serves, in the three forms it declares them.
 *
 * The regex form (`path.match(/^\/projects\/([^/]+)\/messages$/)`) carries no
 * method on the same line — the methods are branches inside the block — so it
 * is recorded without one and satisfies the path check alone. Guessing at the
 * methods inside a block would invent failures, and the path check is the one
 * that catches a route that is simply not there.
 */
function handlerRoutes(src) {
  const routes = [];
  for (const m of src.matchAll(/method === '([A-Z]+)' && path === '([^']+)'/g)) {
    routes.push({ kind: 'exact', value: m[2], method: m[1] });
  }
  for (const m of src.matchAll(/method === '([A-Z]+)' && path\.startsWith\('([^']+)'\)/g)) {
    routes.push({ kind: 'prefix', value: m[2], method: m[1] });
  }
  const MARK = 'path.match(/';
  let i = 0;
  while ((i = src.indexOf(MARK, i)) !== -1) {
    let j = i + MARK.length, out = '', inClass = false;
    while (j < src.length) {
      // 92 is a backslash: an escaped character, never a delimiter.
      if (src.charCodeAt(j) === 92) { out += src[j] + src[j + 1]; j += 2; continue; }
      // A slash inside a character class is a literal — `[^/]+` is most of what
      // these patterns are made of, and stopping there truncates every one of
      // them into an unterminated class.
      if (src[j] === '[') inClass = true;
      else if (src[j] === ']') inClass = false;
      else if (src[j] === '/' && !inClass) break;
      out += src[j++];
    }
    routes.push({ kind: 'regex', value: out, re: new RegExp(out), method: null });
    i = j + 1;
  }
  return routes;
}

// The main handler, and the routes it hands to `handleShareRoutes` (2026-09-23),
// which are served from the same function and declared in the same forms.
const handler = [
  fs.readFileSync(path.join(root, 'src/handlers/lambda-handler.ts'), 'utf8'),
  fs.readFileSync(path.join(root, 'src/handlers/share-routes.ts'), 'utf8'),
].join('\n');
const routes = handlerRoutes(handler);
const calls = sources.flatMap(([f, s]) => clientCalls(f, s));

// A guard that reads nothing passes for the wrong reason. Both sides are
// asserted to be non-trivial before anything is concluded from them.
check('the handler declares routes', routes.length > 20, true);
check('the client makes calls', calls.length > 20, true);

const hits = (p) => routes.filter((r) =>
  r.kind === 'exact' ? p === r.value : r.kind === 'prefix' ? p.startsWith(r.value) : r.re.test(p));

const unserved = [];
const wrongMethod = [];
for (const c of calls) {
  const matched = hits(c.path);
  if (matched.length === 0) { unserved.push(`${c.method} ${c.path}  (${c.file}:${c.line})`); continue; }
  if (matched.some((r) => r.method === null)) continue;   // regex block: methods live inside it
  if (!matched.some((r) => r.method === c.method)) {
    wrongMethod.push(`${c.method} ${c.path} — served only for ${[...new Set(matched.map((r) => r.method))].join('/')}  (${c.file}:${c.line})`);
  }
}

check('every path the client calls is served', unserved, []);
check('every path is served for the method the client uses', wrongMethod, []);

// Named explicitly, so this file cannot pass on an empty list: if the matcher
// above ever stops recognising the handler's routes, the two assertions before
// this one go green against nothing.
//
// These were the three design-system routes this file was written for. They are
// gone — removed deliberately, along with the panel that called them — and the
// guard did its job by failing when they went. The named set is now the ones the
// client cannot work without, which is the property worth pinning: a route that
// disappears here breaks the app, so a red line is the correct outcome.
for (const [name, p, method] of [
  ['POST /generate', '/generate', 'POST'],
  ['GET /versions', '/versions', 'GET'],
  ['POST /publish', '/publish', 'POST'],
  ['GET /projects', '/projects', 'GET'],
]) {
  check(name, hits(p).some((r) => r.method === method || r.method === null), true);
}

console.log(`\n${pass} passed, ${fail} failed  (${calls.length} client calls, ${routes.length} server routes)`);
process.exit(fail ? 1 : 0);
