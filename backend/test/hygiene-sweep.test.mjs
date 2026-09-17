/**
 * The three that were nobody's emergency, and the one rule that governs them.
 *
 * Each of these is a control that reads as configured and is not, or a quantity
 * nothing bounds. None of them was breaking anything on the day it was found,
 * which is exactly why they had all been there for months.
 *
 *   CORS answered `*`. The code read `ALLOWED_ORIGIN`; template.yaml did not
 *     set it and neither did the deployed function, so the default applied and
 *     the API answered every origin on the web while looking configured.
 *   nothing swept. The routes that MADE orphans are closed now, but the net
 *     under them was a local script nobody had scheduled, and the usage panel
 *     had started hiding ownerless rows — so orphans would stop being listed
 *     rather than stop existing.
 *   the rate limiter charged Sonnet 2 where the price table says 3. A ratio
 *     copied by hand beside a configured one, drifting invisibly because both
 *     numbers stay plausible.
 *   version history had no bound at all. Every generation writes a row and a
 *     document, into the one store with no lifecycle rule — correctly, because
 *     it is history, which is what makes it permanent.
 *
 * The rule under all four: a limit nothing enforces, a ratio nobody rechecks
 * and a sweep nobody runs are all the same defect, which is a control that
 * exists as text.
 *
 *   node test/hygiene-sweep.test.mjs      (from backend/)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const handler = read('src/handlers/lambda-handler.ts');
const purge = read('src/services/account-purge.ts');
const storage = read('src/services/output-storage.ts');
const usage = read('src/services/token-usage.ts');
const limiter = read('src/middleware/rate-limiter.ts');
const versions = read('src/services/version-history.ts');
const template = read('../infrastructure/template.yaml');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- CORS names the origins instead of waving everybody through ------------------
{
  check('the allowed origins are a list', /ALLOWED_ORIGINS = \(process\.env\.ALLOWED_ORIGIN/.test(handler), true);

  /*
   * `Access-Control-Allow-Origin` takes one origin or `*`, never a list, so an
   * allowlist has to answer with the caller's own name — and `Vary: Origin` is
   * what stops a cache handing one origin the header written for another.
   */
  check('and the caller is echoed, not the list', /requestOrigin \?\? '\*'/.test(handler), true);
  check('with Vary once it is not a wildcard', /Vary: 'Origin'/.test(handler), true);

  /*
   * An origin that is not on the list gets NO header rather than a wrong one.
   * The browser then refuses to hand the reply to the page, which is the point.
   */
  check('a stranger gets no header at all', /\.\.\.\(allowed[\s\S]{0,160}: \{\}\)/.test(handler), true);

  /*
   * And the origin is captured at the top of every invocation. A warm container
   * that kept the last request's origin would answer one caller with another's
   * permission, which is the failure mode of putting it in module scope at all.
   */
  const capture = handler.indexOf('requestOrigin = event.headers');
  const firstUse = handler.indexOf('const method = event.requestContext.http.method');
  check('and reset per invocation, before any reply', capture > firstUse, true);

  // The setting exists where it is deployed from, which is the half that was missing.
  // That was the stack until the function left it; now it is the Lambda deploy,
  // which fills it in from the distribution's domain when the function lacks it.
  const lambdaDeploy = read('../infrastructure/deploy-lambda.sh');
  check('the deployment sets it',
    /env\["ALLOWED_ORIGIN"\] = "https:\/\/" \+ os\.environ\["DOMAIN"\]/.test(lambdaDeploy), true);
  check('without overwriting a deliberate value', /if env\.get\("ALLOWED_ORIGIN"\):\n\s+print\(""\)/.test(lambdaDeploy), true);

  /*
   * And the deploy's own check tests the allowlist rather than the header.
   *
   * It sent no Origin and required `Access-Control-Allow-Origin` in the reply,
   * which was only ever true because the setting defaulted to `*` — so the first
   * deploy of a real allowlist failed on a correct response. It now sends an
   * allowed origin and a stranger, and asserts the echo for one and its absence
   * for the other, which is the direction a wildcard would have passed anyway.
   */
  const deploy = read('../infrastructure/deploy-lambda.sh');
  check('the deploy check sends an origin', /headers":\{"origin"/.test(deploy), true);
  check('and asserts the echo, not the presence', deploy.includes('${EXPECT_ECHO}'), true);
  check('and that a stranger is refused one',
    /an origin outside the allowlist was given a CORS header/.test(deploy), true);

  /*
   * And none of that is what a browser gets. The HTTP API had a CorsConfiguration
   * of `*`, and with one set API Gateway answers preflight itself and replaces the
   * function's CORS headers on every reply — so every origin was allowed while the
   * check above passed, because it invokes the function directly. The deploy now
   * compares the API's list with the function's and asks the API over HTTP.
   */
  check('the deploy compares the API origins with the function',
    /CorsConfiguration\.AllowOrigins/.test(deploy) && /API_ORIGINS[^\n]*!=[^\n]*FN_ORIGINS/.test(deploy), true);
  check('and asks through API Gateway, not the function',
    /curl -s -D -/.test(deploy) && /API Gateway gave an origin outside the allowlist a CORS header/.test(deploy), true);
  // The API is outside the stack; its id must not enter the public repository.
  check('looked up by name', /Name=='makeui-api'/.test(deploy), true);

  /*
   * Every method the handler routes is one the preflight allows. PATCH was
   * routed and missing, which only went unnoticed because API Gateway's `*`
   * was answering in the function's place.
   */
  const allowed = (handler.match(/'Access-Control-Allow-Methods': '([^']*)'/) || [, ''])[1].split(/,\s*/);
  const routed = [...new Set([...handler.matchAll(/method === '([A-Z]+)'/g)].map((m) => m[1]))];
  check('the preflight allows every routed method', routed.filter((m) => !allowed.includes(m)), []);
}

// --- something actually runs the sweep -------------------------------------------
{
  check('there is a schedule', /OrphanSweepRule/.test(template) && /ScheduleExpression: 'cron\(/.test(template), true);
  check('it may invoke the function', /Principal: events\.amazonaws\.com/.test(template), true);
  check('and the function answers that shape', /__sweep === true/.test(handler), true);
  /*
   * Before any route is considered. EventBridge sends no `requestContext`, and
   * every path below this reads one.
   */
  const at = handler.indexOf('__sweep === true');
  check('ahead of anything that reads a request', at < handler.indexOf("const method = event.requestContext"), true);
}

// --- and it refuses rather than guesses ------------------------------------------
{
  /*
   * Null and empty must not collapse into each other. An empty pool is "nobody
   * has an account, delete everything"; a failed listing is "I don't know", and
   * both arrive through the same call. This project has shipped that confusion
   * once already, in `getCognitoEmailMap`.
   */
  check('an unreadable directory refuses', /!live \|\| !stored \|\| !projectOwners \|\| !versionOwners/.test(purge), true);
  check('and so does an empty one', /live\.size === 0/.test(purge), true);
  check('the listers return null rather than an empty set on failure',
    /return null;/.test(purge) && /Promise<Set<string> \| null>/.test(storage), true);

  /*
   * Three accounts exist. A run that believes eleven are orphaned has misread
   * the directory, and the difference between those two readings is every
   * project in the account.
   */
  check('too many orphans at once stops it', /MAX_ORPHANS_PER_SWEEP/.test(purge), true);
  check('with a number small enough to mean something', /MAX_ORPHANS_PER_SWEEP = 10;/.test(purge), true);

  /*
   * `outputs/` is not enumerated. Its owners are mostly not accounts —
   * `fw-bench`, `verify-svelte`, `probe-react` — so listing it would present the
   * measurement corpus as forty orphaned users. It is still swept for an owner
   * the other two found, because those objects do belong to a deleted account.
   */
  const sweep = purge.slice(purge.indexOf('export async function sweepOrphans'));
  check('the corpus prefix is not read as a list of users', /ownersUnder\('outputs\//.test(sweep), false);
  check('but is still swept for a real orphan', purge.includes('`outputs/${userId}/`'), true);

  // A dry run exists, because the first thing to do with a destructive schedule
  // is watch it decide without letting it act.
  check('it can be asked without being obeyed', /sweepOrphans\(dryRun = false\)/.test(purge), true);
}

// --- the ladder is the price table's, not a copy of it ---------------------------
{
  check('the request cost is derived, not written', /function modelCosts\(\)/.test(limiter), true);
  check('from the configured prices', /pricingTable\(\)/.test(limiter), true);
  /*
   * Input price, normalised to the cheapest tier. Input rather than a blend:
   * this budget rations REQUESTS and what one will emit is unknown when the gate
   * runs, so the ladder is saying "an Opus run is worth five Haiku runs", which
   * is what the input column already says.
   */
  check('normalised to the cheapest tier', /as number\) \/ cheapest\)/.test(limiter), true);
  // And the hand-written fallback agrees with the table it stands in for.
  check('the fallback matches the real ratio',
    /FALLBACK_COSTS: Record<string, number> = \{ haiku: 1, sonnet: 3, opus: 5 \}/.test(limiter), true);
  check('the stale ladder is gone', /sonnet: 2,/.test(limiter), false);
}

// --- history is bounded, and bounded above where anyone is ------------------------
{
  check('a project keeps a fixed number of versions', /MAX_VERSIONS_PER_PROJECT = 100;/.test(versions), true);
  check('and pruning happens on save', /pruneProjectVersions\(entry\.userId, entry\.projectId\)/.test(versions), true);

  /*
   * After the save and never in its way. The caller's problem is whether this
   * run was recorded; failing that for a tidying error is the trade backwards.
   */
  const saveEnd = versions.indexOf("logger.info('Version saved'");
  check('after it, not before', versions.indexOf('pruneProjectVersions(entry') > saveEnd, true);
  check('and its failure is only logged', /Version pruning failed/.test(versions), true);

  // Newest first, so the count is known without reading the whole partition.
  check('the newest are the ones kept', /ScanIndexForward: false/.test(versions), true);
  // The row before the object, as everywhere else here: a row pointing at a
  // missing document is a blank entry, an object with no row is invisible.
  const prune = versions.slice(versions.indexOf('async function pruneProjectVersions'));
  check('the row goes before the object',
    prune.indexOf('DeleteItemCommand') < prune.indexOf('deleteDocument'), true);
}

// --- one read per account, not two of the same row --------------------------------
{
  /*
   * Both settings live on `USER#<sub>` / `CONFIG`. The listing called a getter
   * for each, which is two GetItems of the SAME item per user: forty accounts,
   * eighty reads to answer what forty would.
   *
   * The two getters keep their own reads. `/usage` reads the model set
   * separately on purpose, so that failing to read it refuses on its own rather
   * than riding on the limit's success — that redundancy is deliberate and
   * documented, and only the listing was wrong.
   */
  check('the listing batches the configuration', /readUserConfigs\(userIds\)/.test(usage), true);
  check('through BatchGetItem', /new BatchGetItemCommand/.test(usage), true);
  check('and no longer calls a getter per account',
    /userIds\.map\(id => getUserTokenLimit\(id\)\)/.test(usage), false);
  /*
   * And the permission it needs exists where the role is defined.
   *
   * It did not, and the failure is the worst shape available: the catch leaves
   * every entry unread, the listing substitutes the defaults, and an
   * administrator sees 「無制限」 over people who are capped — one
   * `AccessDeniedException` in the log and a panel that looks fine. Asserted
   * here because a new API call needs a new grant and nothing else says so.
   */
  const infra = read('../infrastructure/template.yaml');
  check('the role may make that call', /- dynamodb:BatchGetItem/.test(infra), true);

  // Unread keys are null, never a default — the rule the whole file works to.
  check('keys it could not read stay unknown', /UnprocessedKeys/.test(usage), true);
  check('while a key with no row is unset, which is an answer',
    /!found\.has\(id\) && !pending\.has\(id\)/.test(usage), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
