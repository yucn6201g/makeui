/**
 * The version list's 「要件・指摘」 cell.
 *
 * Whether a version does what was asked and what it shipped still wrong were in
 * the chat reply and nowhere a list of versions could show them. Absent is a
 * dash, never zero: an unmeasured row did not score zero.
 *
 *   node test/version-quality.test.mjs      (from frontend/)
 */
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN_FILES, readAdminPanel } from './lib/admin-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const out = path.join(root, 'dist-test/version-quality.test.mjs');
fs.mkdirSync(path.dirname(out), { recursive: true });
await esbuild.build({ entryPoints: [path.join(root, 'src/utils/projects/versionQuality.ts')], bundle: true, platform: 'node', format: 'esm', outfile: out });
const { versionQualityLabel, versionQualityTitle } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// The inventory generation of 2026-09-13: 4 of 6 checkable, 5 open findings.
check('met of checked, and the open findings', versionQualityLabel({ requirementsMet: 4, requirementsChecked: 6, openFindings: 5 }), '4/6・5');
check('a clean version says zero findings, not a dash', versionQualityLabel({ requirementsMet: 3, requirementsChecked: 3, openFindings: 0 }), '3/3・0');
check('an older row is dashes, not zeros', versionQualityLabel({}), '—・—');
check('an edit records its checklist but no findings', versionQualityLabel({ requirementsMet: 2, requirementsChecked: 2 }), '2/2・—');
check('the tooltip says it in words', versionQualityTitle({ requirementsMet: 4, requirementsChecked: 6, openFindings: 5 }),
  '依頼の要件のうち、自動で確認できる6件中4件を満たしています\n未解決の指摘が5件あります');

const panel = readAdminPanel();
check('the version list has the column', panel.includes('<th className="adm-th adm-th--num adm-th--quality">要件・指摘</th>'), true);
check('and fills it from the row', /title=\{versionQualityTitle\(v\)\}[\s\S]*?\{versionQualityLabel\(v\)\}/.test(panel), true);
check('the admin type carries the fields',
  ['requirementsMet?: number;', 'requirementsChecked?: number;', 'openFindings?: number;'].every((f) => read('src/hooks/useAdmin.ts').includes(f)), true);

check("with a width of its own, not the score column's 64px, and narrow", /\.adm-split \.adm-th--quality \{ width: 108px; \}/.test(read('src/index.css')), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
