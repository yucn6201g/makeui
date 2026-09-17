// One rule has to hold between the two flags on a project record:
//
//   AN ARCHIVED PROJECT IS NEVER A FAVOURITE.
//
// They say opposite things about the same project — put away, and marked as
// wanted — and if both could be set then every list that reads one would have
// to decide what the other means. The archive tab would hold favourites, and
// the star that pins a project to the top of the active list would be pinning
// something that is not in it.
//
// The second rule is DynamoDB's: an update expression cannot both SET and
// REMOVE the same attribute. A single request asking to archive and favourite
// at once would build exactly that, so something has to win, and it is the
// archive.
//
//   node test/project-flags.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/services/project-service.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/pfl.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'pipe', cwd: root }
);
const { flagUpdates } = await import(pathToFileURL(path.join(root, 'dist/pfl.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const NOW = '2026-08-26T00:00:00.000Z';
const f = (u) => flagUpdates(u, NOW);

check('nothing asked, nothing written', f({}), { sets: [], removals: [], values: {} });

const archived = f({ archived: true });
check('archiving stamps the time', archived.sets, ['archivedAt = :archivedAt']);
check('and clears the star', archived.removals, ['favouritedAt']);
check('with the timestamp bound', archived.values, { ':archivedAt': { S: NOW } });

// Un-archiving REMOVEs rather than writing an empty string: `archivedAt: ''`
// would be a second spelling of "not archived" and every reader would have to
// know both. The star is not restored — it was cleared, not hidden.
const restored = f({ archived: false });
check('un-archiving removes the attribute', restored.removals, ['archivedAt']);
check('and sets nothing', restored.sets, []);

const starred = f({ favourite: true });
check('favouriting stamps the time', starred.sets, ['favouritedAt = :favouritedAt']);
check('and removes nothing', starred.removals, []);
check('un-favouriting removes it', f({ favourite: false }).removals, ['favouritedAt']);

// The two together. Without this the expression names `favouritedAt` in both
// halves, and DynamoDB rejects the whole update — which would take the
// archiving down with it.
const both = f({ archived: true, favourite: true });
check('archive and favourite at once: the archive wins', both.sets, ['archivedAt = :archivedAt']);
check('and the star is cleared, not set', both.removals, ['favouritedAt']);
check('so no attribute is in both halves',
  both.sets.filter((e) => both.removals.some((r) => e.startsWith(r))), []);

// The other direction is not a conflict — both want the star gone.
const cleared = f({ archived: true, favourite: false });
check('archiving while clearing the star lists it once', cleared.removals, ['favouritedAt']);

// Un-archiving and favouriting in one request is coherent: the project comes
// back and is starred, and the two attributes do not collide.
const back = f({ archived: false, favourite: true });
check('restoring and starring together is allowed', back.sets, ['favouritedAt = :favouritedAt']);
check('and removes only the archive stamp', back.removals, ['archivedAt']);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
