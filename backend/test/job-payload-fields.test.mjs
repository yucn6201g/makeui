/**
 * Every field a job reads is a field its endpoint forwards.
 *
 * Three times now an endpoint validated a field and then built the job payload
 * without it: `/modify` with the attached image (fixed before 2026-09), and on
 * 2026-09-14 `/modify` with the data file and `/plan` with the data file and the
 * picture descriptions. Each time the job runner read the field, found nothing,
 * and the request ran as if nothing had been attached — no error anywhere,
 * because an absent attachment is a valid request.
 *
 * Fixing them one at a time is how the third one happened, so this reads the
 * class: for each job type, the `input.` fields the runner reads, against the
 * fields the matching route puts in the payload.
 *
 *   node test/job-payload-fields.test.mjs      (from backend/)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const runner = read('src/handlers/job-runner.ts');
const api = read('src/handlers/lambda-handler.ts');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
};

/** The runner's helpers read these on the job's behalf; each is also sent as an S3 key. */
const HELPERS = { resolveJobHtml: 'html', resolveJobImage: 'image', resolveJobImages: 'images', jobAttachment: 'attachment' };
/** Fields only a direct Runtime invocation may carry; the API strips them on purpose. */
const RUNTIME_ONLY = new Set(['experiment']);

function fieldsRead(block) {
  const names = new Set([...block.matchAll(/\binput\.([a-zA-Z0-9]+)/g)].map((m) => m[1]));
  for (const [helper, field] of Object.entries(HELPERS)) if (block.includes(`${helper}(input)`)) names.add(field);
  for (const n of [...names]) if (/S3Key$/.test(n)) names.delete(n);
  for (const n of RUNTIME_ONLY) names.delete(n);
  return [...names].sort();
}

const planStart = runner.indexOf("if (jobType === 'plan')");
const modifyStart = runner.indexOf("} else if (jobType === 'modify')");
const generateStart = runner.indexOf('} else {', modifyStart);
const generateEnd = runner.indexOf('} catch', generateStart);
const jobs = {
  plan: fieldsRead(runner.slice(planStart, modifyStart)),
  modify: fieldsRead(runner.slice(modifyStart, generateStart)),
  generate: fieldsRead(runner.slice(generateStart, generateEnd)),
};
check('the runner blocks were found', Object.values(jobs).every((f) => f.length >= 5), true);

/** The route's own source, from its path test to the next route. */
function route(p) {
  const at = api.indexOf(`path === '${p}'`);
  const next = api.indexOf("if (method === ", at + 10);
  return api.slice(at, next);
}

/**
 * What a route puts in the job's `input`.
 *
 * Named keys, conditional spreads of `input.x`, the upload payloads (which carry
 * a field or its S3 key), and — for the route that spreads the request body —
 * everything except what it destructured out first.
 */
function forwarded(src) {
  const at = src.lastIndexOf('input: {');
  const body = src.slice(at, src.indexOf('\n        },', at) > 0 && src.indexOf('\n        },', at) < src.indexOf('dispatchJob', at)
    ? src.indexOf('\n        },', at) : src.indexOf('},', at));
  const names = new Set();
  for (const m of body.matchAll(/\b([a-zA-Z]+):\s*(?:input\.|finalInstruction|instruction\b)/g)) names.add(m[1]);
  for (const m of body.matchAll(/\{\s*([a-zA-Z]+):\s*input\.\1\s*\}/g)) names.add(m[1]);
  if (/\.\.\.htmlForPayload/.test(body)) names.add('html');
  if (/\.\.\.(?:planImagePayload|modifyImagePayload|imageForPayload)\b/.test(body)) names.add('image');
  if (/\.\.\.(?:planImagesPayload|modifyImagesPayload|imagesForPayload)\b/.test(body)) names.add('images');
  // A shared project's owner and the actor's name, set by the route from its access check.
  if (/\.\.\.projectOwner\b/.test(body)) { names.add('projectOwnerId'); names.add('actorName'); }
  const spread = /\.\.\.inputWithoutImage/.test(body);
  const stripped = spread
    ? [...(/const \{([^}]*)\.\.\.inputWithoutImage \}/.exec(src)?.[1] ?? '').matchAll(/([a-zA-Z]+):/g)].map((m) => m[1])
    : [];
  return { names, spread, stripped };
}

for (const [job, p] of [['plan', '/plan'], ['modify', '/modify'], ['generate', '/generate']]) {
  const f = forwarded(route(p));
  const missing = jobs[job].filter((name) => {
    if (f.names.has(name)) return false;
    // A spread body forwards everything the client sent, except what it took out first —
    // and what it took out must come back through an upload payload.
    if (f.spread && !f.stripped.includes(name)) return false;
    return true;
  });
  check(`every field the ${job} job reads is forwarded by ${p}`, missing, []);
}

// --- and the edge's own validators name fields that must travel ------------------------------
for (const p of ['/plan', '/modify', '/generate']) {
  const src = route(p);
  const f = forwarded(src);
  const validated = [...src.matchAll(/validate(?:Image|Images|ImageCaptions|Attachment)\((?:\(input as [^)]*\)|input)\.([a-zA-Z]+)\)/g)].map((m) => m[1]);
  const dropped = [...new Set(validated)].filter((n) => !f.names.has(n) && !(f.spread && !f.stripped.includes(n)));
  check(`${p} forwards every attachment field it validates`, dropped, []);
}

// --- the check can fail ------------------------------------------------------------------------
{
  // The 2026-09-14 /plan payload, before the fix.
  const before = "path === '/plan' input: { ...htmlForPayload, ...planImagePayload, ...planImagesPayload, prompt: input.prompt, preset: input.preset, model: input.model, outputKind: input.outputKind },\n      });\n dispatchJob";
  const f = forwarded(before);
  check('the pre-fix plan payload is read as missing the data file and descriptions',
    jobs.plan.filter((n) => !f.names.has(n)), ['attachment', 'imageCaptions']);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
