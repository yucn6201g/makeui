/**
 * The prices come from AWS, and from the row this project actually runs.
 *
 * They were typed in by hand once, off the pricing page, which is a number in a
 * shell history ageing silently. `fetch-model-pricing.mjs` reads them instead —
 * but a scraper is only worth having if it cannot quietly read the wrong cell,
 * and there are two ways it could:
 *
 *   the wrong ROW      `sonnet` resolves to Claude Sonnet 4.6, and the page also
 *                      lists Sonnet 5 at two thirds of the price. The tier map
 *                      comes from the same SSM parameters the runtime reads, so
 *                      the table cannot drift from what is invoked.
 *   the wrong COLUMN   the page carries on-demand, batch, two cache-write
 *                      windows and cache read. Counting cells reads the batch
 *                      price as the on-demand one — half, with nothing to show
 *                      for it — so columns are matched by header text.
 *
 * Source-read, and offline: the assertions are about how the script decides,
 * which is the part that goes wrong. Whether AWS is reachable today is not a
 * property of this repository.
 *
 *   node test/pricing-source.test.mjs      (from backend/)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const script = read('scripts/fetch-model-pricing.mjs');
const setter = read('scripts/set-model-pricing.sh');
const deploy = fs.readFileSync(path.join(root, '..', 'infrastructure/deploy-runtime.sh'), 'utf8');
const pricing = read('src/config/pricing.ts');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- the row is the one the runtime invokes ------------------------------------------
{
  check('the tiers come from SSM', /ssm', 'get-parameters'/.test(script), true);
  check('the same parameters the runtime reads',
    ['/makeui/models/haiku', '/makeui/models/sonnet', '/makeui/models/opus']
      .filter((p) => !script.includes(p)), []);

  /*
   * Every word of the model id has to appear in the row name, so
   * `claude-sonnet-4-6` cannot match "Claude Sonnet 4.5"; and the shortest
   * matching row wins, so it cannot match a longer name that contains it.
   */
  check('every word must match', /words\.every\(/.test(script), true);
  check('and the shortest row wins', /sort\(\(a, b\) => a\.name\.length - b\.name\.length\)/.test(script), true);
  check('no match is a warning, not a guess', /no row on the page matches/.test(script), true);
}

// --- the column is matched by its header ------------------------------------------------
{
  const cols = /const COLUMNS = \{([\s\S]*?)\n\};/.exec(script)?.[1] ?? '';
  check('the column map was found', cols.length > 0, true);
  check('all four kinds are mapped',
    ['input:', 'output:', 'cacheWrite:', 'cacheRead:'].filter((k) => !cols.includes(k)), []);
  check('by header text', /row\.headers\.findIndex\(\(h\) => header\.test\(h\)\)/.test(script), true);
  check('and a missing column is reported rather than skipped',
    /no column matching/.test(script), true);

  /*
   * The five-minute window, because `prompt-cache.ts` sends
   * `cache_control: { type: 'ephemeral' }` with no ttl. Reading the one-hour
   * column would overstate every cached run.
   */
  check('the cache-write column is the 5m one', /5m cache write/.test(cols), true);
  check('and not the 1h one', /1h cache write/.test(cols), false);
  const cache = read('src/orchestration/prompt-cache.ts');
  check('which is what the code actually asks for',
    /cache_control: \{ type: 'ephemeral' \}/.test(cache) && !/ttl/.test(cache), true);

  // A tier the script could only half read is left out rather than half priced.
  check('a partly read tier is dropped', /could be read — left out/.test(script), true);
  check('and nothing priced at all is an error', /No tier could be priced/.test(script), true);
}

// --- where the table is kept ---------------------------------------------------------------
{
  /*
   * SSM, beside the model ids and the preset prefixes. Not the repository:
   * prices change, and a committed number is one nobody re-checks.
   */
  check('the setter writes SSM', /ssm put-parameter --name "\$\{PARAM\}"/.test(setter), true);
  check('at the project\'s own path', /\/makeui\/pricing\/models/.test(setter), true);
  check('and the Lambda directly', /lambda update-function-configuration/.test(setter), true);

  /*
   * Not the Runtime. `update-agent-runtime` replaces the whole configuration,
   * so only deploy-runtime.sh — which reads the live config back and re-applies
   * it — may write there.
   */
  // The comment says the word; what matters is that nothing calls it. Stripped
  // of comments so the explanation cannot fail the assertion it explains.
  const code = setter.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  check('the setter does not touch the runtime', /update-agent-runtime/.test(code), false);
  check('the deploy script reads the parameter', /\/makeui\/pricing\/models/.test(deploy), true);
  /*
   * And there the parameter WINS over the live value, unlike REQUIRED_ENV: the
   * reason for keeping it in SSM is that a change made between deploys arrives.
   */
  check('where it overrides the live value', /env\["MODEL_PRICING"\]=os\.environ\["PRICING"\]/.test(deploy), true);
  check('but an unset parameter changes nothing', /carrying forward whatever the runtime has/.test(deploy), true);

  // No prices in the repository, which is the whole arrangement.
  const numbers = /"(input|output|cacheRead|cacheWrite)":\s*[1-9]/;
  check('no price is committed in the reader', numbers.test(pricing.replace(/\/\*[\s\S]*?\*\//g, '')), false);
  check('nor in the fetcher', numbers.test(script.replace(/\/\*[\s\S]*?\*\//g, '')), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
