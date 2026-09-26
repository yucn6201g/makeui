/**
 * Pictures and data files attached to a plan or an edit, not only to a build.
 *
 * Read from the code on 2026-09-14: an edit was sent only the first of several
 * pictures (the composer cleared the rest), a plan declared `images` and never
 * read it, a lone picture's description was typed and dropped, and both the
 * edit and the plan endpoints validated the data file and then left it out of
 * the job. These pin each of those shut.
 *
 *   node test/supplied-images.test.mjs      (from backend/)
 */
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/orchestration/generate/supplied-images.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/supplied-images.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'pipe', cwd: root }
);
execSync(
  `npx esbuild "${path.join(root, 'src/utils/image-input.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/image-input.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const { prepareSuppliedImages, singleImageCaption } = await import(pathToFileURL(path.join(root, 'dist/supplied-images.test.mjs')).href);
const { imageDirective } = await import(pathToFileURL(path.join(root, 'dist/image-input.test.mjs')).href);
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
};

const PNG = 'data:image/png;base64,' + 'iVBORw0KGgo'.repeat(4);
const reply = (captions, roles) => async () => JSON.stringify({ captions, roles });
let calls = 0;
const counting = (fn) => async (...a) => { calls++; return fn(...a); };

// --- a lone picture's description ------------------------------------------------------------
check('with no list, the first description belongs to the single picture', singleImageCaption(undefined, ['白いマグカップ']), '白いマグカップ');
check('with a list, it belongs to the list', singleImageCaption([PNG, PNG], ['a', 'b']), '');
check('and it is clipped to a caption', singleImageCaption([], ['あ'.repeat(200)]).length, 120);
check('the directive carries what the user said the picture is',
  imageDirective({ format: 'png', mediaType: 'image/png', base64: 'x' }, true, 'ロゴ（ヘッダーに置く）').includes('「ロゴ（ヘッダーに置く）」'), true);
check('and without one the directive is as it was',
  imageDirective({ format: 'png', mediaType: 'image/png', base64: 'x' }, true) === imageDirective({ format: 'png', mediaType: 'image/png', base64: 'x' }, true, ''), true);

{
  calls = 0;
  const one = await prepareSuppliedImages({ image: PNG, imageCaptions: ['製品写真'], prompt: 'この写真を載せて', invoke: counting(reply([], [])) });
  check('a single picture is the reference, with its description', [Boolean(one.reference), one.referenceCaption, one.placeable.length], [true, '製品写真', 0]);
  check('and costs no captioning call', calls, 0);
}

// --- several pictures ------------------------------------------------------------------------
{
  calls = 0;
  const three = await prepareSuppliedImages({
    images: [PNG, PNG, PNG], prompt: '1枚目の配色で、2枚目と3枚目の商品を載せて',
    invoke: counting(reply(['参考のモック', '白いマグカップ', '青いマグカップ'], ['reference', 'content', 'content'])),
  });
  check('several pictures are captioned in one call', calls, 1);
  check('the one the prompt names as a reference is promoted', [Boolean(three.reference), three.referenceCaption], [true, '参考のモック']);
  check('the rest are placed', three.placeable.map((im) => im.caption), ['白いマグカップ', '青いマグカップ']);
  check('and described to the model by marker', /\{\{USER_IMAGE_\d\}\} — 白いマグカップ/.test(three.contentContext), true);
}
{
  calls = 0;
  const described = await prepareSuppliedImages({ images: [PNG, PNG], imageCaptions: ['ロゴ', '店舗外観'], prompt: '載せて', invoke: counting(reply([], [])) });
  check('pictures the user described need no call', [calls, described.placeable.map((im) => im.caption)], [0, ['ロゴ', '店舗外観']]);
}
{
  const kept = await prepareSuppliedImages({
    image: PNG, images: [PNG], prompt: 'この配色で', invoke: reply(['別の参考'], ['reference']),
  });
  check('an explicit reference wins over a promotion, and the other is still placed', [Boolean(kept.reference), kept.placeable.length], [true, 1]);
}
{
  const failed = await prepareSuppliedImages({ images: [PNG], prompt: '載せて', invoke: async () => { throw new Error('boom'); } });
  check('a failed caption still places the picture', failed.placeable.length, 1);
}

// --- wiring: the endpoints forward what they validate ----------------------------------------
const api = read('src/handlers/lambda-handler.ts');
const planRoute = api.slice(api.indexOf("path === '/plan'"), api.indexOf("path === '/modify'"));
const modifyRoute = api.slice(api.indexOf("path === '/modify'"), api.indexOf("path === '/versions'"));
check('the plan job carries the data file', /\.\.\.\(input\.attachment \? \{ attachment: input\.attachment \} : \{\}\)/.test(planRoute), true);
check('and the picture descriptions', /\.\.\.\(input\.imageCaptions \? \{ imageCaptions: input\.imageCaptions \} : \{\}\)/.test(planRoute), true);
check('and validates the picture list it uploads', /validateImages\(input\.images\)/.test(planRoute), true);
check('the edit job carries the data file', /\.\.\.\(input\.attachment \? \{ attachment: input\.attachment \} : \{\}\)/.test(modifyRoute), true);
check('and the pictures, uploaded like the build\'s', /modifyImagesPayload = await uploadContentImages\(jobId, input\.images\)/.test(modifyRoute) && /\.\.\.modifyImagesPayload/.test(modifyRoute), true);
check('and their descriptions', /\.\.\.\(input\.imageCaptions \? \{ imageCaptions: input\.imageCaptions \} : \{\}\)/.test(modifyRoute), true);
check('and validates both', /validateImages\(input\.images\)/.test(modifyRoute) && /validateImageCaptions\(input\.imageCaptions\)/.test(modifyRoute), true);

const runner = read('src/handlers/job-runner.ts');
const modifyJob = runner.slice(runner.indexOf("jobType === 'modify'"), runner.indexOf('const tokenUsage', runner.indexOf("jobType === 'modify'")));
check('the edit runner hands the pictures and descriptions to the edit', /images: await resolveJobImages\(input\)/.test(modifyJob) && /imageCaptions:/.test(modifyJob), true);

// --- wiring: the plan and the edit read them -------------------------------------------------
const graph = read('src/orchestration/generate/graph.ts');
const planSrc = read('src/orchestration/generate/plan.ts');
const plan = planSrc.slice(planSrc.indexOf('async function runPlan('));
check('the plan prepares the pictures', /const supplied = await prepareSuppliedImages\(\{/.test(plan), true);
check('and the design phase is told what to place and what the reference is',
  /imageCaption: supplied\.referenceCaption,\s*contentImages: supplied\.contentContext,/.test(plan), true);
check('a plan for an existing project hears the data file and the pictures too', /dataContext: `\$\{dataContext\}\$\{supplied\.contentContext\}/.test(plan), true);
check('the build passes a lone picture\'s description', /let referenceCaption = singleImageCaption\(images, imageCaptions\)/.test(graph) && /imageCaption: referenceCaption,/.test(graph), true);

const edit = read('src/orchestration/edit/meta-orchestrator.ts');
check('the edit prepares the pictures', /const supplied = await prepareSuppliedImages\(\{/.test(edit), true);
check('the reference is the one the edit sees', /const imageInput = supplied\.reference/.test(edit), true);
check('placed pictures travel in the edit context, so the per-file edit can place them',
  /const dataContext = `\$\{attachmentContext\}\$\{supplied\.contentContext\}/.test(edit), true);
check('and are substituted after every model pass', edit.indexOf('embedContentImages(modifiedHtml, supplied.placeable)') > edit.indexOf('embedUserImage(modifiedHtml, imageInput)'), true);
check('with any marker left standing removed', /stripContentImageTokens\(modifiedHtml\)/.test(edit), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
