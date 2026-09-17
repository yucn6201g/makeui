// A refusal must not be answered by attempting something larger.
//
// Both repair and edit try a cheap per-file path first and fall back to
// rewriting the whole document when it produces nothing. The fallback is roughly
// thirty times the planner call on the repair side and nineteen times the
// per-file edit on the other.
//
// Measured over sixty days: all thirteen whole-document escalations in
// generation were `ThrottlingException: Too many tokens per day`. The account
// had run out of daily tokens, the 3,300-token planner call was refused for it,
// and the pipeline responded by attempting a 113,000-token rewrite. It cannot
// succeed, and on the occasions it does it spends what little is left.
//
// So a refusal is rethrown and the pass stops, while a malformed reply still
// falls back — the two are different facts and only one of them means "try
// something else".
//
// Read from source rather than executed: the property is control flow across
// three modules that between them reach Bedrock, DynamoDB and a browser. What a
// test can check here is that the branch exists and that nothing quietly reverts
// it, which is the failure this had.
//
//   node test/refusal-escalation.test.mjs      (from backend/)
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/*
 * Comments stripped and whitespace flattened. Both matter: the prose explaining
 * this behaviour names every symbol it uses, and a first attempt at this file
 * matched `isModelUnavailable(e) {[^}]*throw e`, which stops at the closing
 * brace of the LOGGER CALL in between and reported the correct code as broken.
 */
const flat = (f) => fs.readFileSync(path.join(root, f), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ')
  .replace(/\s+/g, ' ');

/** Whether `throw e` appears inside the guard, allowing a log line between. */
const rethrows = (src) => {
  const at = src.indexOf('isModelUnavailable(e)');
  if (at === -1) return false;
  // The guard body is short by construction — a log and a throw.
  return src.slice(at, at + 400).includes('throw e');
};

// --- the two planners ------------------------------------------------------------
{
  const repair = flat('src/orchestration/repair-files.ts');
  check('the repair planner recognises a refusal', repair.includes('isModelUnavailable(e)'), true);
  check('and rethrows it rather than returning an empty plan', rethrows(repair), true);
  /*
   * And still falls back on everything else. A model that answered badly is not
   * a model that would not answer, and the whole-document path is the right
   * response to the first.
   */
  check('a malformed reply still returns a plan object', repair.includes("logger.warn('File repair planning failed'"), true);

  const edit = flat('src/orchestration/edit-files.ts');
  check('the edit planner recognises a refusal', edit.includes('isModelUnavailable(e)'), true);
  check('and rethrows it', rethrows(edit), true);
  check('a malformed reply still declines softly', edit.includes("logger.warn('File edit planning failed'"), true);
}

// --- the two callers, which are where the money is spent ---------------------------
{
  /*
   * The edit path is the one that had to change. Its catch logged
   * "falling back to full rewrite" and then did exactly that, for every error
   * including a throttle.
   */
  const meta = flat('src/orchestration/meta-orchestrator.ts');
  check('the edit caller rethrows a refusal instead of rewriting', rethrows(meta), true);
  check('and still falls back otherwise',
    meta.includes("logger.warn('Per-file edit failed — falling back to full rewrite'"), true);

  /*
   * The repair caller needed no change: its pass already sits in a try whose
   * catch breaks the loop, so a throw skips the whole-document call below it.
   * Asserted anyway, because that is load-bearing and reads like an accident.
   */
  const graph = flat('src/orchestration/graph.ts');
  check('the repair caller names a refusal separately in the log',
    graph.includes("logger.warn('Interaction repair refused; the pass stops here'"), true);
  check('and the whole-document repair is inside the same try',
    graph.indexOf('repairProjectByFile(defects)') < graph.indexOf("You repair a generated"), true);
}

// --- what counts as a refusal ------------------------------------------------------
//
// Executed, unlike the above: this one is a pure function.
{
  const { execSync } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  execSync(
    `npx esbuild "${path.join(root, 'src/utils/failure-message.ts')}" --bundle --platform=node ` +
      `--format=esm --outfile="${path.join(root, 'dist/fm.test.mjs')}"`,
    { stdio: 'pipe', cwd: root }
  );
  const { isModelUnavailable } = await import(pathToFileURL(path.join(root, 'dist/fm.test.mjs')).href);

  // The exact message from the thirteen escalations.
  check('the measured throttle is a refusal', isModelUnavailable(Object.assign(
    new Error('Too many tokens per day, please wait before trying again.'),
    { name: 'ThrottlingException' })), true);
  check('so is a plain throttle', isModelUnavailable({ name: 'ThrottlingException', message: '' }), true);
  check('and a service outage', isModelUnavailable({ name: 'ServiceUnavailableException', message: '' }), true);

  /*
   * And these are not. Each of them is a reason to try the other path, which is
   * what the fallback is for — treating them as refusals would turn a recoverable
   * bad reply into a failed edit.
   */
  for (const [name, e] of [
    ['a malformed reply', new SyntaxError('Unexpected non-whitespace character after JSON at position 153')],
    ['a bad request', Object.assign(new Error('max_tokens exceeds the maximum'), { name: 'ValidationException' })],
    ['a model that is not available', Object.assign(
      new Error('anthropic.claude-opus-4-8 is not available for this account'),
      { name: 'AccessDeniedException' })],
  ]) check(`${name} is not a refusal`, isModelUnavailable(e), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
