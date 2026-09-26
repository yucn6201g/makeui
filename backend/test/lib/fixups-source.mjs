// The deterministic fixups, for the tests that bundle them or read what they say.
//
// They were one 2,800-line file, framework-fixups.ts; that file now only applies
// them in order, and the repairs live in the *-fixes.ts modules beside it. A test
// that imports a repair or looks for one in the source uses these, so it does not
// have to know which module a repair is in.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The modules, the one that applies them first. */
export const FIXUP_FILES = [
  'framework-fixups.ts',
  'source-text.ts',
  'vue-fixes.ts',
  'module-fixes.ts',
  'state-fixes.ts',
  'picture-fixes.ts',
  'presentation-fixes.ts',
].map((f) => `src/tools/fixups/${f}`);

/** All of them as one text, line endings normalised. */
export function readFixups() {
  return FIXUP_FILES.map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n').replace(/\r\n/g, '\n');
}

/**
 * An esbuild entry that exports every fixup, as a path relative to backend/.
 * Written on first use, so a test can hand it to esbuild like any source file.
 */
export function fixupsEntry() {
  const rel = 'dist/fixups-entry.ts';
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, FIXUP_FILES.map((f) => `export * from '../${f.replace(/\.ts$/, '.js')}'\n`).join(''));
  return rel;
}
