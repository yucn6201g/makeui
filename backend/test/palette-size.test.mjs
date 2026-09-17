// An instruction has to ask for the thing the check measures.
//
// `palette-size` fires on `colours` — the number of distinct colour VALUES in
// the stylesheet — and it used to answer with a list of substitutions:
// 「#059669（12箇所）→ var(--accent)」, every literal that exactly matched a
// declared token. Those substitutions are real and worth making. They cannot
// move this number: the value is still declared in `:root`, and it was only ever
// counted once.
//
// Measured on the five corpus documents where the defect fires, applying every
// substitution the instruction named:
//
//     colours 45 -> 45,  27 -> 27,  30 -> 30,  33 -> 33,  35 -> 35
//     loose    30 -> 10,   8 ->  8,   7 ->  7,  26 -> 22,  33 -> 22
//
// The literals went away and the count did not. A model doing exactly as it was
// told could not clear it, which is what 0 fixed of 19 was — not a defect models
// cannot fix, an instruction that asked for the wrong thing.
//
// What moves a count of distinct values is merging values.
//
//   node test/palette-size.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { completeProject, documentOf } from './fixtures/complete-project.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'dist/palette-entry.ts');
fs.mkdirSync(path.dirname(entry), { recursive: true });
fs.writeFileSync(entry,
  "export { measureDesignSystem, auditDesignSystem } from '../src/orchestration/design-system-audit.js';\n");
execSync(
  `npx esbuild "${entry}" --bundle --platform=node --format=esm --outfile="${path.join(root, 'dist/palette.test.mjs')}" ` +
    `--external:@aws-sdk/* --external:@smithy/* --external:@strands-agents/*`,
  { stdio: 'pipe', cwd: root }
);
const { measureDesignSystem, auditDesignSystem } = await import(
  pathToFileURL(path.join(root, 'dist/palette.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/**
 * A stylesheet over the threshold, built from near-duplicates on purpose.
 *
 * Thirty distinct values, of which several pairs are the same decision typed
 * twice — the shape every corpus document that fires this has.
 */
const PALETTE = [
  '#ffffff', '#f9fafb', '#fafaf8', '#f3f4f6', '#f5f5f5', '#e5e7eb', '#e8e4e0',
  '#d1d5db', '#9ca3af', '#999999', '#6b7280', '#666666', '#374151', '#1f2937',
  '#111827', '#000000', '#0017c1', '#3b5bdb', '#1e40af', '#10b981', '#059669',
  '#dcfce7', '#d1fae5', '#f59e0b', '#fbbf24', '#fffbeb', '#ef4444', '#dc2626',
  '#fef2f2', '#8b5cf6',
];
const sheet = ':root {\n' + PALETTE.map((c, i) => `  --c${i}: ${c};`).join('\n') + '\n}\n' +
  '.card { background: #f9fafb; border: 1px solid #e5e7eb; color: #374151; }\n' +
  '.chip { background: #f3f4f6; color: #666666; }\n';

const withSheet = (css) => {
  const files = completeProject();
  files.set('src/styles/globals.css', css);
  return documentOf(files);
};

const doc = withSheet(sheet);
const m = measureDesignSystem(doc);
check('the fixture is over the threshold', m.colours > 26, true);
check('and near-duplicates were found', m.nearDuplicates.length > 0, true);

// --- the merges are real: applying them reduces the number ---------------------------
//
// The whole point. If this fails, the instruction is naming an action that does
// not do what it says, which is the defect being fixed here.
{
  let merged = sheet;
  let expected = 0;
  for (const g of m.nearDuplicates) {
    for (const x of g.merge) {
      merged = merged.replace(new RegExp(x.hex, 'gi'), g.keep);
      expected += 1;
    }
  }
  const after = measureDesignSystem(withSheet(merged));
  check(`applying the named merges removes exactly ${expected} colours`,
    after.colours, m.colours - expected);
}

// --- and they merge in the right direction --------------------------------------------
//
// An off-white nine units from #ffffff is the copy. Merging the other way takes
// pure white out of the document to keep a value nobody chose.
{
  const white = m.nearDuplicates.find((g) => g.merge.some((x) => x.hex === '#f9fafb'));
  check('white is kept, not merged away', white.keep, '#ffffff');
  // `distance` is rounded for the instruction, so a pair at 11.7 prints as 12.
  check('and every merged colour is genuinely close',
    m.nearDuplicates.every((g) => g.merge.every((x) => x.distance <= 12)), true);
  check('a colour is never merged into itself',
    m.nearDuplicates.every((g) => !g.merge.some((x) => x.hex === g.keep)), true);
}

// A palette that is already small has nothing to merge and does not fire.
{
  const small = measureDesignSystem(withSheet(
    ':root { --bg: #ffffff; --text: #1f2937; --accent: #0017c1; }\n.a { color: var(--text) }'
  ));
  check('a small palette does not fire', small.colours <= 26, true);
  check('and has nothing to merge', small.nearDuplicates, []);
}

// --- the instruction says what it can deliver -----------------------------------------
{
  const d = auditDesignSystem(doc).find((x) => x.id === 'palette-size');
  check('the defect fires', Boolean(d), true);
  check('it names the merges', /ほぼ同じ値です/.test(d.instruction), true);
  /*
   * And no longer claims a substitution that cannot move the count. Those
   * belong to `token-adoption`, which measures the ratio they do move.
   */
  check('it no longer offers var() substitutions as the fix',
    /→ var\(--/.test(d.instruction), false);
  check('it names the files holding the literals', d.paths.length > 0, true);
  check('and every named file is a real file in the document',
    d.paths.every((p) => doc.includes(`@@@makeui:file ${p}`)), true);
}

// The substitutions did not vanish from the pipeline — they moved to the defect
// whose number they change.
{
  // token-adoption needs eight declared tokens and under 35% of colour
  // declarations referencing one, so the fixture is built to that.
  const literals =
    ':root {' + Array.from({ length: 8 }, (_, i) => ` --t${i}: #0${i}17c1;`).join('') + ' }' +
    Array.from({ length: 20 }, (_, i) => `.r${i} { color: #0017c1; background: #ffffff; }`).join('');
  const d = auditDesignSystem(withSheet(literals)).find((x) => x.id === 'token-adoption');
  check('token-adoption still lists the substitutions',
    Boolean(d) && /var\(--/.test(d.instruction), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
