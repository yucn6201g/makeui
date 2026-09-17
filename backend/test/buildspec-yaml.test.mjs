/**
 * The build and deploy definitions parse as YAML.
 *
 * Nothing else here reads them, so a broken one passes every local suite and
 * fails only in CodeBuild, before a single command runs. That happened on
 * 2026-09-15: a shell `printf` inside a `- |` block in build.yml had its `\n`
 * turned into real newlines while it was being written, the build failed at
 * DOWNLOAD_SOURCE with "could not find expected ':' at line 57", and nothing
 * deployed.
 *
 * `yaml` is installed through the lockfile (a dependency of the build tooling),
 * not a dependency of its own; if it ever stops resolving this says so.
 *
 *   node test/buildspec-yaml.test.mjs      (from backend/)
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
};

let YAML;
try { YAML = require('yaml'); } catch { YAML = null; }
check('the yaml parser resolves', Boolean(YAML), true);

const parseErrors = (file, options = {}) => {
  const doc = YAML.parseDocument(fs.readFileSync(path.join(root, file), 'utf8'), options);
  return doc.errors.map((e) => `${file}: ${e.message.split('\n')[0]}`);
};

if (YAML) {
  const dir = 'infrastructure/buildspec';
  for (const f of fs.readdirSync(path.join(root, dir)).filter((x) => /\.ya?ml$/.test(x))) {
    const file = `${dir}/${f}`;
    check(`${file} parses`, parseErrors(file), []);
    const spec = YAML.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    check(`${file} has phases whose commands are strings`,
      Object.values(spec.phases ?? {}).every((p) => (p.commands ?? []).every((c) => typeof c === 'string')), true);
  }
  // CloudFormation's short tags (!Ref, !Sub, !GetAtt) are not YAML errors, only unknown tags.
  for (const file of ['infrastructure/template.yaml', 'infrastructure/pipeline.yaml']) {
    check(`${file} parses`, parseErrors(file).filter((e) => !/tag/i.test(e)), []);
  }
  // Every taggable resource carries system=makeui (added 2026-09-16), so cost and
  // ownership can be filtered by one tag. Types whose CloudFormation schema has no
  // tag property (bucket policies, OAC, headers policies, Lambda permissions and
  // URLs, Cognito clients and groups) are the ones left out.
  const TAG_KEY = { 'AWS::Cognito::UserPool': 'UserPoolTags' };
  const TAGGABLE = new Set(['AWS::Cognito::UserPool', 'AWS::DynamoDB::Table', 'AWS::S3::Bucket', 'AWS::CloudFront::Distribution',
    'AWS::IAM::Role', 'AWS::Lambda::Function', 'AWS::Events::Rule', 'AWS::CodeCommit::Repository', 'AWS::CodeBuild::Project',
    'AWS::CodePipeline::Pipeline', 'AWS::ApiGatewayV2::Api', 'AWS::Logs::LogGroup', 'AWS::SSM::Parameter']);
  for (const file of ['infrastructure/template.yaml', 'infrastructure/pipeline.yaml']) {
    const doc = YAML.parseDocument(fs.readFileSync(path.join(root, file), 'utf8'), { logLevel: 'silent' }).toJS({ maxAliasCount: -1 });
    const untagged = Object.entries(doc.Resources).filter(([, r]) => TAGGABLE.has(r.Type)).filter(([, r]) => {
      const tags = r.Properties?.[TAG_KEY[r.Type] ?? 'Tags'];
      return Array.isArray(tags) ? !tags.some((t) => t.Key === 'system' && t.Value === 'makeui') : tags?.system !== 'makeui';
    }).map(([id]) => id);
    check(`${file}: every taggable resource is tagged system=makeui`, untagged, []);
  }
  const build = YAML.parse(fs.readFileSync(path.join(root, 'infrastructure/buildspec/build.yml'), 'utf8'));
  const writes = build.phases.build.commands.find((c) => c.includes('frontend/.env.production written from the build environment'));
  check('the frontend config is written from the build environment, one variable per line',
    Boolean(writes) && ['VITE_API_URL', 'VITE_COGNITO_USER_POOL_ID', 'VITE_COGNITO_CLIENT_ID', 'VITE_COGNITO_REGION']
      .every((v) => new RegExp(`echo "${v}=\\$\\{`).test(writes)), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
