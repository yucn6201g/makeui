// What is withheld has to be withheld everywhere, and restorable in one edit.
//
// 思考モード and Opus are withdrawn provisionally: this account's throughput
// allocation for every Opus it could reach from Japan is zero, against an AWS
// default of 21.6 billion tokens a day, on a quota that is not self-service.
// config/withdrawn.ts carries the measurement.
//
// A withdrawal is four places — the server's tier clamp, the server's mode
// table, the /models endpoint, and the composer's two menus — and the failure
// worth a test is a partial one. A model left in the menu that the server
// refuses is the thing the composer's own comment says to avoid: the user picks
// Opus, waits, and receives Sonnet without being told why. And a mode left in
// the menu whose profile has been substituted is worse, because it succeeds.
//
// The lists are read out of withdrawn.ts rather than restated, so restoring
// something is deleting a line and this file follows it.
//
//   node test/withdrawn.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const front = path.resolve(root, '..', 'frontend');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

execSync(
  `npx esbuild "${path.join(root, 'src/config/withdrawn.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/wd.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const { WITHDRAWN_MODELS, WITHDRAWN_NOTE } = await import(
  pathToFileURL(path.join(root, 'dist/wd.test.mjs')).href
);

const app = fs.readFileSync(path.join(front, 'src/App.tsx'), 'utf8');
const hook = fs.readFileSync(path.join(front, 'src/hooks/useModels.ts'), 'utf8');
const handler = fs.readFileSync(path.join(root, 'src/handlers/lambda-handler.ts'), 'utf8');

// An empty list is the restored state and must not read as "all clear" by
// vacuity — say so, and skip the rest rather than printing passes that asserted
// nothing.
if (WITHDRAWN_MODELS.length === 0) {
  console.log('nothing is withdrawn; there is nothing to check\n\n0 passed, 0 failed');
  process.exit(0);
}

/*
 * The mode menu used to be checked here too, because 思考モード fixed Opus and a
 * mode delivering Sonnet on every request is the menu lying.
 *
 * A mode no longer chooses a model — see config/effort.ts — so there is no mode
 * a withheld model can make unusable, and nothing to withhold beyond the model
 * itself. What follows is the model, in the four places it is offered or
 * enforced.
 */

// --- the composer's model list, before and after the fetch --------------------
const fallback = hook.slice(hook.indexOf('const FALLBACK'), hook.indexOf('];', hook.indexOf('const FALLBACK')));
const preFetch = [...fallback.matchAll(/id: '(\w+)'/g)].map((m) => m[1]);
check('the fallback list was read', preFetch.includes('sonnet'), true);
for (const m of WITHDRAWN_MODELS) {
  /*
   * The fallback is on screen only until /models answers — which is exactly long
   * enough to offer a model and take it away again, and to leave it selected if
   * someone is quick.
   */
  check(`the pre-fetch list does not offer ${m}`, preFetch.includes(m), false);
}

// --- and the server, which is the enforcement ---------------------------------
check('/models filters the withdrawn ids', /\.filter\(\(m\) => !isWithdrawnModel\(m\.id\)\)/.test(handler), true);

execSync(
  `npx esbuild "${path.join(root, 'src/config/model-config.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/mc2.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'pipe', cwd: root }
);
const { decideTier } = await import(pathToFileURL(path.join(root, 'dist/mc2.test.mjs')).href);

const ALL = ['haiku', 'sonnet', 'opus', 'auto'];
for (const m of WITHDRAWN_MODELS) {
  const d = decideTier(m, ALL);
  check(`asking for ${m} outright does not get it`, d.tier === m, false);
  check(`and the request is marked as lowered`, d.limited, true);
}
/*
 * `auto` must not route to it either. Restricting only what the user typed
 * would leave a withdrawn model reachable by leaving the dropdown alone — the
 * reason the clamp takes the permitted SET rather than a tier.
 */
for (const m of WITHDRAWN_MODELS) {
  check(`auto cannot land on ${m}`, decideTier('auto', ALL, m).tier === m, false);
}
// The models that are not withdrawn still resolve to themselves, so the clamp
// has not simply been broken.
check('sonnet still resolves to sonnet', decideTier('sonnet', ALL).tier, 'sonnet');
check('haiku still resolves to haiku', decideTier('haiku', ALL).tier, 'haiku');

/*
 * And what the user is told. The permitted-set clamp says 「管理者の設定により」,
 * which would be a lie here: no administrator chose this, and someone acting on
 * it would go looking at a setting that has nothing to do with the reason.
 */
check('the note does not blame an administrator', /管理者/.test(WITHDRAWN_NOTE), false);
check('and it is what the resolver reaches for',
  fs.readFileSync(path.join(root, 'src/config/model-config.ts'), 'utf8').includes('? WITHDRAWN_NOTE'), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
