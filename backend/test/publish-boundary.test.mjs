/**
 * A published page is served from the app's own domain, and that was the bug.
 *
 * `POST /publish` writes whatever the caller sends to
 * `published/<siteId>/index.html`, and CloudFront serves that from the SAME
 * distribution and the SAME domain as the application. So a published document
 * was same-origin with the app:
 *
 *   its inline scripts ran, because the policy carried `script-src
 *     'unsafe-inline'` for the app's own sake;
 *   `localStorage` was the app's, and that is where amazon-cognito-identity-js
 *     keeps the id, access and REFRESH tokens — `cognito.ts` sets no Storage,
 *     so the library's default applies;
 *   `connect-src https://*.amazonaws.com` gave it somewhere to send them.
 *
 * Publishing is a share-this-link feature, so "somebody else opens it" is the
 * intended flow rather than the unlikely one. One user publishing a page and
 * another opening it was an account takeover.
 *
 * `sandbox` without `allow-same-origin` gives the document an opaque origin.
 * Measured against the deployed distribution: `window.origin` is "null",
 * `localStorage` throws SecurityError, `document.cookie` throws, and the page
 * renders its 52 nodes with its three scripts intact.
 *
 * Two smaller things went with it, both the same shape — a public thing with no
 * owner. `/publish` was the only authenticated route with no rate limit of any
 * kind, and nothing recorded WHO published a page, so deleting an account left
 * their pages up for the thirty days the lifecycle rule gives them.
 *
 *   node test/publish-boundary.test.mjs      (from backend/)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const handler = read('src/handlers/lambda-handler.ts');
const sites = read('src/services/published-sites.ts');
const purge = read('src/services/account-purge.ts');
const template = read('../infrastructure/template.yaml');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/** The CSP string of one named response-headers policy in the template. */
function csp(policyName) {
  const at = template.indexOf(`Name: ${policyName}`);
  if (at === -1) return '';
  const line = template.slice(at).match(/ContentSecurityPolicy: [^\n]+/);
  return line ? line[0] : '';
}

// --- the published behaviour has its own policy, and it sandboxes ----------------
{
  const published = csp('makeui-published-sandbox');
  check('published documents have their own header policy', published.length > 0, true);
  check('and are sandboxed', /sandbox /.test(published), true);

  /*
   * The one flag that must NOT be there. `allow-scripts allow-same-origin`
   * together is the same as no sandbox at all — the document keeps the app's
   * origin and everything in its storage.
   */
  check('without the flag that would undo it', /allow-same-origin/.test(published), false);
  check('but with the one that keeps the page working', /allow-scripts/.test(published), true);

  /*
   * `connect-src 'none'` is the exfiltration channel closed. Measured rather
   * than assumed: of twenty-five recent generated documents, none contained a
   * `fetch` or an XMLHttpRequest, and none loaded an external script.
   */
  check('and nowhere to send anything', /connect-src 'none'/.test(published), true);

  /*
   * The host is NAMED, not `'self'`. Under an opaque origin `'self'` no longer
   * reliably matches the domain the document was served from, and one generated
   * document in twenty-five loads an image from `/stock/`.
   */
  check('images are allowed by host, not by self',
    /img-src https:\/\/\$\{PublishedAssetHost\}/.test(published), true);
  check('which comes from a parameter, because the policy cannot ask the distribution',
    /PublishedAssetHost:\n\s+Type: String/.test(template), true);

  // And the app's own policy is untouched: it still needs same-origin everything.
  const app = csp('makeui-security-headers');
  check('the application keeps its own policy', /default-src 'self'/.test(app), true);
  check('and is not sandboxed', /sandbox/.test(app), false);
}

// --- publishing is rated, like everything else that writes ------------------------
{
  const at = handler.indexOf("path === '/publish'");
  const route = handler.slice(at, handler.indexOf('    if (method ===', at + 10));
  check('the publish route exists', route.length > 0, true);
  check('and checks the bucket before writing', /checkRateLimit\(auth\.userId, 'haiku'\)/.test(route), true);
  // An unreadable bucket is not an empty one — the rule every other gate here follows.
  check('an unreadable bucket refuses rather than allows', /rate\.known === false/.test(route), true);
  check('and a full one says how long to wait', /Retry-After/.test(route), true);
}

// --- and a published page has an owner --------------------------------------------
{
  const at = handler.indexOf("path === '/publish'");
  const route = handler.slice(at, handler.indexOf('    if (method ===', at + 10));
  check('the publish is recorded', /recordPublish\(auth\.userId, siteId/.test(route), true);
  /*
   * After the object. A record describing a document that failed to write is
   * worse than no record, because the purge would then chase a key that never
   * existed and report it as swept.
   */
  check('after the document, not before',
    route.indexOf('recordPublish') > route.indexOf('PutObjectCommand'), true);
  /*
   * And its failure does not fail the request: the page IS public by then, so
   * telling the user it did not publish would leave them a live link they
   * believe does not exist.
   */
  check('and a failed record does not fail the publish',
    /Published without a record of who published it/.test(sites), true);

  // The row expires with the object it describes, one day later.
  check('the record lives as long as the page', /RECORD_TTL_DAYS = 31;/.test(sites), true);
}

// --- deleting an account takes its pages down -------------------------------------
{
  /*
   * `published/<siteId>/` is keyed by a random id and by nothing else, so the
   * `PUBLISH#` rows are the only link from a live public page back to its
   * owner. They have to be read BEFORE the partition holding them is purged —
   * afterwards the pages are unreachable from here and stay up.
   */
  check('the purge takes published pages too', /deletePrefix\(`published\/\$\{siteId\}\/`\)/.test(purge), true);
  const readAt = purge.indexOf('publishedSitesOf(userId)');
  const purgeAt = purge.indexOf('purgePartition(pk)');
  check('and reads them before deleting the rows that name them',
    readAt > 0 && readAt < purgeAt, true);
}

// --- the second front door is gone ------------------------------------------------
{
  /*
   * A Function URL with `AuthType: NONE`, CORS `AllowOrigins: ['*']` and
   * `lambda:InvokeFunctionUrl` granted to `*`. Nothing used it — the frontend
   * calls API Gateway — and what it was, was a second entrance to the same
   * handler that bypasses API Gateway and, carrying its own wide-open CORS, the
   * origin allowlist as well. It answered 403 only because an Organizations
   * policy outside this account blocks public Function URLs.
   */
  check('no Lambda Function URL is declared', /AWS::Lambda::Url/.test(template), false);
  check('and nothing is granted InvokeFunctionUrl',
    /Action: lambda:InvokeFunctionUrl/.test(template), false);
  check('with the reason recorded where it stood',
    /a second front door on the same handler/.test(template), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
