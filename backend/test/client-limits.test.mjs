/**
 * The limits the composer restates, held equal to the API that enforces them.
 *
 * The two packages share no code, so every limit the browser checks before
 * sending is a second copy. A copy that drifts fails in the quiet direction: the
 * composer accepts what the API refuses (an English 400 after the upload), or
 * the API accepts and silently drops what the composer let through — the ninth
 * picture, which is how `MAX_UI_IMAGES` came to exist. Same approach as the
 * storage stand-in: read both copies, compare.
 *
 *   node test/client-limits.test.mjs      (from backend/)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const back = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const front = (p) => fs.readFileSync(path.join(root, '../frontend', p), 'utf8');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
};

/** A numeric constant's value, evaluating the arithmetic it is written with (`5 * 1024 * 1024`, `512_000`). */
function constant(src, name) {
  const m = new RegExp(`const ${name}\\s*=\\s*([0-9_*\\s]+);`).exec(src);
  if (!m) return null;
  return m[1].replace(/_/g, '').split('*').map((x) => Number(x.trim())).reduce((a, b) => a * b, 1);
}

const api = back('src/handlers/lambda-handler.ts');
const composerLimits = front('src/utils/requests/requestLimits.ts');
const uiImages = front('src/utils/requests/uiImages.ts');
const dataAttachment = front('src/utils/requests/dataAttachment.ts');

check('prompt length', constant(composerLimits, 'MAX_PROMPT_CHARS'), constant(api, 'MAX_PROMPT_LENGTH'));
check('and the API value was read', constant(api, 'MAX_PROMPT_LENGTH') > 0, true);
check('picture size', constant(composerLimits, 'MAX_IMAGE_BYTES'), constant(api, 'MAX_IMAGE_SIZE'));
check('picture count', constant(uiImages, 'MAX_UI_IMAGES'), constant(back('src/utils/content-images.ts'), 'MAX_CONTENT_IMAGES'));
check('data file size', constant(dataAttachment, 'MAX_ATTACHMENT_CHARS'), constant(back('src/utils/data-attachment.ts'), 'MAX_ATTACHMENT_CHARS'));

// The extensions the file picker offers, against the ones the API accepts.
const offered = (name) => (new RegExp(`const ${name} = '([^']+)'`).exec(dataAttachment)?.[1] ?? '')
  .split(',').map((e) => e.replace(/^\./, '')).sort();
const acceptedData = (/if \(!\/\\\.\(([a-z|]+)\)\$\/i\.test\(name\)\)/.exec(api)?.[1] ?? '').split('|').sort();
check('data file types', offered('ATTACHMENT_ACCEPT'), acceptedData);
check('and the API list was read', acceptedData.length >= 5, true);
const acceptedImages = [...api.matchAll(/'data:image\/([a-z]+);base64,'/g)].map((m) => m[1]).sort();
const offeredImages = [...new Set(offered('IMAGE_ACCEPT').map((e) => (e === 'jpg' ? 'jpeg' : e)))].sort();
check('picture types', offeredImages, acceptedImages);

// And the composer actually checks the two it restates.
const app = front('src/components/workspace/Workspace.tsx');
check('the brief is checked before sending', /const tooLong = promptProblem\(rawText\)/.test(app), true);
check('an oversized picture is refused when it is picked', /oversizedImages\(picked\.filter/.test(app), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
