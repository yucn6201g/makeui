// Which preset values survive a round trip through storage.
//
// `normalizePreset` is what a stored project's preset is read back through, and
// it replaces anything it does not recognise with 'none'. That was correct while
// the only presets were the five built into the app. It stopped being correct
// the moment a user could import their own: an imported system is
// `system:<uuid>`, which is in no list, so a project built against one would
// reopen as a project built against nothing.
//
// The symptom would not have been an error. It would have been the next edit
// quietly dropping the design system — and the conformance check then measuring
// the document against 'none', which measures nothing and reports clean.
//
//   node test/preset-normalize.test.mjs      (from frontend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/utils/presets.ts')}" --bundle --platform=node ` +
    `--format=esm --jsx=automatic --external:react --external:react/jsx-runtime ` +
    `--outfile="${path.join(root, 'dist-test/ps.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const { normalizePreset, ALLOWED_PRESETS } = await import(
  pathToFileURL(path.join(root, 'dist-test/ps.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const UUID = '8f3c1e2a-4b5d-4c6e-9f70-1a2b3c4d5e6f';

// --- the built-ins still behave exactly as they did ------------------------
for (const id of ALLOWED_PRESETS) check(`${id} survives`, normalizePreset(id), id);
check('an unknown name still falls back', normalizePreset('bootstrap'), 'none');
check('so does undefined', normalizePreset(undefined), 'none');
check('and an empty string', normalizePreset(''), 'none');

// --- a preset from before the importer was removed ---------------------------
//
// `system:<uuid>` named one of the user's own imported design systems. It used
// to survive this untouched, so a project record kept naming what it was built
// against. It falls back now, and the reason is not tidiness: the store and the
// routes are gone, so the server resolves any `system:` preset to 'none' before
// the build starts. Carrying it through would leave the composer's menu blank —
// showing no selection for a design system that is not being applied either.
const UUID_PRESETS = [
  `system:${UUID}`,
  `SYSTEM:${UUID.toUpperCase()}`,
  'system:',
  'system:abc',
  'system:../../etc',
  `system:${UUID}extra`,
  'system:<script>',
];
for (const p of UUID_PRESETS) check(`${p} falls back`, normalizePreset(p), 'none');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
