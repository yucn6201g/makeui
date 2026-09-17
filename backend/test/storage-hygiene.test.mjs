/**
 * Four ways stored data was outliving the thing it belonged to.
 *
 * Found by scanning the production table and bucket on 2026-09-05 and comparing
 * what is stored against what any code path can still reach:
 *
 *   - 151 version rows held their document inline, 8.0MB of an 11.4MB table.
 *     A Query is billed on the size of the items it processes, so a history
 *     panel asking for 20 rows of metadata was billed 119 RCU for one account
 *     and the per-project branch 450 RCU for one page.
 *   - 71 documents sat in `versions/` with no row pointing at them, 27 of them
 *     written in one minute on 2026-09-02 when the row write was throttled and
 *     the object it had already put was left behind.
 *   - 70 of the 93 stored chat threads belonged to projects that had been
 *     deleted. Keyed by project id, so nothing could ever open them again.
 *   - 45 job records had no `ttl` and dated back to 2026-08-07, because every
 *     writer but `createJob` is an `UpdateItem` — which creates the item when it
 *     is absent, without one.
 *
 * Source-read: each of these is a property of one write or one query, and that
 * is the thing that was missing.
 *
 *   node test/storage-hygiene.test.mjs      (from backend/)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

const versions = strip(read('src/services/version-history.ts'));
const projects = strip(read('src/services/project-service.ts'));
const chat = strip(read('src/services/chat-history.ts'));
const jobs = strip(read('src/services/job-service.ts'));
const audit = strip(read('scripts/storage-audit.mjs'));

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/** One exported function's body, bounded by the next top-level `export`. */
function bodyOf(src, name) {
  const at = src.search(new RegExp(`export (async )?function ${name}\\(`));
  if (at < 0) return '';
  const end = src.indexOf('\nexport ', at + 1);
  return src.slice(at, end < 0 ? src.length : end);
}

// --- a version document is not left behind when its row fails -----------------------
{
  const body = bodyOf(versions, 'saveVersion');
  check('saveVersion was found', body.length > 0, true);
  check('it still writes the document first', body.indexOf('putDocument') < body.indexOf('PutItemCommand'), true);

  /*
   * The row write is inside a try. Asserted by position rather than by the word
   * `try` appearing anywhere in the function, which a try around something else
   * would satisfy.
   */
  const send = body.indexOf('await client.send(command)');
  const tryAt = body.lastIndexOf('try {', send);
  check('the row write is guarded', tryAt > 0 && tryAt < send, true);

  const rest = body.slice(send);
  check('a failure deletes the object', /deleteDocument\(htmlS3Key\)/.test(rest), true);
  check('and the original error still reaches the caller', /throw error;/.test(rest), true);
  /*
   * The tidy-up must not become the error the caller sees. Losing a version is
   * the caller's problem; failing to delete an object they never knew about is
   * not, and reporting the second hides the first.
   */
  check('the delete cannot mask it', /deleteDocument\(htmlS3Key\)\.catch\(/.test(rest), true);
}

// --- the history query asks for metadata --------------------------------------------
{
  const body = bodyOf(versions, 'getVersionHistory');
  check('getVersionHistory was found', body.length > 0, true);
  check('it declares a projection', /const PROJECTION = \[/.test(body), true);
  check('which does not include the document', /'html'/.test(body.slice(0, body.indexOf('mapItem'))), false);

  /*
   * BOTH queries. The per-project one is the expensive branch — it reads pages of
   * 100 and filters afterwards — so a projection on the other alone would fix the
   * cheaper half.
   */
  const uses = [...body.matchAll(/ProjectionExpression: PROJECTION/g)].length;
  const queries = [...body.matchAll(/new QueryCommand\(/g)].length;
  check('every query in it is projected', [uses, queries], [2, 2]);

  /*
   * And the expensive branch is bounded.
   *
   * The filter runs AFTER the read, so a project with FEWER versions than the
   * limit never satisfies the early exit: unbounded, it reads the user's entire
   * VERSION# partition a hundred rows at a time, on one partition key, billed on
   * the items processed BEFORE the filter — and the older rows still carry their
   * document inline. The cheapest question in the product was the most expensive
   * one to answer.
   *
   * `getVersion` below it has had this cap since it was written, which is what
   * makes the omission a slip rather than a decision.
   */
  check('the paging loop has a cap', /pagesScanned < MAX_PAGES/.test(body), true);
  check('and counts the pages it read', /pagesScanned\+\+/.test(body), true);
  check('and says when it stopped short', /stopped at the page cap/.test(body), true);
  // A thousand rows against 345 in the whole table: the cap is a bound on a
  // pathological case, not a limit anyone reaches.
  const cap = Number(/MAX_PAGES = (\d+)/.exec(body)?.[1]);
  check('the cap is generous', cap >= 10, true);
}

// --- deleting a project deletes its conversation ---------------------------------------
{
  const body = bodyOf(projects, 'deleteProject');
  check('deleteProject was found', body.length > 0, true);
  check('it removes the row', /DeleteItemCommand/.test(body), true);
  check('and the S3 document', /deleteDocument\(projectDocumentKey/.test(body), true);
  check('and the chat thread', /deleteChatMessages\(userId, projectId\)/.test(body), true);
  /*
   * Best-effort, because the project is already gone by then: raising here would
   * report a failed delete for a delete that happened.
   */
  check('a chat failure does not fail the delete', /deleteChatMessages\(userId, projectId\)\.catch\(/.test(body), true);

  check('the function it calls exists', /export async function deleteChatMessages/.test(chat), true);
  const del = bodyOf(chat, 'deleteChatMessages');
  check('and is keyed by project', del.includes('CHAT#') && del.includes('projectId'), true);
  check('and it deletes rather than blanking', /DeleteItemCommand/.test(del), true);

  check('and the versions recorded against it', /deleteProjectVersions\(userId, projectId\)/.test(body), true);
  check('a version failure does not fail the delete', /deleteProjectVersions\(userId, projectId\)\.catch\(/.test(body), true);
}

// --- and only the versions that belong to it -----------------------------------------
{
  const body = bodyOf(versions, 'deleteProjectVersions');
  check('deleteProjectVersions was found', body.length > 0, true);

  /*
   * Narrowed by projectId. Without the filter this deletes the user's whole
   * history, and 280 of the 701 stored versions carry no projectId at all —
   * they predate projects, the global history panel is the only thing that lists
   * them, and nothing the user deleted could have contained them.
   */
  check('it filters by project', /FilterExpression: 'projectId = :pid'/.test(body), true);
  check('and by owner', body.includes('USER#${userId}'), true);
  check('it reads only what it needs', /ProjectionExpression: 'sk, htmlS3Key'/.test(body), true);
  check('and pages to the end', /LastEvaluatedKey/.test(body), true);

  /*
   * Row first, then the object. The other order leaves a surviving row pointing
   * at a deleted document — a version that opens blank with nothing to explain
   * it. An object outliving its row by a moment is swept by the audit.
   */
  const rowAt = body.indexOf('DeleteItemCommand');
  const objAt = body.indexOf('deleteDocument(');
  check('the row goes before the document', rowAt > 0 && rowAt < objAt, true);
}

// --- the dependency runs one way ------------------------------------------------------
{
  /*
   * `project-service` deletes versions, so `version-history` must not reach back
   * for the project store. `getLatestProjectHtml` used to live there and was the
   * only reason it did; moving it is what makes the delete safe to import.
   */
  check('version-history does not import the project store',
    /from '\.\/project-service/.test(versions), false);
  check('and getLatestProjectHtml lives with the projects now',
    /export async function getLatestProjectHtml/.test(projects), true);
}

// --- the purge deletes only what nothing reads ------------------------------------------
{
  check('purging is opt-in', /--purge/.test(audit), true);
  check('and separate from reporting', /const PURGE = process\.argv\.includes/.test(audit), true);

  /*
   * A version with no projectId belongs to no project and cannot have been
   * deleted with one. The purge must select on the field being present.
   */
  check('unattributed versions are excluded by the selector',
    /versions\.filter\(\(v\) => v\.projectId\?\.S && !live\.has/.test(audit), true);

  /*
   * Liveness is keyed by owner as well as by project id, so one account's row
   * can never vouch for — or condemn — another's.
   */
  const keys = [...audit.matchAll(/live\.has\(`\$\{[a-z]\.pk\?\.S\}\|/g)].length;
  check('liveness is keyed by owner too', keys, 2);

  /*
   * And a row pointing at a missing object is reported, never acted on: that is
   * a version that opens blank, and deleting the row would destroy the only
   * record that it existed.
   */
  const danglingAt = audit.indexOf('dangling');
  check('dangling rows are reported', danglingAt > 0, true);
  check('and never deleted', /dangling[\s\S]{0,400}DeleteItemCommand/.test(audit), false);
}

// --- every job writer stamps a ttl -------------------------------------------------------
{
  check('the lifetime has one definition', /const JOB_TTL_SECONDS = \d+/.test(jobs), true);
  check('and one way to compute the stamp', /const jobTtl = \(\)/.test(jobs), true);

  /*
   * The count is what matters: `UpdateItem` creates the item when it is absent,
   * so a writer without a ttl is a writer that can mint an immortal row. Every
   * command that touches a JOB item has to stamp one.
   */
  const writers = [...jobs.matchAll(/new (Put|Update)ItemCommand\(/g)].length;
  const stamps = [...jobs.matchAll(/jobTtl\(\)/g)].length;
  check('every writer stamps it', [stamps, writers], [writers, writers]);

  /*
   * `ttl` is a DynamoDB reserved word, so an update expression naming it
   * directly is rejected at runtime — the alias is not style.
   */
  const updates = [...jobs.matchAll(/UpdateExpression:[\s\S]{0,200}?ttl/g)].map((m) => m[0]);
  check('the update expressions alias it', updates.filter((u) => !u.includes('#ttl')), []);
  check('and declare the alias', [...jobs.matchAll(/'#ttl': 'ttl'/g)].length, 3);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
