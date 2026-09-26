/**
 * The composer refuses what the API would refuse, before the upload.
 *
 * A 2,001-character brief or a 6MB picture used to be sent and come back as an
 * English 400. The values are held equal to the API's by
 * backend/test/client-limits.test.mjs; this holds what the composer does with them.
 *
 *   node test/request-limits.test.mjs      (from frontend/)
 */
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist-test/request-limits.test.mjs');
fs.mkdirSync(path.dirname(out), { recursive: true });
await esbuild.build({ entryPoints: [path.join(root, 'src/utils/requests/requestLimits.ts')], bundle: true, platform: 'node', format: 'esm', outfile: out });
const { promptProblem, oversizedImages, MAX_PROMPT_CHARS, MAX_IMAGE_BYTES } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

check('a brief at the limit is sent', promptProblem('あ'.repeat(MAX_PROMPT_CHARS)), null);
check('one over is refused, in Japanese, with the count', promptProblem('あ'.repeat(MAX_PROMPT_CHARS + 1)), '依頼文は2,000文字までです（現在2,001文字）。');
check('a picture at the limit is kept', oversizedImages([{ name: 'a.png', size: MAX_IMAGE_BYTES }]), []);
check('only the oversized ones are named',
  oversizedImages([{ name: 'a.png', size: 10 }, { name: 'b.jpg', size: MAX_IMAGE_BYTES + 1 }]).map((f) => f.name), ['b.jpg']);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
