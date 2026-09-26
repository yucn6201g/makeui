/**
 * How wide the project-name field has to be.
 *
 * 180px fixed, from a time when every project was called 「Untitled」 and the only
 * names were ones a person had typed. The product writes them itself now, and
 * 「さくら歯科クリニック予約システム」 — the name the auto-namer produced on the
 * verification run — is sixteen full-width characters, 208px at 13px. Cut by
 * nearly a third, which is what was reported.
 *
 * The property worth pinning is that it is counted by WIDTH and not by `length`.
 * 「さくら歯科クリニック予約システム」 and "Inventory Manager" are both sixteen
 * characters and need very different room: counting characters makes the Latin
 * name twice as wide as it needs to be and the Japanese one right by accident.
 *
 *   node test/title-width.test.mjs      (from frontend/)
 */
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { APP_FILES, readApp } from './lib/app-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const out = path.join(root, 'dist-test/title-width.test.mjs');
fs.mkdirSync(path.dirname(out), { recursive: true });
await esbuild.build({
  entryPoints: [path.join(root, 'src/utils/projects/titleWidth.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile: out,
});
const { titleWidthEm } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- width, not character count ------------------------------------------------
const jp = 'さくら歯科クリニック予約システム';   // 16 characters
const en = 'Inventory Manag';                    // 15 characters
check('the two are the same length, near enough', Math.abs(jp.length - en.length) <= 1, true);
check('and are not given the same width', titleWidthEm(jp) === titleWidthEm(en), false);
check('the Japanese one gets about an em each', titleWidthEm(jp) > jp.length, true);
check('and the Latin one about half', titleWidthEm(en) < en.length, true);

// --- the name that prompted this -----------------------------------------------
/*
 * 17.5em at 13px is 228px, against the 180px the field used to be. That is the
 * measurement the report was about.
 */
check('the verification run’s name fits', titleWidthEm(jp) >= 17, true);

// --- the shapes that actually occur ---------------------------------------------
// From the 148 stored documents: a brand, an em-dash and a description.
check('a mixed brand and description is between the two',
  titleWidthEm('PIPELINE — 商談管理ツール') > titleWidthEm('PIPELINE') , true);
check('an empty name still has room for the caret', titleWidthEm('') > 0, true);
// Kana, kanji and full-width punctuation all count as wide.
for (const [label, s] of [['kana', 'よやく'], ['kanji', '予約管理'], ['full-width punctuation', '（一覧）']]) {
  check(`${label} counts as wide`, titleWidthEm(s) >= s.length, true);
}
check('ASCII punctuation counts as narrow', titleWidthEm('a-b-c') < 5, true);

// --- the bounds live in the stylesheet ------------------------------------------
/*
 * Deliberately, because they are layout facts about the header rather than facts
 * about the string: past the ceiling the header actions start losing room.
 */
const css = read('src/index.css');
const rule = css.slice(css.lastIndexOf('.app__project-title {'), css.indexOf('}', css.lastIndexOf('.app__project-title {')));
check('the field has a floor', /min-width:/.test(rule), true);
check('and a ceiling', /max-width:/.test(rule), true);
// A bare width declaration, not the one inside min-width: what this checks is
// that the fixed 180px is gone.
check('and no fixed width to override them', /\n\s*width:/.test(rule), false);

// --- and the composer applies it -------------------------------------------------
const app = readApp();
check('the width is computed from the value',
  /style=\{\{ width: `\$\{titleWidthEm\(projectTitle\)\}em` \}\}/.test(app), true);
// The full name is still reachable when it is longer than the ceiling.
check('and the whole name is available on hover', /title=\{projectTitle\}/.test(app), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
