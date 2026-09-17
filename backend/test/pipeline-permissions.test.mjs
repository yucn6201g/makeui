/**
 * Every AWS call the pipeline's deploy scripts make is one its role may make.
 *
 * Nothing else compares the two, so a new call passes every local suite and
 * fails only in CodeBuild, after part of the deploy has already happened. That
 * happened on 2026-09-17: deploy-lambda.sh gained a CORS check through API
 * Gateway, the push deployed both Lambdas, and the stage then stopped on
 * `apigatewayv2 get-apis` — AccessDenied — before the AgentCore Runtime was
 * updated, leaving the three executors on two different builds. Sweeping the
 * same scripts found a second gap that had simply not fired yet:
 * `lambda update-function-configuration`, which the environment reconciliation
 * calls only when a price table or ALLOWED_ORIGIN actually changes.
 *
 *   node test/pipeline-permissions.test.mjs      (from backend/)
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
};

const YAML = require('yaml');
// CloudFormation's short-form tags (!Sub, !GetAtt …) only need to parse, not resolve.
const cfnTags = ['Sub', 'GetAtt', 'Ref', 'If', 'Equals', 'Not', 'Join', 'Select', 'Split', 'ImportValue', 'FindInMap', 'Condition', 'And', 'Or', 'Base64', 'GetAZs', 'Cidr']
  .flatMap((t) => ['scalar', 'seq', 'map'].map((collection) => ({ tag: `!${t}`, collection: collection === 'scalar' ? undefined : collection, resolve: (v) => v })));
const pipeline = YAML.parse(read('infrastructure/pipeline.yaml'), { customTags: cfnTags, logLevel: 'silent' });

// --- which role runs which buildspec ------------------------------------------
const resources = pipeline.Resources;
const roleOf = (ref) => resources[String(ref).split('.')[0]];
const projects = Object.values(resources).filter((r) => r.Type === 'AWS::CodeBuild::Project');
const granted = (role) => new Set(role.Properties.Policies.flatMap((p) => p.PolicyDocument.Statement)
  .filter((s) => s.Effect === 'Allow').flatMap((s) => [].concat(s.Action)));

// --- the calls a buildspec makes, including the scripts it runs -----------------
const callsIn = (text) => text.split('\n')
  .map((line) => line.trim())
  .filter((line) => !line.startsWith('#') && !/\becho\b/.test(line))
  .flatMap((line) => [...line.matchAll(/\baws ([a-z0-9-]+) ([a-z0-9-]+)(?: ([a-z0-9-]+))?/g)])
  .map(([, service, op, sub]) => ({ service, op, sub }));

const pascal = (op) => op.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('');
// CLI command -> the IAM actions it needs. Anything unmapped fails loudly, so a
// new service is a decision here rather than a silent pass.
const actionsFor = ({ service, op, sub }) => {
  switch (service) {
    case 'lambda':
      if (op === 'wait') return ['lambda:GetFunctionConfiguration'];
      if (op === 'invoke') return ['lambda:InvokeFunction'];
      return [`lambda:${pascal(op)}`];
    case 'bedrock-agentcore-control': return [`bedrock-agentcore:${pascal(op)}`];
    case 'cloudfront': return [`cloudfront:${pascal(op)}`];
    case 'ssm': return [`ssm:${pascal(op)}`];
    case 'apigatewayv2': return op.startsWith('get-') ? ['apigateway:GET'] : [`apigateway:${op === 'update-api' ? 'PATCH' : '?'}`];
    case 's3':
      if (op === 'cp' || op === 'sync') return ['s3:PutObject', 's3:GetObject', 's3:ListBucket'];
      if (op === 'rm') return ['s3:DeleteObject', 's3:ListBucket'];
      return [`s3:?${op}`];
    case 's3api':
      if (op === 'list-objects-v2') return ['s3:ListBucket'];
      return [`s3:${pascal(op)}`];
    case 'sts': return op === 'get-caller-identity' ? [] : [`sts:${pascal(op)}`];
    default: return [`unmapped:${service} ${op}${sub ? ' ' + sub : ''}`];
  }
};

check('there are CodeBuild projects to check', projects.length > 0, true);
for (const project of projects) {
  const spec = read(project.Properties.Source.BuildSpec);
  const scripts = [...spec.matchAll(/bash (infrastructure\/[\w.-]+\.sh)/g)].map((m) => m[1]);
  const text = [spec, ...scripts.map(read)].join('\n');
  const role = roleOf(project.Properties.ServiceRole);
  const allowed = granted(role);
  const needed = [...new Set(callsIn(text).flatMap(actionsFor))].sort();
  check(`${project.Properties.Name} (${role.Properties.RoleName}) may make every call its scripts make`,
    needed.filter((a) => !allowed.has(a)), []);
}

// The failure that prompted this, stated directly.
{
  const deploy = granted(resources.DeployRole);
  check('the deploy role can read the HTTP API it checks CORS on', deploy.has('apigateway:GET'), true);
  check('and can write the environment it reconciles', deploy.has('lambda:UpdateFunctionConfiguration'), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
