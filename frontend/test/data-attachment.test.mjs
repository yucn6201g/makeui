// What the composer says about a data file before anything is spent on it.
//
// The record count is the reason the chip exists. It is what the design phase is
// told, and it is the number that decides whether the generated screen gets
// search and paging — so a user who attached the wrong export can see that here,
// rather than after a generation.
//
// Which makes counting it correctly the whole job: a quoted field can contain
// newlines, and counting those as records is how a 300-row export gets announced
// as 900.
//
//   node test/data-attachment.test.mjs      (from frontend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/utils/dataAttachment.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist-test/da.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const { ANY_ATTACHMENT_ACCEPT, attachmentProblem, describeAttachment, isImageAttachment, isPdf, MAX_ATTACHMENT_CHARS, MAX_PDF_BYTES } = await import(
  pathToFileURL(path.join(root, 'dist-test/da.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- what may be attached --------------------------------------------------
for (const name of ['orders.csv', 'export.TSV', 'data.json', 'brand.md', 'notes.txt', 'a.Markdown', 'guide.pdf', 'GUIDE.PDF'])
  check(`${name} is accepted`, attachmentProblem(name, 1000), null);
for (const name of ['photo.png', 'deck.key', 'archive.zip', 'noextension'])
  check(`${name} is refused`, typeof attachmentProblem(name, 1000), 'string');
check('an oversized file is refused', typeof attachmentProblem('a.csv', MAX_ATTACHMENT_CHARS + 1), 'string');
check('and the limit is named in the message', /KB/.test(attachmentProblem('a.csv', MAX_ATTACHMENT_CHARS + 1)), true);

// A PDF is bounded by bytes, and generously, because it is never sent as bytes:
// what travels is the text it yields. Measured: 40KB of PDF, 295 characters of
// text. Holding a PDF to the payload limit would refuse ordinary documents for
// a payload they were never going to contribute to.
check('a PDF gets its own, larger bound',
  attachmentProblem('guide.pdf', MAX_ATTACHMENT_CHARS + 1), null);
check('but not an unlimited one',
  typeof attachmentProblem('guide.pdf', MAX_PDF_BYTES + 1), 'string');
check('and that message names MB, not KB',
  /MB/.test(attachmentProblem('guide.pdf', MAX_PDF_BYTES + 1)), true);
check('isPdf is case-insensitive', [isPdf('a.pdf'), isPdf('a.PDF'), isPdf('a.pdf.csv')], [true, true, false]);

// --- the count -------------------------------------------------------------
const csv = (rows) => ['id,name,note', ...rows].join('\n');

check('a CSV is counted in rows, not lines',
  describeAttachment({ name: 'a.csv', content: csv(['1,a,x', '2,b,y', '3,c,z']) }), '3行');

// The header is not a record. Announcing 4 rows for 3 is the same class of
// error as announcing 900 for 300, just smaller.
check('the header is not counted',
  describeAttachment({ name: 'a.csv', content: 'id,name' }), '0行');

check('a newline inside a quoted field is not a new row',
  describeAttachment({ name: 'a.csv', content: 'id,note\n1,"一行目\n二行目"\n2,"ふつう"' }), '2行');

check('an escaped quote does not end the field',
  describeAttachment({ name: 'a.csv', content: 'id,note\n1,"引用符 "" つき"\n2,x' }), '2行');

check('a trailing newline does not invent a row',
  describeAttachment({ name: 'a.csv', content: csv(['1,a,x', '2,b,y']) + '\n' }), '2行');

check('blank lines between rows are not rows',
  describeAttachment({ name: 'a.csv', content: 'id,name\n\n1,a\n\n\n2,b\n' }), '2行');

check('CRLF is one row break, not two',
  describeAttachment({ name: 'a.csv', content: 'id,name\r\n1,a\r\n2,b\r\n' }), '2行');

check('a large count is readable',
  describeAttachment({ name: 'a.csv', content: csv(Array.from({ length: 4000 }, (_, i) => `${i},n${i},x`)) }), '4,000行');

// A BOM would otherwise become part of the first column name, and the first
// column is what every later lookup is keyed on.
check('a byte-order mark does not change the count',
  describeAttachment({ name: 'a.csv', content: '﻿id,name\n1,a\n2,b' }), '2行');

// --- JSON ------------------------------------------------------------------
check('a JSON array is counted',
  describeAttachment({ name: 'a.json', content: JSON.stringify([{ a: 1 }, { a: 2 }]) }), '2件');
check('an array nested in an object is found',
  describeAttachment({ name: 'a.json', content: JSON.stringify({ meta: {}, rows: [1, 2, 3] }) }), '3件');
check('an object with no array still says what it is',
  describeAttachment({ name: 'a.json', content: JSON.stringify({ a: 1 }) }), 'JSON');
// It is still sent — the build reads unparsable JSON as text — so the chip says
// what will happen rather than that something failed.
// Short, like the counts beside it: a longer label is flex-shrink:0 and at a
// 220px chat pane it took the whole chip, leaving the filename zero pixels wide.
check('unparsable JSON says how it will be treated',
  describeAttachment({ name: 'a.json', content: '{,,,}' }), 'テキスト');

// --- PDF -------------------------------------------------------------------
// Pages beside characters, because that pairing is what tells a scanned PDF from
// a real one at a glance.
check('a PDF shows pages and characters',
  describeAttachment({ name: 'guide.pdf', content: 'あ'.repeat(295), pages: 2 }), '2ページ · 295文字');
check('and characters alone when the page count is unknown',
  describeAttachment({ name: 'guide.pdf', content: 'あ'.repeat(295) }), '295文字');
// 40 pages and 60 characters is a picture book, and this is where that shows.
check('a scanned PDF is visible as such',
  describeAttachment({ name: 'scan.pdf', content: 'あ'.repeat(60), pages: 40 }), '40ページ · 60文字');

// --- text ------------------------------------------------------------------
check('text is measured in characters',
  describeAttachment({ name: 'a.txt', content: 'あいうえお' }), '5文字');
check('markdown too',
  describeAttachment({ name: 'a.md', content: '# 見出し' }), '5文字');

// --- one control, two destinations ------------------------------------------
//
// The composer has a single paperclip now, so the file's own name decides which
// slot it lands in: an image is a reference the design phase looks at, anything
// else is data the screens are populated from. Getting this wrong sends a
// screenshot through the text distiller, or a CSV to a vision prompt.
for (const n of ['shot.png', 'a.JPG', 'b.jpeg', 'c.gif', 'd.webp'])
  check(`${n} is an image`, isImageAttachment(n), true);
for (const n of ['rows.csv', 'notes.md', 'spec.pdf', 'data.json', 'x.txt', 'noext'])
  check(`${n} is not`, isImageAttachment(n), false);
// The extension is the end of the name, not somewhere in it.
check('a name that merely contains png is not an image', isImageAttachment('png-notes.csv'), false);

check('the accept list covers both kinds',
  ['.png', '.webp', '.csv', '.pdf'].every((e) => ANY_ATTACHMENT_ACCEPT.includes(e)), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
