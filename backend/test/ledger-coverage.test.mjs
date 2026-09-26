/**
 * A model call that reports nothing is spend nobody can see.
 *
 * The ledger's own header describes this defect for the four design specialists
 * — `runDesignSwarm` returned a string, so the graph's usage was discarded
 * inside it — and it was fixed there. It was still open in four other places,
 * all of them found by asking the same question of every call site rather than
 * of the one that was reported:
 *
 *   design-critic     runs AFTER `usageFromStrandsResult(result)` is taken, so
 *                     it was in neither the per-node split, nor the residual,
 *                     nor `unreported`. Its input is the whole assembled
 *                     specification — the largest text a run produces.
 *   change-designer   the modify path's design phase, an agent with tools, so
 *                     several turns. The modify path measured 4 calls and 32k
 *                     tokens at the median with its largest stage missing.
 *   router:classify   one call on every `auto` generation and every edit. Small,
 *                     but "it rounds to nothing" was an assertion, not a reading.
 *   refine-prompt     had the rate limit and the guardrail of a generation, and
 *                     a comment saying it is charged at Haiku. Nothing wrote a
 *                     usage row.
 *
 * The first three land in a run's ledger. The fourth has no ledger to land in —
 * it is one call behind an API route, not a pipeline — so it bills directly.
 *
 * Both halves are asserted here: the specific fixes, and the sweep that found
 * them. The sweep is the part that matters, because the next unreported call
 * will be in a file none of the named cases mention.
 *
 *   node test/ledger-coverage.test.mjs      (from backend/)
 */
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// --- the four that were open --------------------------------------------------
const design = strip(read('src/orchestration/generate/strands-design.ts'));
check('the design critic is billed',
  /recordTokens\([^)]*'design:design-critic'\)/.test(design), true);
// A call that threw may still have spent its input. The total is meant to be a
// floor with a known gap, not a sum that quietly omits one.
check('and a critic that threw is counted as unreported',
  (design.match(/recordUnreportedCall\('design-critic'\)/g) ?? []).length, 2);
check('the change designer is billed',
  /recordTokens\([^)]*'design:change-designer'\)/.test(design), true);
// It carries tools, so one `specifyChange` is several model turns. The
// accumulated figure is the only one that has all of them.
check('from the accumulated usage, which is what covers its tool turns',
  /usageFromStrandsResult\(agentResult\)/.test(design), true);
// Recorded before the length check that throws: a specification too short to
// use was still paid for.
check('and before the guard that can throw the run away',
  design.indexOf('recordTokens(changeUsage.inputTokens')
    < design.indexOf('change specification too short'), true);

const router = strip(read('src/orchestration/generate/workflow-router.ts'));
check('the classifier is billed', /recordTokens\([^)]*'router:classify'\)/.test(router), true);
check('and a failed classification is counted',
  (router.match(/recordUnreportedCall\('router:classify'\)/g) ?? []).length, 2);

const refine = strip(read('src/orchestration/edit/refine-prompt.ts'));
const handler = strip(read('src/handlers/lambda-handler.ts'));
check('prompt refinement reports what it spent', /onUsage\?\.\(\{/.test(refine), true);
/*
 * Before every branch that returns without a suggestion.
 *
 * There are three of them — an unparsable reply, a suggestion identical to the
 * input, an empty one — and all three come after the model has been paid.
 * Reporting from the return value would have charged for the useful answers and
 * given the useless ones away, which is the wrong way round.
 */
check('before the branches that return nothing',
  refine.indexOf('onUsage?.({') < refine.indexOf('Prompt refinement returned nothing usable'), true);
check('and the route writes the usage row', /await recordUsage\(auth\.userId, \{[\s\S]{0,200}model: 'haiku'/.test(handler), true);
check('against the caller group, like every other billed call',
  /refineUsage[\s\S]{0,300}group: auth\.membership\.group/.test(handler), true);

// --- and the stage it lands in is a stage, not a bucket -----------------------
/*
 * Reporting a call is half of it. `invokeText` reported every one of its calls
 * under `meta:invokeText`, so the modify path's largest stage — 65% of six
 * measured edits — covered the edit planner, the per-file writers and the
 * empty-container filler at once, and could not say which. The generate path
 * names the same three jobs separately, which is why its share could be
 * attributed and acted on and the edit path's could not.
 */
const meta = strip(read('src/orchestration/edit/meta-orchestrator.ts'));
check('the text helper takes the stage from its caller',
  /async function invokeText\([^)]*stage = 'meta:invokeText'\)/.test(meta), true);
check('and reports under it', /reportUsage\(body, stage\)/.test(meta), true);
check('every call site names one', [
  ...meta.matchAll(/invokeText\(([^;]*?)\)/g),
].filter((m) => !m[1].includes("'edit:") && !m[1].includes('stage =')).map((m) => m[1].trim()), []);
check('planning and rewriting are not the same stage',
  ["'edit:plan'", "'edit:per-file'", "'edit:fill-empty'"].filter((s) => !meta.includes(s)), []);

// --- the sweep that found them ------------------------------------------------
/**
 * Files that reach a model directly: a raw Bedrock command, or a Strands agent
 * or graph being invoked.
 */
const CALLS = /new InvokeModelCommand\(|new InvokeModelWithResponseStreamCommand\(|new ConverseCommand\(|\.invoke\(brief\)|\.stream\(brief\)/;
/** Any of the three ways a call can be accounted for. */
const REPORTS = /recordTokens\(|recordUnreportedCall\(|onUsage\?\.\(/;

function sources(dir, out = []) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) sources(rel, out);
    else if (e.name.endsWith('.ts')) out.push(rel);
  }
  return out;
}

const callers = sources('src').filter((f) => CALLS.test(strip(read(f))));
// If this ever reads empty the sweep below is vacuous, which is the way a
// source scan fails silently.
check('the sweep found the files that call models', callers.length > 0, true);
check('and every one of them accounts for what it spends',
  callers.filter((f) => !REPORTS.test(strip(read(f)))), []);

// --- the sweep, against sources that are wrong on purpose ---------------------
check('a caller that reports nothing is caught',
  REPORTS.test('const r = await client.send(new InvokeModelCommand({ modelId }))'), false);
check('a caller that reports is not',
  REPORTS.test('const r = await client.send(new InvokeModelCommand({}));\nrecordTokens(1, 2, "x")'), true);
check('an agent invoke counts as a call',
  CALLS.test('const result = await agent.invoke(brief)'), true);
check('and so does a stream', CALLS.test('const it = agent.stream(brief)'), true);
// The comment stripper is what makes the two above mean anything: this file's
// own prose names every symbol it looks for.
check('a call named only in a comment is not a call',
  CALLS.test(strip('// we used to call new InvokeModelCommand( here')), false);
check('nor is a reporting call named only in a comment',
  REPORTS.test(strip('/* recordTokens( is what this should do */')), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
