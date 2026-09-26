/**
 * Does the file we draw actually satisfy the import that was dangling?
 *
 * `leaf-modules.test.mjs` asserts the body is the right shape. That is not the
 * claim that matters. The claim is that after `writeFile` puts it in the
 * document, `unresolvedImports` — the same function whose findings revert the
 * repair — no longer reports the spec. Path arithmetic, the extension guess and
 * the barrel rules all sit between the two, and each of them has been wrong
 * before.
 *
 * So: take real projects out of the corpus, break each one the way the log says
 * they break (a screen importing a graphic nobody wrote), and run the real pipe.
 *
 *   node test/leaf-resolves.probe.mjs [n]      (from backend/)
 */
import * as esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUCKET = 'makeui-outputs-123456789012';
const REGION = 'ap-northeast-1';
const want = Number(process.argv[2] ?? 24);

const entry = path.join(root, 'dist/leaf-resolves-entry.ts');
fs.mkdirSync(path.dirname(entry), { recursive: true });
fs.writeFileSync(entry, [
  "export { reactFiles } from '../src/orchestration/audit/interaction-audit.js'",
  "export { writeFile } from '../src/orchestration/repair/repair-files.js'",
  "export { leafModule } from '../src/orchestration/generate/leaf-modules.js'",
  "export { unresolvedImports, addMissingBarrels } from '../src/tools/project/react-bundle.js'",
  "export { detectKind } from '../src/tools/project/framework-compile.js'",
].join('\n'));
const out = path.join(root, 'dist/leaf-resolves.mjs');
await esbuild.build({
  entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out,
  external: ['@aws-sdk/*', '@smithy/*', '@strands-agents/*'],
});
const { reactFiles, writeFile, leafModule, unresolvedImports, addMissingBarrels, detectKind } =
  await import(pathToFileURL(out).href);

const EXT = { react: '.tsx', vue: '.vue', svelte: '.svelte' };
// The five commonest names in the log, and one the glyph table does not know.
const NAMES = ['EmptyStateIllustration', 'EmptyCartIcon', 'ChevronLeftIcon', 'BackIcon', 'ProductImagePlaceholder', 'ZorblattIcon'];

const listing = execFileSync('aws', ['s3', 'ls', `s3://${BUCKET}/outputs/`, '--region', REGION, '--recursive'],
  { encoding: 'utf8', maxBuffer: 1 << 26 });
const keys = listing.split(/\r?\n/)
  .map((l) => l.trim().split(/\s+/))
  .filter((p) => p.length === 4 && Number(p[2]) > 40_000)
  .map((p) => p[3]);
/*
 * Shuffled, and capped per framework.
 *
 * The first run took the tail of the key listing and got 24 Vue projects and
 * nothing else — 144 cases, all passing, on one third of the code under test.
 * The keys sort by project id, not by date or framework, so a contiguous slice
 * of them is a slice of one afternoon's work.
 */
const shuffled = keys.slice();
for (let i = shuffled.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
}
const sample = shuffled.slice(0, want);
const PER_KIND = Math.max(3, Math.ceil(want / 6));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leaf-'));
let projects = 0, cases = 0, resolved = 0, notDrawn = 0, notWritten = 0, stillDangling = 0;
const byKind = {};
const failures = [];

for (const [i, k] of sample.entries()) {
  const file = path.join(dir, `d${i}.html`);
  try {
    execFileSync('aws', ['s3', 'cp', `s3://${BUCKET}/${k}`, file, '--region', REGION, '--quiet']);
  } catch { continue; }
  const doc = fs.readFileSync(file, 'utf8');
  let files;
  try { files = reactFiles(doc); } catch { continue; }
  if (!files || files.size === 0) continue;
  const kind = detectKind(files.keys());
  if (!kind) continue;
  // Only a project that already resolves cleanly can show that a new dangling
  // import was the thing this fixed.
  if (unresolvedImports(addMissingBarrels(doc).html).length > 0) continue;
  const ext = EXT[kind];
  const screen = [...files.keys()].find((p) => /^src\/(screens|pages)\/[\w-]+\./.test(p) && p.endsWith(ext));
  if (!screen) continue;
  if ((byKind[kind] ?? 0) >= PER_KIND) continue;
  projects += 1;
  byKind[kind] = (byKind[kind] ?? 0) + 1;

  for (const name of NAMES) {
    const spec = `../components/illustrations/${name}`;
    const body = files.get(screen);
    // Break it exactly as the corpus breaks: an import at the top of a screen
    // for a graphic that is nowhere in the project.
    const broken = writeFile(doc, screen, `import ${name} from '${spec}';\n${body}`);
    if (!broken) continue;
    cases += 1;

    const target = `src/components/illustrations/${name}${ext}`;
    const drawn = leafModule(target, kind, reactFiles(broken).get(screen) ?? '', spec);
    if (!drawn) { notDrawn += 1; failures.push(`${kind} ${name}: not drawn`); continue; }
    const fixed = writeFile(broken, target, drawn);
    if (!fixed) { notWritten += 1; failures.push(`${kind} ${name}: writeFile refused it`); continue; }
    const left = unresolvedImports(addMissingBarrels(fixed).html).map((u) => u.spec);
    if (left.includes(spec)) { stillDangling += 1; failures.push(`${kind} ${name}: still unresolved`); continue; }
    if (left.length > 0) { failures.push(`${kind} ${name}: fixed, but introduced ${left.join(', ')}`); }
    resolved += 1;
  }
}
fs.rmSync(dir, { recursive: true, force: true });

console.log(`${projects} clean projects (${JSON.stringify(byKind)}), ${cases} broken imports`);
console.log(`  resolved by the drawn file: ${resolved}`);
console.log(`  no file drawn:              ${notDrawn}`);
console.log(`  writeFile refused:          ${notWritten}`);
console.log(`  still dangling after:       ${stillDangling}`);
if (failures.length) {
  console.log('\n--- failures ---');
  for (const f of [...new Set(failures)].slice(0, 20)) console.log('  ' + f);
}
