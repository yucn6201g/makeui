/**
 * The marker protection stopped at the document boundary.
 *
 * Generate never shows a model a data URI: it writes `{{USER_IMAGE_1}}` and the
 * bytes are substituted after the build. But once the pictures are IN the
 * document, every later pass that rewrites a file sends them back to a model,
 * because a file body goes into the prompt whole.
 *
 * Measured on a real generated project with two supplied photographs: the model
 * put both into `src/data/products.ts`, which came to 527,914 characters — about
 * 132,000 tokens, against a measured median edit of 14,439 tokens total. Nine
 * edits' worth for one file, and it is the seed data, which is the file an edit
 * like 「商品を追加して」 touches first. The whole-document rewrite was worse
 * still: its prompt ends with `Current HTML:` and the entire 602,031-character
 * document.
 *
 * Three separate harms, and this file holds all three:
 *
 *   cost         the base64 goes into the prompt
 *   corruption   the model is asked to reproduce it character for character,
 *                and one wrong character is a silently broken image
 *   the guard    `applyFileEdits` and `repairFiles` reject a reply far shorter
 *                than what it replaced. Against a body inflated by half a
 *                megabyte of base64 that ratio stops meaning anything, so a
 *                correct rewrite that drops one picture reads as a 90% shrink
 *                and is thrown away.
 *
 *   node test/embedded-images.test.mjs      (from backend/)
 */
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const out = path.join(root, 'dist/embedded-images.test.mjs');
fs.mkdirSync(path.dirname(out), { recursive: true });
await esbuild.build({
  entryPoints: [path.join(root, 'src/utils/embedded-images.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile: out,
  external: ['@aws-sdk/*', '@smithy/*', '@strands-agents/*'],
});
const { lean, restore, embeddedImageToken, EMBEDDED_IMAGE_NOTE, MIN_EXTRACTED_CHARS } =
  await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const uri = (n, c = 'A') => `data:image/jpeg;base64,${c.repeat(n)}`;
const BIG = uri(600);
const BIG2 = uri(700, 'B');

// --- the round trip -----------------------------------------------------------
const file = `export const PRODUCTS = [\n  { id: 1, image: '${BIG}' },\n  { id: 2, image: '${BIG2}' },\n];`;
const L = lean(file);
check('both pictures come out', L.images.size, 2);
check('and the text no longer holds any', /base64,[A-Za-z0-9+/=]{100,}/.test(L.text), false);
check('markers stand in their place',
  [embeddedImageToken(1), embeddedImageToken(2)].filter((t) => !L.text.includes(t)), []);
/*
 * The number that made this worth doing. The real file was 527,914 characters
 * and the code in it was a few thousand.
 */
check('the saving is the size of the pictures', L.saved > 1200, true);
check('and the code survives untouched', L.text.includes('export const PRODUCTS'), true);

const R = restore(L.text, L.images);
check('restoring gives back exactly what went in', R.text, file);
check('and counts what it put back', R.restored, 2);
check('with nothing reported missing', R.missing, []);

// --- a picture used twice is one picture --------------------------------------
/*
 * Giving the same URI two markers would let a model keep one and drop the other
 * without that reading as a loss.
 */
const twice = lean(`<img src="${BIG}"><img src="${BIG}">`);
check('one marker for one picture', twice.images.size, 1);
check('used in both places', (twice.text.match(/\{\{EMBEDDED_IMAGE_1\}\}/g) ?? []).length, 2);
check('and both come back', restore(twice.text, twice.images).text, `<img src="${BIG}"><img src="${BIG}">`);

// --- small ones stay --------------------------------------------------------
/*
 * A tiny inline icon is a handful of tokens and may be something the model needs
 * to read. The point of this module is the photographs.
 */
const small = lean(`<img src="${uri(MIN_EXTRACTED_CHARS - 100)}">`);
check('a small data URI is left alone', small.images.size, 0);
check('and the text is unchanged', small.text.includes('base64,AAA'), true);
check('a document with no pictures is untouched',
  lean('export const x = 1').text, 'export const x = 1');
check('and needs no restoring', restore('export const x = 1', new Map()).text, 'export const x = 1');

// --- what the model does wrong ------------------------------------------------
/*
 * A dropped marker can be exactly what was asked for — 「この写真を外して」 — so
 * it is reported, not corrected. What it must never be is invisible.
 */
const dropped = restore(`{{EMBEDDED_IMAGE_1}} only`, L.images);
check('a picture the model removed is reported', dropped.missing, [embeddedImageToken(2)]);
check('and the one it kept is restored', dropped.text.includes(BIG), true);

/*
 * A marker with nothing behind it is stripped rather than shipped: it would
 * render as `src="{{EMBEDDED_IMAGE_9}}"`, a visibly broken image. The same guard
 * the generate path keeps for its own markers.
 */
const invented = restore(`<img src="${embeddedImageToken(9)}">`, L.images);
check('an invented marker is stripped', invented.text, '<img src="">');
check('and both real pictures are reported missing', invented.missing.length, 2);

// --- the model is told what the markers are ------------------------------------
// Without this, a model tidying up what looks like a templating leftover deletes
// the user's photograph.
check('there is a note explaining them', EMBEDDED_IMAGE_NOTE.includes('{{EMBEDDED_IMAGE_n}}'), true);
check('and it says to copy them through', EMBEDDED_IMAGE_NOTE.includes('EXACTLY'), true);

// --- every site that puts a body in a prompt uses it ---------------------------
/*
 * The property, stated against the source. A new call site that sends a file
 * body without leaning it first is the whole bug coming back, and nothing else
 * here would notice.
 */
const meta = read('src/orchestration/meta-orchestrator.ts');
const repair = read('src/orchestration/repair-files.ts');
const edit = read('src/orchestration/edit-files.ts');

check('the whole-document rewrite leans its input', /const leaned = lean\(rawHtml\)/.test(meta), true);
check('and restores on the way out', /return withImages\(/.test(meta), true);
check('the per-file repair sends the lean body',
  /'--- current contents ---',\s*\n\s*leaned\.text,/.test(repair), true);
check('the per-file edit sends the lean body',
  /\['--- current contents ---', leaned\.text\]/.test(edit), true);
// The shape that was there before, which must not come back.
check('no site still sends the raw body',
  [meta, repair, edit].filter((src) => /'--- current contents ---',\s*\n?\s*files\.get\(plan\.path\)/.test(src)), []);

/*
 * And the guard is measured lean against lean. Leaving `before` as the raw
 * length would keep the third harm even with the first two fixed — the ratio
 * would still be a statement about base64.
 */
check('the repair guard compares code with code',
  /const before = leaned\.text\.length[\s\S]{0,200}const after = lean\(body\)\.text\.length/.test(repair), true);
check('and so does the edit guard',
  /const before = leaned\.text\.length/.test(edit) && /const after = lean\(body\)\.text\.length/.test(edit), true);
check('neither still measures the raw reply',
  [repair, edit].filter((src) => /body\.length < before \* 0\.\d+/.test(src)), []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
