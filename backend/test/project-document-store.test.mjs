/**
 * The project row does not carry the document.
 *
 * It used to, inline, purely so the project list could draw a thumbnail without
 * an S3 read per card — while the same write already put the authoritative copy
 * in S3. The row therefore held a duplicate of an object that always exists, and
 * paid for it twice:
 *
 *   - to write: DynamoDB bills a WCU per KB, so the median project write was 86
 *     WCU against 1 without it, and on 2026-09-02 sixty-five hand edits were
 *     lost inside one minute to a throughput burst on exactly this write;
 *   - to read: one account's `GET /projects` transferred 992KB for ten projects,
 *     of which 4KB was the projects.
 *
 * Source-read rather than executed: what is asserted is which attributes a write
 * names and which a read asks for, and both are string expressions built in the
 * service. A behavioural test would need a DynamoDB and would still be reading
 * these same strings back.
 *
 *   node test/project-document-store.test.mjs      (from backend/)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'src/services/project-service.ts'), 'utf8');
const handler = fs.readFileSync(path.join(root, 'src/handlers/lambda-handler.ts'), 'utf8');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/** The file with comments and template literals' contents left alone. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

/**
 * The body of one exported function, bounded by the next `export ` at column 0.
 * Crude, and correct here because every function in this file is exported and
 * top-level — a windowed slice would run past the end and read the next one's
 * assertions as this one's, which is how an earlier scope test in this suite
 * passed while the thing it guarded had been deleted.
 */
function bodyOf(name) {
  const at = code.indexOf(`export async function ${name}(`);
  if (at < 0) return '';
  const end = code.indexOf('\nexport ', at + 1);
  return code.slice(at, end < 0 ? code.length : end);
}

// --- nothing writes it ------------------------------------------------------------
for (const fn of ['updateProject', 'recordProjectRun']) {
  const body = bodyOf(fn);
  check(`${fn} was found`, body.length > 0, true);

  /*
   * `lastHtml = :...` is the shape of an assignment in an UpdateExpression. The
   * S3 key assignment is a different attribute and must still be there — a test
   * that only banned the write would pass on a function that stored nothing at
   * all.
   */
  check(`${fn} does not assign lastHtml`, /lastHtml\s*=\s*:/.test(body), false);
  check(`${fn} still assigns the S3 key`, /lastHtmlS3Key\s*=\s*:/.test(body), true);
  check(`${fn} still writes the document to S3`, /putDocument\(/.test(body), true);

  /*
   * And removes it, so a row written before this sheds its copy on the next
   * save rather than carrying it forever.
   */
  check(`${fn} removes any copy left over`, /drop\.push\('lastHtml'\)/.test(body), true);
  check(`${fn} puts the removals in the expression`, /REMOVE \$\{/.test(body), true);
}

// --- the list does not read it ----------------------------------------------------
{
  const body = bodyOf('listProjects');
  check('listProjects names the attributes it wants', /ProjectionExpression/.test(body), true);
  check('and lastHtml is not among them', /'lastHtml'/.test(body), false);
  check('while the S3 key is', /'lastHtmlS3Key'/.test(body), true);
  check('it answers hasDocument instead', /hasDocument:/.test(body), true);
  check('and never populates lastHtml', /lastHtml:/.test(body), false);
}

// --- opening one project still finds a document -----------------------------------
{
  const body = bodyOf('getProject');
  check('getProject reads S3', /readDocument\(item\.lastHtmlS3Key\.S\)/.test(body), true);
  /*
   * The inline copy is still read, and second. Eleven rows had one and no S3 key
   * until `scripts/backfill-project-s3.mjs` ran; dropping the fallback would have
   * opened all eleven blank. Second because where both exist the inline one is
   * now always the older.
   */
  const s3At = body.indexOf('readDocument(item.lastHtmlS3Key.S)');
  const inlineAt = body.indexOf('item.lastHtml?.S');
  check('the inline copy is still a fallback', inlineAt > 0, true);
  check('and it is consulted second', s3At < inlineAt, true);
}

// --- the admin list is the same list ----------------------------------------------
{
  /*
   * It used to strip `lastHtml` itself. That strip is gone because there is
   * nothing to strip — but if the list ever started carrying the document again,
   * this route would ship forty of them to the admin panel, which renders none.
   */
  check('the admin route does not re-add it', /lastHtml, \.\.\.rest/.test(handler), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
