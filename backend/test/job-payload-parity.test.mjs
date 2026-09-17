/**
 * A job has two hosts, and they must carry the same job.
 *
 * `runJob` is reached from two places: the AgentCore Runtime's `/invocations`
 * handler, which is the primary target, and the worker Lambda's `__job` branch,
 * which is the fallback for when the Runtime is unreachable. The API builds one
 * payload and sends it to whichever is available.
 *
 * The Runtime handler destructured four of the five fields. `group` was dropped,
 * so every generation that took the healthy path reached `recordUsage` with no
 * group, no `GROUP#<name>/MONTH#<key>` row was ever written, and
 * `checkUsageLimit` read every group's usage as zero. Two groups with limits
 * set, months of traffic, and not one group month row between them.
 *
 * Nothing could have caught it from either side alone: the API was right, the
 * worker was right, the type was right, and the Runtime compiled — a
 * destructuring that omits a field is not an error, it is a smaller
 * destructuring. What was missing is the statement that the two hosts agree.
 *
 * So this reads the fields off `JobRequest` and requires BOTH call sites to pass
 * every one of them. A field added to the interface later fails here until both
 * hosts forward it, which is the direction the bug travelled.
 *
 *   node test/job-payload-parity.test.mjs      (from backend/)
 */
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A Windows checkout has CRLF (autocrlf) while CodeBuild has LF; the patterns
// below say `\n`, so they are matched against LF either way.
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/** The field names declared on `interface JobRequest`, comments and all stripped. */
function jobRequestFields(src) {
  const start = src.indexOf('export interface JobRequest {');
  if (start < 0) return [];
  const body = src.slice(start + 'export interface JobRequest {'.length, src.indexOf('\n}', start));
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const out = [];
  for (const line of clean.split('\n')) {
    const m = /^\s*([A-Za-z_$][\w$]*)\??\s*:/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * The properties of the object literal handed to `runJob(...)`.
 *
 * Shorthand only, which is what both call sites use. A rewrite to
 * `runJob(payload)` would return nothing and fail loudly here rather than
 * quietly passing — the point is to know what is forwarded, and spreading an
 * unvalidated body is a different review.
 */
function runJobFields(src) {
  const m = /runJob\(\{([^}]*)\}/.exec(src);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

const jobRunner = read('src/handlers/job-runner.ts');
const runtime = read('src/handlers/runtime-handler.ts');
const lambda = read('src/handlers/lambda-handler.ts');

const declared = jobRequestFields(jobRunner);
check('the job contract is the five fields the API sends',
  [...declared].sort(), ['group', 'input', 'jobId', 'jobType', 'userId']);

const fromRuntime = runJobFields(runtime);
const fromLambda = runJobFields(lambda);
check('the runtime forwards every one of them',
  declared.filter((f) => !fromRuntime.includes(f)), []);
check('and so does the worker fallback',
  declared.filter((f) => !fromLambda.includes(f)), []);
// Stated both ways: a host forwarding something the contract does not name is
// as much a disagreement as one dropping a field.
check('neither host invents a field', [
  ...fromRuntime.filter((f) => !declared.includes(f)),
  ...fromLambda.filter((f) => !declared.includes(f)),
], []);
check('the two hosts forward the same set',
  [...fromRuntime].sort(), [...fromLambda].sort());

// A forwarded name has to be bound, or it forwards `undefined` — which is
// exactly what the bug did, one step earlier in the same function.
for (const [host, src, where] of [
  ['runtime', runtime, 'const { jobId, userId, group, input, jobType } = payload;'],
  ['worker', lambda, 'const { jobId, userId, group, input, jobType } = event as any;'],
]) {
  check(`the ${host} binds what it forwards`, src.includes(where), true);
}

// --- the extraction itself, against sources that are wrong on purpose --------
/*
 * Without this the file is three greps that pass on any source they cannot
 * parse. Each fixture breaks one property and must be seen to break it.
 */
const GOOD = 'const { jobId, userId, group, input, jobType } = payload;\n'
  + 'const task = runJob({ jobId, userId, group, input, jobType }).finally(() => {});';
const DROPPED = 'const task = runJob({ jobId, userId, input, jobType }).finally(() => {});';
const INVENTED = 'const task = runJob({ jobId, userId, group, input, jobType, tenant });';

check('a correct source reads as complete',
  declared.filter((f) => !runJobFields(GOOD).includes(f)), []);
check('the bug as it was written is detected',
  declared.filter((f) => !runJobFields(DROPPED).includes(f)), ['group']);
check('and an extra field is too',
  runJobFields(INVENTED).filter((f) => !declared.includes(f)), ['tenant']);
check('an unparsable call site reads as empty rather than as passing',
  runJobFields('await runJob(payload)'), []);

// --- and the field is actually used once it arrives ---------------------------
// Forwarding it to a function that ignores it would satisfy everything above.
check('the job runner passes the group on to the usage record',
  /group,\n/.test(jobRunner) && /const \{ jobId, userId, group, input, jobType \} = job/.test(jobRunner), true);
const usage = read('src/services/token-usage.ts');
check('and the usage record writes the group month from it',
  /const groupCommand = usage\.group/.test(usage), true);
check('keyed on the group partition',
  /GROUP#\$\{usage\.group\}[\s\S]{0,60}MONTH#\$\{monthKey\}/.test(usage), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
