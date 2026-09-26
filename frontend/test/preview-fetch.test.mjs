// The project cards' documents, asked for a few at a time and asked again when a
// throttle turned them away.
//
// A week of metrics: every 5xx the API returned was a Lambda throttle, on an
// account with ten concurrent executions, and a card that met one showed
// 「プレビューを生成できませんでした」 until the page was reloaded.
//
//   node test/preview-fetch.test.mjs      (from frontend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/utils/preview/previewFetch.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist-test/preview-fetch.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const pf = await import(pathToFileURL(path.join(root, 'dist-test/preview-fetch.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};
const tick = () => new Promise((r) => setTimeout(r, 0));

// --- a few at a time ----------------------------------------------------------------
{
  const run = pf.createLimiter(3);
  let active = 0, peak = 0;
  const releases = [];
  const task = () => new Promise((resolve) => {
    active += 1; peak = Math.max(peak, active);
    releases.push(() => { active -= 1; resolve('ok'); });
  });
  const all = Promise.all(Array.from({ length: 12 }, () => run(task)));
  await tick();
  check('twelve cards start three requests', active, 3);
  while (releases.length) { releases.shift()(); await tick(); await tick(); }
  check('and every one of them completes', (await all).length, 12);
  check('never more than three at once', peak, 3);
  check('below the account limit of ten', pf.PREVIEW_CONCURRENCY < 10, true);
}

// --- asked again when asking again can work -------------------------------------------
{
  const noSleep = async () => {};
  const direct = (t) => t();
  let calls = 0;
  const throttledTwice = async () => { calls += 1; if (calls < 3) throw new pf.TransientPreviewError('503'); return '<html>'; };
  check('a throttle is retried until it gets through', await pf.fetchPreviewPolitely(throttledTwice, [1, 1], noSleep, direct), '<html>');
  check('in three attempts', calls, 3);

  let tries = 0;
  const alwaysThrottled = async () => { tries += 1; throw new pf.TransientPreviewError('503'); };
  let error = null;
  try { await pf.fetchPreviewPolitely(alwaysThrottled, [1, 1], noSleep, direct); } catch (e) { error = e; }
  check('and gives up after its retries', [tries, error instanceof pf.TransientPreviewError], [3, true]);

  // A definite answer is not asked again: no document is no document.
  let asked = 0;
  check('an empty answer is final', await pf.fetchPreviewPolitely(async () => { asked += 1; return null; }, [1, 1], noSleep, direct), null);
  check('asked once', asked, 1);
  let other = 0;
  try { await pf.fetchPreviewPolitely(async () => { other += 1; throw new Error('bug'); }, [1, 1], noSleep, direct); } catch { /* expected */ }
  check('and neither is an error that is not a transient one', other, 1);

  const slept = [];
  let n = 0;
  await pf.fetchPreviewPolitely(async () => { n += 1; if (n < 3) throw new pf.TransientPreviewError('429'); return 'x'; }, [100, 300], async (ms) => { slept.push(ms); }, direct);
  check('with a pause before each retry', slept, [100, 300]);
}

// --- wired where the cards ask ----------------------------------------------------------
const hook = fs.readFileSync(path.join(root, 'src/hooks/useProjects.ts'), 'utf8');
check('a throttle or a server error is reported as transient', /if \(res\.status === 429 \|\| res\.status >= 500\) throw new TransientPreviewError/.test(hook), true);
check('and so is the network', /catch \{\s*throw new TransientPreviewError\('network'\)/.test(hook), true);
const card = fs.readFileSync(path.join(root, 'src/components/project-list/ProjectThumbnail.tsx'), 'utf8');
check('the card asks through the queue', /fetchPreviewPolitely\(\(\) => fetchHtml\(projectId\)\)/.test(card), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
