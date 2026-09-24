// Reading one version back, through a project.
//
// GET /versions/:id?projectId refuses a version that belongs to another
// project, and compares `version.projectId` with the one asked for. getVersion
// did not return `projectId` at all, so the comparison was always unequal and
// every version was refused: the version comparison showed 「読み込みに失敗しました」
// on both sides, and choosing an older version from the menu failed the same
// way (reported 2026-09-24, broken since the sharing change of 2026-09-23).
//
// Nothing caught it because the two halves were only ever checked apart — the
// handler's refusal was asserted as text, and the stubbed API in the screen
// harness answered /versions/:id without looking at the project. So this runs
// the real getVersion over a stubbed DynamoDB and puts its answer through the
// handler's own condition.
//
//   node test/version-read.test.mjs      (from backend/)
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist/version-read.test.mjs');
await esbuild.build({
  entryPoints: [path.join(root, 'src/services/version-history.ts')], bundle: true, platform: 'node', format: 'esm',
  outfile: out, logLevel: 'error', external: ['@aws-sdk/client-s3', '@smithy/*'],
  plugins: [{
    name: 'stub-dynamodb',
    setup(b) {
      b.onResolve({ filter: /^@aws-sdk\/client-dynamodb$/ }, () => ({ path: 'ddb', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: `
          export class DynamoDBClient { async send(cmd) { return globalThis.__ddb(cmd); } }
          export class QueryCommand { constructor(input) { this.input = input; } }
          export class PutItemCommand { constructor(input) { this.input = input; } }
          export class DeleteItemCommand { constructor(input) { this.input = input; } }`,
        loader: 'js',
      }));
    },
  }],
});

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const VID = '0b8c9a4e-1f2d-4c3b-9a8e-7d6c5b4a3f21';
const row = (extra) => ({
  pk: { S: 'USER#owner' }, sk: { S: `VERSION#2026-09-24T10:00:00Z#${VID}` }, versionId: { S: VID },
  prompt: { S: 'ECサイトを作って' }, html: { S: '<html>v</html>' }, score: { N: '80' }, createdAt: { S: '2026-09-24T10:00:00Z' },
  ...extra,
});
const { getVersion } = await import(pathToFileURL(out).href);

// The handler's own condition, read from the source so the two cannot drift apart.
const handler = fs.readFileSync(path.join(root, 'src/handlers/lambda-handler.ts'), 'utf8');
check('the handler still refuses a version of another project', /version && forProject && version\.projectId !== forProject/.test(handler), true);
const refused = (version, forProject) => Boolean(version && forProject && version.projectId !== forProject);

globalThis.__ddb = async () => ({ Items: [row({ projectId: { S: 'p1' } })] });
const v = await getVersion('owner', VID);
check('a version says which project it belongs to', v?.projectId, 'p1');
check('so it is served through its own project', refused(v, 'p1'), false);
check('and still refused through another', refused(v, 'p2'), true);
check('with its document', v?.html, '<html>v</html>');

// A row from before projects existed has no project, and belongs to none.
globalThis.__ddb = async () => ({ Items: [row({})] });
const legacy = await getVersion('owner', VID);
check('a version with no project is not claimed by one', refused(legacy, 'p1'), true);
check('and is still readable without one', refused(legacy, undefined), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
