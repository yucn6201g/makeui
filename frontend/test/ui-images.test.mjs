/**
 * Which field the attached pictures travel in, and why it matters.
 *
 * The backend reads two of them and reads them differently. `image` is the one
 * attachment the design phase and the build LOOK at, spending vision tokens on
 * every stage that sees it, because "take the layout and palette from this"
 * cannot be done from a description. `images` are content: captioned once,
 * placed by marker, so five cost one call rather than one per stage.
 *
 * The composer decides which a person meant, and that decision is invisible
 * afterwards — a request carries one field or the other and the finished UI is
 * the only report. So the rule lives in one function and this file holds it.
 *
 *   node test/ui-images.test.mjs      (from frontend/)
 */
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const out = path.join(root, 'dist-test/ui-images.test.mjs');
fs.mkdirSync(path.dirname(out), { recursive: true });
await esbuild.build({
  entryPoints: [path.join(root, 'src/utils/uiImages.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile: out,
});
const { uiImagesForSend, roomForImages, MAX_UI_IMAGES } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const A = 'data:image/png;base64,AAA';
const B = 'data:image/png;base64,BBB';
const C = 'data:image/png;base64,CCC';

// --- nothing attached ---------------------------------------------------------
/*
 * The field is absent, not undefined. A request that attaches nothing must send
 * the body it sent before any of this existed, and `{image: undefined}` is a
 * different object from `{}` to anything that counts keys.
 */
check('nothing attached sends nothing', uiImagesForSend(null, []), {});
check('and an empty list is nothing too', uiImagesForSend(null, ['', '']), {});

// --- one picture: unchanged ---------------------------------------------------
/*
 * The behaviour a lone attachment has always had. The model decides from the
 * request whether it is a design reference or something to display, and that
 * decision is made downstream by `imageDirective`, not here.
 */
check('one picture is the reference attachment', uiImagesForSend(A, []), { image: A });
check('and carries no content list', 'images' in uiImagesForSend(A, []), false);

// --- two or more: the prompt decides, not the attachment order -----------------
/*
 * The rule this file exists for. The composer does not guess which of several
 * pictures is a reference from the order they were picked in — it sends them as
 * one list, and the backend's captioner reads the request alongside them and may
 * promote one. Someone attaching four product photos and a mood board should not
 * have to attach the mood board first.
 */
check('two pictures go as one list', uiImagesForSend(A, [B]), { images: [A, B] });
check('and the composer does not pre-assign a reference',
  'image' in uiImagesForSend(A, [B]), false);
check('order is preserved, first slot first', uiImagesForSend(A, [B, C]), { images: [A, B, C] });
// The first slot can be empty if the user removed it after attaching several.
check('extras alone go the same way', uiImagesForSend(null, [B, C]), { images: [B, C] });
// A single extra with the first slot empty is still a list, so the backend still
// gets to read its role from the prompt rather than inheriting the slot's meaning.
check('and one extra alone is still a list',
  uiImagesForSend(null, [B]), { images: [B] });
// A removed thumbnail leaves nothing behind.
check('blanks are dropped rather than sent', uiImagesForSend(A, ['', B, '']), { images: [A, B] });

// --- the ceiling --------------------------------------------------------------
check('an empty composer has room for all of them', roomForImages(null, []), MAX_UI_IMAGES);
check('the reference counts against it', roomForImages(A, []), MAX_UI_IMAGES - 1);
check('and so do the extras', roomForImages(A, [B, C]), MAX_UI_IMAGES - 3);
check('a full composer has no room', roomForImages(A, Array(MAX_UI_IMAGES).fill(B)), 0);
// Never negative: the caller uses it as a slice length.
check('and never reports negative room',
  roomForImages(A, Array(MAX_UI_IMAGES + 5).fill(B)), 0);

// --- the two ceilings are the same number -------------------------------------
/*
 * The packages share no code, so the bound is stated twice. Stated twice and
 * disagreeing is worse than either value: the composer would accept what the
 * backend silently drops, and the user would meet the loss in the finished UI.
 */
const backend = read('../backend/src/utils/content-images.ts');
const declared = /MAX_CONTENT_IMAGES = (\d+)/.exec(backend);
check('the backend declares a bound', Boolean(declared), true);
check('and the composer refuses at the same number', Number(declared[1]), MAX_UI_IMAGES);

// --- the composer uses the rule rather than restating it ----------------------
const app = read('src/App.tsx');
check('the composer calls the shared rule', /uiImagesForSend\(image, extraImages\)/.test(app), true);
check('and the shared ceiling', /roomForImages\(image, extraImages\)/.test(app), true);
// The inline version this replaced, which must not come back: it decided the
// same thing in a place no test could reach.
check('no second copy of the decision',
  /extraImages\.length > 0 && image \? \[image, \.\.\.extraImages\]/.test(app), false);
// Attachments belong to the message they were sent with.
check('the extras are cleared after sending',
  (app.match(/setExtraImages\(\[\]\)/g) ?? []).length >= 3, true);

// --- a description per picture, aligned with the picture ----------------------
/*
 * The user knows what the photograph is; the captioner can only guess, and
 * guessing costs a vision call. A described picture never reaches that call.
 *
 * The boxes lived in the extended chat until it was removed. They are on the
 * composer's own thumbnails now, which is where the alignment gets dangerous:
 * the request is built as `[image, ...extras]`, so the reference slot owns note
 * 0 and `extraImages[i]` owns note `i + 1`. Off by one and the right sentence
 * lands on the wrong photograph — and it becomes that photograph's alt text, so
 * the mistake ships inside the generated UI.
 */
check('each attached picture has a description box',
  (app.match(/className="app__attach-note"/g) ?? []).length, 2);
check('the reference slot owns note 0', /value=\{imageNotes\[0\] \?\? ''\}/.test(app), true);
check('and each extra is one along', /value=\{imageNotes\[i \+ 1\] \?\? ''\}/.test(app), true);
// The same offset the send uses, which is what makes the two agree.
// Now in `captionsForSend`, which every send path calls with the composer's notes.
check('the send reads them in that order',
  /picked\.images\.map\(\(_v, i\) => notes\[i\] \?\? ''\)/.test(read('src/utils/uiImages.ts')) && /captionsForSend\(picked, imageNotes\)/.test(app), true);
/*
 * And removing a picture removes ITS note, not the last one. Dropping the
 * picture alone slides every later note onto the wrong photograph — the same
 * defect as an off-by-one, arrived at from the other direction.
 */
check('removing the reference drops its note',
  /setImageNotes\(\(prev\) => prev\.filter\(\(_, n\) => n !== 0\)\)/.test(app), true);
check('and removing an extra drops the matching one',
  /setImageNotes\(\(prev\) => prev\.filter\(\(_, n\) => n !== i \+ 1\)\)/.test(app), true);
// Cleared with the pictures they describe.
check('the notes are cleared after sending',
  (app.match(/setImageNotes\(\[\]\)/g) ?? []).length >= 3, true);
// Sent only when something was written: a caption with nothing in it is a field
// the server would have to ignore.
check('and sent only when something was written',
  /imageCaptions\.some\(\(c\) => c && c\.trim\(\)\)/.test(read('src/hooks/useGenerate.ts')), true);

// --- every path sends every picture and its description (2026-09-14) -------------------------
/*
 * An edit sent only the first picture and the composer cleared the rest; an
 * approved plan built with the first; a lone picture's description was dropped.
 */
{
  const { captionsForSend } = await import(pathToFileURL(out).href);
  check('a list sends its descriptions aligned by index', captionsForSend({ images: [A, B] }, ['', '店舗外観']), ['', '店舗外観']);
  check('a lone picture sends its description', captionsForSend({ image: A }, ['ロゴ']), ['ロゴ']);
  check('nothing written, nothing sent', [captionsForSend({ image: A }, ['  ']), captionsForSend({ images: [A, B] }, [])], [undefined, undefined]);
  check('no picture, no descriptions', captionsForSend({}, ['orphan']), undefined);

  const app = read('src/App.tsx');
  check('the edit sends the picture list and descriptions',
    /modify\(displayHtml, rawText, [^;]*pickedForEdit\.image, effort, dataFile \?\? undefined, pickedForEdit\.images, captionsForSend\(pickedForEdit, imageNotes\)\)/.test(app), true);
  check('the approved plan builds with them, as an edit or a build',
    /pickedForBuild\.images, notesForBuild\);[\s\S]{0,200}generate\([^;]*pickedForBuild\.images, notesForBuild\)/.test(app), true);
  // Followed by the proposal being amended, when there is one (utils/planRevision.ts).
  check('the plan is asked with the descriptions', /proposePlan\([^;]*picked\.images, captionsForSend\(picked, imageNotes\)(?:, revision)?\)/.test(app), true);
  check('no path sends only the first picture any more', /image \?\? undefined, effort/.test(app), false);
  check('the edit request carries them', /body\.images = images/.test(read('src/hooks/useModify.ts')) && /body\.imageCaptions = imageCaptions/.test(read('src/hooks/useModify.ts')), true);
  check('and the plan request carries the descriptions', /\{ imageCaptions \}/.test(read('src/hooks/usePlan.ts')), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
