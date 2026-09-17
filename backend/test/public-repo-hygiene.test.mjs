/**
 * The repository is published, so one deployment's identifiers stay out of it.
 *
 * Found preparing it for a public GitHub repository (2026-09-15): the account id,
 * the Cognito user pool id, the API Gateway and CloudFront hosts, the AgentCore
 * Runtime and Knowledge Base ids were written into operational scripts, tests,
 * docs and infrastructure defaults. Scripts now read them from the account
 * (backend/scripts/lib/aws-env.mjs), tests use AWS's documentation account
 * 123456789012, docs use placeholders, and the frontend's build configuration is
 * written from SSM in the build. This keeps it that way.
 *
 * Reads the tracked files (`git ls-files`), which are what would be published; in
 * CodeBuild, whose source is a zip of tracked files with no .git, it walks the tree.
 *
 *   node test/public-repo-hygiene.test.mjs      (from backend/)
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
};

const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-test', '.git', 'vendor', '.claude']);
// Ignored by .gitignore and never tracked, so never published: the build writes
// frontend/.env.production from SSM (infrastructure/pipeline.yaml). Listed for the
// CodeBuild walk, where build.yml may already have written it.
const IGNORED_FILES = new Set(['frontend/.env.production', 'docs/qiita-article.md']);
const TEXT = /\.(m?[jt]sx?|vue|svelte|json|ya?ml|sh|md|html|css|txt|env|example)$|(^|\/)\.env/;
let files = [];
try {
  // What would be published: tracked files. Ignored local files (.env, throwaway probes) never are.
  files = execSync('git ls-files', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n')
    .filter((f) => TEXT.test(f) && !IGNORED_FILES.has(f) && fs.existsSync(path.join(root, f)));
} catch {
  // CodeBuild's source is a zip of tracked files with no .git: everything in it is published.
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name)); continue; }
      const rel = path.relative(root, path.join(dir, e.name)).replace(/\\/g, '/');
      if (TEXT.test(rel) && !IGNORED_FILES.has(rel)) files.push(rel);
    }
  })(root);
}

const found = (re, allow = () => false) => {
  const hits = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of text.matchAll(re)) if (!allow(m[0])) hits.push(`${f}: ${m[0]}`);
  }
  return [...new Set(hits)].slice(0, 10);
};

check('files were scanned', files.length > 300, true);
check('no AWS account id other than the documentation one',
  found(/(?:arn:aws:[a-z0-9-]+:[a-z0-9-]*:|makeui-(?:outputs|knowledge-base|frontend)-)(\d{12})/g, (s) => s.includes('123456789012')), []);
check('no Cognito user pool id other than placeholders',
  found(/\b[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]{9}\b/g, (s) => /_x{9}$|_E2ETEST00$|_X{9}$/.test(s)), []);
check('no API Gateway host other than placeholders', found(/\b[a-z0-9]{10}\.execute-api\.[a-z0-9-]+\.amazonaws\.com/g, (s) => s.startsWith('xxxxxxxxxx.')), []);
check('no CloudFront host other than placeholders', found(/\bd[a-z0-9]{12,13}\.cloudfront\.net/g, (s) => /^dx+\./.test(s)), []);
check('no AgentCore Runtime id other than placeholders', found(/makeuiBackend-[A-Za-z0-9]{10}\b/g, (s) => /makeuiBackend-(X{10}|EXAMPLE123)/.test(s)), []);
check('no AgentCore Memory or Browser id other than placeholders', found(/makeui(?:Memory|Browser)-[A-Za-z0-9]{10}\b/g, (s) => /-X{10}$/.test(s)), []);
check('no CloudFront distribution id', found(/\bE[0-9A-Z]{12,13}\b/g, (s) => /^E(?:X+|[A-Z]+)$/.test(s)), []);
check('no Guardrail or Knowledge Base data source id in the configuration table',
  found(/`\/makeui\/(?:guardrail-id|agentcore\/data-source-id)` \| `[^`<]+`/g), []);
check('no AWS access key',found(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g), []);
const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
check('the article draft is ignored', /^qiita_article\.md$/m.test(ignore) && /^\*\*\/qiita-article\.md$/m.test(ignore), true);
check('the deployment frontend config is ignored', /^frontend\/\.env\.production$/m.test(ignore), true);
const license = fs.existsSync(path.join(root, 'LICENSE')) ? fs.readFileSync(path.join(root, 'LICENSE'), 'utf8') : '';
check('the repository is MIT licensed', /^MIT License/.test(license), true);
check('both packages declare MIT and cannot be published to npm by accident',
  ['backend', 'frontend'].map((d) => JSON.parse(fs.readFileSync(path.join(root, d, 'package.json'), 'utf8')))
    .every((p) => p.license === 'MIT' && p.private === true), true);
check('the third-party notices exist and name every preset source',
  fs.existsSync(path.join(root, 'THIRD_PARTY_NOTICES.md')) &&
  ['@carbon/themes', '@material/web', '@digital-go-jp/design-tokens', '@openameba/spindle-tokens', 'CC BY-NC-ND']
    .every((s) => fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8').includes(s)), true);
try {
  const tracked = execSync('git ls-files -- frontend/.env.production frontend/.env', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  check('no deployment frontend config is tracked', tracked, '');
} catch { /* no .git in CodeBuild */ }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
