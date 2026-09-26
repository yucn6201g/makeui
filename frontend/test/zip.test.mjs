// The archive has to open.
//
// `createZip` writes the ZIP format by hand — three record layouts and a CRC,
// no library. That is the right call for a few dozen small text files, and it
// is also the shape of mistake nobody notices: a wrong offset or a byte-order
// slip produces a file that looks like a download and fails when someone
// double-clicks it, days later, on their machine.
//
// So this does not assert that bytes came out. It reads the archive back with a
// parser written separately from the writer, and checks every CRC against
// Node's own zlib.crc32 — an implementation that shares no code with the
// module's table. A shared misunderstanding of the spec is the only way both
// halves can agree and both be wrong, and for stored entries the spec is four
// paragraphs long.
//
//   node test/zip.test.mjs      (from frontend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crc32 as nodeCrc32 } from 'node:zlib';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/utils/preview/zip.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist-test/zip.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const { createZip, zipFileName } = await import(
  pathToFileURL(path.join(root, 'dist-test/zip.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/**
 * A reader, written from the spec rather than from the writer above it.
 *
 * Walks the end-of-central-directory record to the central directory, and each
 * central entry to its local header — which is the path a real unzip takes, and
 * the reason a wrong offset is caught here rather than by a user.
 */
function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();

  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record');

  const count = view.getUint16(eocd + 10, true);
  const dirSize = view.getUint32(eocd + 12, true);
  const dirAt = view.getUint32(eocd + 16, true);

  const entries = [];
  let at = dirAt;
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error(`central entry ${i} has no signature`);
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = dec.decode(bytes.slice(at + 46, at + 46 + nameLen));

    if (view.getUint32(localAt, true) !== 0x04034b50) throw new Error(`${name}: local header not at its offset`);
    const localNameLen = view.getUint16(localAt + 26, true);
    const localExtraLen = view.getUint16(localAt + 28, true);
    const localName = dec.decode(bytes.slice(localAt + 30, localAt + 30 + localNameLen));
    const bodyAt = localAt + 30 + localNameLen + localExtraLen;
    const body = bytes.slice(bodyAt, bodyAt + size);

    entries.push({ name, localName, flags, method, crc, size, body });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return { count, dirSize, dirAt, entries, trailing: bytes.length - (eocd + 22) };
}

const AT = new Date('2026-08-28T10:20:30Z');
const FILES = [
  { path: 'index.html', content: '<!DOCTYPE html><title>x</title>' },
  { path: 'src/App.svelte', content: '<script>let a = 1;</scr' + 'ipt>\n<p>{a}</p>\n' },
  { path: 'src/データ/一覧.md', content: '# 見出し\n\n本文です。\n' },
  { path: 'empty.txt', content: '' },
];

const bytes = new Uint8Array(await createZip(FILES, AT).arrayBuffer());
const zip = readZip(bytes);

check('every file is in the archive', zip.count, FILES.length);
check('and nothing follows the end record', zip.trailing, 0);
check('the directory is where the end record says', zip.dirAt + zip.dirSize + 22, bytes.length);
check('paths survive, separators and all', zip.entries.map((e) => e.name), FILES.map((f) => f.path));
// The central directory and the local header must agree, because different
// unzip programs read different ones.
check('both copies of every name agree', zip.entries.filter((e) => e.name !== e.localName), []);

// Stored, not deflated: the whole reason no compression library is needed.
check('every entry is stored', zip.entries.map((e) => e.method), [0, 0, 0, 0]);
// Bit 11 is what stops a Japanese path unzipping as mojibake.
check('every name is flagged UTF-8', zip.entries.every((e) => (e.flags & 0x0800) !== 0), true);

// The check a corrupt archive fails: content, byte for byte, and its CRC.
const enc = new TextEncoder();
check('every body round-trips',
  zip.entries.map((e) => new TextDecoder().decode(e.body)), FILES.map((f) => f.content));
check('and every CRC matches an implementation that shares no code with ours',
  zip.entries.filter((e, i) => e.crc !== (nodeCrc32(Buffer.from(enc.encode(FILES[i].content))) >>> 0)), []);
check('an empty file is a real entry, not a gap', zip.entries[3].size, 0);

// A stamp is a parameter so the bytes are reproducible — which is what lets
// this file assert an archive rather than assert that a function was called.
const again = new Uint8Array(await createZip(FILES, AT).arrayBuffer());
check('the same input at the same stamp is the same archive', Array.from(again), Array.from(bytes));

check('an empty project is still a valid archive', readZip(
  new Uint8Array(await createZip([], AT).arrayBuffer())).count, 0);

// --- the download's own name -------------------------------------------------
check('a title becomes a file name', zipFileName('FABRIC'), 'FABRIC.zip');
check('spaces do not', zipFileName('My Great App'), 'My-Great-App.zip');
// Dropped rather than replaced, so `a/b` reads as `ab` and not as two words.
check('and the characters no filesystem takes are dropped',
  zipFileName('a/b\\c:d*e?f\"g<h>i|j'), 'abcdefghij.zip');
// Nothing left is worse than a fallback: `.zip` downloads as a nameless file.
check('an empty title falls back', zipFileName('   '), 'makeui-project.zip');
/*
 * And the two shapes that are not empty but cannot be file names. A leading
 * dot makes a hidden file on macOS and Linux; a name of only dots is one
 * Windows refuses to create. Both reached the download before this test.
 */
check('a name of only dots falls back too', zipFileName('...'), 'makeui-project.zip');
check('a leading dot does not make a hidden file', zipFileName('.env の見本'), 'env-の見本.zip');
check('and a trailing one is trimmed', zipFileName('v1.'), 'v1.zip');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
