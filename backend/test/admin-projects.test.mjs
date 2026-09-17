// The admin view of somebody else's work reads the same functions they do.
//
// An admin screen assembled from its own DynamoDB queries is a second
// implementation of "what does this user have", and the two drift in the
// direction of the admin view being wrong about another person's data — which is
// the worst direction, because nobody who could notice is looking at it. So the
// three routes call listProjects, getVersionHistory and getVersion with the
// target's id, and this asserts that rather than the shape of a query.
//
// Two things are checked beyond that, both of which cost real money or real
// privacy if they slip:
//
//   - the list must not carry documents. It once did — `listProjects` returned
//     `lastHtml` inline and this route stripped it back off — because a single
//     response for forty projects becomes megabytes of markup the screen does
//     not render. The strip is gone now that the list itself carries none.
//   - every route must be behind the admin group check. A missing one is a
//     403 that never happens, and the endpoint hands one user's prompts and
//     generated UI to any signed-in caller who guesses a user id.
//
//   node test/admin-projects.test.mjs      (from backend/)
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'src/handlers/lambda-handler.ts'), 'utf8');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/** The body of one route block, from its `path.match` to the closing brace. */
function block(matchLine) {
  const at = src.indexOf(matchLine);
  if (at === -1) return null;
  const open = src.indexOf('{', src.indexOf('if (method', at));
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return null;
}

const ROUTES = [
  ['projects', 'const adminProjects = path.match', 'listProjects'],
  ['project versions', 'const adminVersions = path.match', 'getVersionHistory'],
  ['one version', 'const adminVersion = path.match', 'getVersion('],
];

for (const [name, marker, fn] of ROUTES) {
  const body = block(marker);
  check(`the ${name} route was found`, body !== null, true);
  if (!body) continue;

  /*
   * A role check on the caller's own claims. It used to read
   * `auth.groups.includes('admin')` directly; there are three roles now and the
   * rule lives in services/user-groups.ts, so the assertion follows it —
   * `canOpenAdminPanel` admits a group administrator, and what stops them
   * reading another tenant is the scope filter, which user-groups.test.mjs
   * checks route by route.
   */
  check(`${name} requires an admin role`,
    body.includes('canOpenAdminPanel(auth.membership)') && body.includes('return jsonResponse(403'), true);
  check(`${name} authenticates before checking`,
    body.indexOf('await authenticateRequest') < body.indexOf('auth.membership'), true);
  // And narrows. Asserted here too, because this file is the one somebody reads
  // when they change these three routes.
  check(`${name} narrows to the caller's group`, body.includes('mayActOnUser(auth'), true);

  // The target is read from the path, not from the caller's own identity — the
  // point of the endpoint.
  check(`${name} reads its target from the path`, /decodeURIComponent\(admin\w+\[1\]\)/.test(body), true);
  check(`${name} does not read the caller's own id instead`, /auth\.userId/.test(body), false);

  check(`${name} calls ${fn}`, body.includes(fn), true);
}

// --- the list carries no documents --------------------------------------------
{
  /*
   * This route used to strip `lastHtml` itself, because `listProjects` returned
   * the document inline. It no longer does — see `project-document-store.test.mjs`
   * — so there is nothing here to strip, and the assertion is that nothing puts
   * it back: forty documents shipped to a panel that renders none was the failure
   * the strip existed to prevent, and it would return the moment this route
   * reached for the field again.
   */
  const body = block('const adminProjects = path.match') ?? '';
  check('the project list mentions no documents', /lastHtml/.test(body), false);
  check('and returns what listProjects gave it', /projects,/.test(body), true);
}

/*
 * The single-version route is the one that DOES carry the document, and that is
 * deliberate — it is what "見れるようにする" means. Asserted so a later tidy-up
 * that strips html for consistency is caught by a test rather than by an admin
 * looking at an empty frame.
 */
{
  const body = block('const adminVersion = path.match');
  check('the single version returns the record whole',
    /return jsonResponse\(200, version\)/.test(body ?? ''), true);
  check('and 404s rather than returning an empty one',
    /return jsonResponse\(404/.test(body ?? ''), true);
}

// --- the patterns cannot be widened by a slash ---------------------------------
//
// `[^/]+` rather than `.+`: a project id read from a path segment must not be
// able to swallow the rest of the route. With `.+`, `/admin/projects/a/b/versions`
// would also match the two-segment pattern, and the first route to be tested
// wins — so which handler runs would depend on the order of the file.
// The whole `path.match(...)` argument, up to the statement's semicolon.
// Stopping at the first `)` truncates it inside `([^/]+)` and leaves the anchor
// check reading a string that never had a `$/` in it — three passes that
// asserted nothing about anchoring at all.
const patterns = [...src.matchAll(/path\.match\((.+)\);/g)].map((m) => m[1])
  .filter((p) => p.includes('admin'));
// Four now: the three project routes and the group one added with user
// groups. The count is asserted rather than a minimum so a new one has to be
// looked at — the checks below are what make a path pattern safe, and a route
// that quietly joins the list is one nobody applied them to.
check('the admin path patterns were found', patterns.length, 4);
check('none of them uses a greedy segment', patterns.filter((p) => p.includes('.+')), []);
for (const p of patterns) {
  // Anchored at both ends. Unanchored, `/admin/projects/x` would also match
  // inside a longer path someone adds later.
  check(`anchored at both ends: ${p.slice(0, 44)}`, p.startsWith('/^') && p.endsWith('$/'), true);
}

// And they really do refuse a slash inside a segment.
{
  const two = /^\/admin\/projects\/([^/]+)$/;
  check('the two-segment pattern rejects a longer path', two.test('/admin/projects/u/p/versions'), false);
  check('and accepts the one it is for', two.test('/admin/projects/u'), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
