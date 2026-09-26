// A repair that is never called is not a repair.
//
// This has happened here before, and it is silent every time: the fixup exists,
// its tests pass, its name reads as covered, and the defect it was written for
// keeps shipping. `fixSvelteLegacyMount` says so in its own comment — it sat
// behind the component test in `fixupFile`, "which is where it was first put,
// and why it did nothing", because the entry file it repairs is a `.ts`.
//
// The same shape nearly recurred while adding the v178 repairs: a fixup written,
// tested against its own input, and only found to be unreachable when it failed
// to fire on the document that prompted it.
//
// So the wiring is asserted rather than assumed. This reads the source rather
// than bundling it, because the question is textual — is this name mentioned
// where the pipeline actually runs — and a bundle would answer a different one.
//
//   node test/wiring.test.mjs      (from backend/)
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { readFixups } from './lib/fixups-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const fixups = readFixups();
const bundle = read('src/tools/project/react-bundle.ts');
const graph = read('src/orchestration/generate/graph.ts');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/**
 * The body of a top-level function, brace-balanced.
 *
 * The opening brace is the last one on the signature line, not the first after
 * the parameters: `fixupFile(...): { body: string; fixed: string[] } {` has the
 * return type's brace in between, and taking that one walks off the end of the
 * function and reports every later definition in the file as "wired". Measured
 * while writing this — the first version passed with everything unwired.
 */
const bodyOf = (source, name) => {
  const at = source.indexOf(`export function ${name}(`);
  if (at < 0) return '';
  const open = source.lastIndexOf('{', source.indexOf('\n', at));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return '';
};

const calls = (haystack, name) => new RegExp(`(?<![\\w$])${name}\\s*\\(`).test(haystack);

// --- every repair is reached ---------------------------------------------------
//
// `fixupFile` and `fixupProject` are the two entry points the pipeline uses, and
// graph.ts runs the last-resort passes — salvage, stub — directly before
// verification. A name mentioned in any of the three is reachable.
const reachable = bodyOf(fixups, 'fixupFile') + bodyOf(fixups, 'fixupProject') + graph;
check('the entry points were found', reachable.length > 5000, true);

const exported = [...fixups.matchAll(/^export function (fix[A-Za-z]+|salvage[A-Za-z]+|stub[A-Za-z]+)/gm)]
  .map((m) => m[1])
  .filter((n) => n !== 'fixupFile' && n !== 'fixupProject');

// Sixteen after the Svelte removal (2026-09-18), where it was thirty-nine.
check('there are repairs to check', exported.length > 10, true);
check('every exported repair is called', exported.filter((n) => !calls(reachable, n)), []);

// --- every detector is reached -------------------------------------------------
//
// A static defect only matters if the graph asks for it. One that is exported
// and never listed reports nothing, forever, with no sign that it is missing.
const detectors = [...bundle.matchAll(/^export function (\w*Defects)\b/gm)].map((m) => m[1]);
check('there are detectors to check', detectors.length > 3, true);
check('every exported detector is used', detectors.filter((n) => !calls(graph, n)), []);

// --- the ledger records what ran, not what was asked for -----------------------
//
// Three different ways of getting this wrong shipped in one file:
//
//   plan/modify      re-derived a name from `input.model` through a helper that
//                    guessed the SSM default for `auto` — while the result had
//                    carried `modelTier`, the resolved tier, all along.
//   generate         wrote `metadata.model`, which is the literal string
//                    'multi-agent-pipeline'. Measured in the live ledger: 345 of
//                    400 sampled rows. The model column was mostly not a model.
//   reverse-engineer chose its tier inside the agent from its argument alone and
//                    consulted no permission at all.
//
// None of it was visible to the compiler — every one of those is a string. So
// the rule is written down here: whatever a `recordUsage` call passes as `model`
// must come from a resolved tier, directly or through one local alias.
/*
 * Comments stripped first. Two of the three mistakes above are NAMED in the
 * comments explaining why they were mistakes, so a check that reads prose finds
 * the very text written to warn about it — and a comment sitting between two
 * arguments also hides the second one from an argument-list match. Crude
 * stripping is fine here: the question is textual, and this file has no string
 * containing a comment opener.
 */
const runner = read('src/handlers/job-runner.ts')
  .replace(/[/][*][\s\S]*?[*][/]/g, '')
  .replace(/[/][/][^\n]*/g, '');

check('the guessing helper is gone', runner.includes('recordedModelName'), false);
/*
 * And the field that fed it. `metadata.model` held the literal
 * 'multi-agent-pipeline' and nothing read it but the ledger write — 361 of the
 * 417 rows there name no model as a result. It is deleted rather than
 * corrected: `metadata.modelTier` has always carried the true answer, and a
 * second field for one question is how the wrong one gets picked.
 */
const graphSrc = read('src/orchestration/generate/graph.ts');
check('the pipeline no longer calls itself a model',
  /model:\s*'multi-agent-pipeline'/.test(graphSrc), false);
check('and the tier it did run is still reported',
  /modelTier:\s*selectedModel[.]tier/.test(graphSrc), true);
// `metadata.model` is a description of the pipeline, not a model name. Its only
// legitimate neighbour here is `metadata.modelTier`, which is a different field.
check("the pipeline's own description is not used as a model name",
  /metadata[?]?[.]model(?![A-Za-z])/.test(runner), false);

/** The `model:` expression of every recordUsage call. */
// Split rather than matched in one pattern: an argument list is not something a
// regex should try to bound. `Math.ceil(reImage.length / 4)` closes a paren
// before `model:` is reached, and the first version of this silently found three
// of the four call sites and reported them all clean.
const modelArgs = runner.split('recordUsage(').slice(1).map((chunk) => {
  const end = chunk.indexOf('});');
  const m = /model:[ ]*([^,\n]+)/.exec(end === -1 ? chunk : chunk.slice(0, end));
  return m ? m[1].trim() : null;
});
/*
 * One per job type the runner handles: plan, modify, and generate as the else.
 *
 * A fixed count rather than a "greater than zero", so the pattern cannot quietly
 * stop matching and leave every assertion below it passing over an empty list.
 * It was four — reverse-engineering was the fourth, and the one that chose its
 * tier inside the agent from its argument alone. That path is gone: a screenshot
 * is now the image on an ordinary generation, so it records usage through the
 * pipeline's own resolved tier like everything else.
 */
check('every job type records usage', modelArgs.length, 3);
check('and each of them names a model', modelArgs.filter((e) => e === null), []);

// A tier, or a local whose initializer is one. One level deep, because that is
// all the file uses and a resolver that walked further would be guessing too.
const fromTier = (expr) => {
  if (/modelTier/.test(expr) || /Tier/.test(expr)) return true;
  const local = expr.replace(/[^A-Za-z0-9_]/g, '');
  if (!local) return false;
  const init = new RegExp('(?:const|let) ' + local + ' =([^;\\n]+)').exec(runner);
  return Boolean(init && (/modelTier/.test(init[1]) || /Tier/.test(init[1])));
};
check('every recorded model comes from a resolved tier',
  modelArgs.filter((e) => !fromTier(e)), []);

// --- the judge asks the critic only when its answer is used ------------------------
/*
 * A rejected candidate is thrown away with everything measured on it, and the
 * critic's findings get no vote while a convergent one exists. So inside the
 * judge the critic is called from one place, which runs before the verdict only
 * when the verdict is taken on the total, and otherwise only once accepted.
 */
{
  const lf = graph.replace(/\r\n/g, '\n');
  const judge = lf.slice(lf.indexOf('const judgeRepair = async'), lf.indexOf("logger.info('Interaction repair rejected', {\n      requestId,\n      pass,\n      kind,\n      reason: broke.length"));
  check('the judge is found', judge.length > 1000, true);
  check('the judge calls the critic from one place', judge.match(/await critiqueScreenshot\(/g)?.length, 1);
  check('and that place is the deferred one',
    /const critiqueCandidate = async[\s\S]*?await critiqueScreenshot\(/.test(judge), true);
  check('asked before the verdict only when nothing convergent decides it',
    /if \(!before\.some\(convergent\)\) await critiqueCandidate\(\)/.test(judge), true);
  check('and after it when the candidate is kept',
    /if \(improved && longEnough && broke\.length === 0\) \{\s*if \(!critiqued\) \{\s*await critiqueCandidate\(\)\s*after = collectDefects\(candidate, afterRuntime, afterVisual\)/.test(judge), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
