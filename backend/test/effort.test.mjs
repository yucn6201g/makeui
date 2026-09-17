// What a mode decides, and what it must not.
//
// This was four modes on one dial, and the dial carried two decisions: how much
// of the pipeline to run, and which model to run it on. The two do not order
// together, so the ladder it presented was not one. Measured over 30 days on
// the deployed system:
//
//   economy (Haiku)  67% failed to compile first time, 4 calls, 85k out, 440s
//   fast    (Sonnet) 25% failed to compile first time, 2 calls, 50k out, 278s
//
// 「高速」 came out FASTER than 「節約」 while doing strictly more work — same
// stages plus retrieval, on a slower model — because the weaker model broke the
// build twice as often and every break bought an emergency repair pass. Two ends
// of a dial that can swap places are not a dial.
//
// So there are two modes and they differ in one thing. The model is the
// picker's, and the assertions at the end are the ones that keep it that way.
//
//   node test/effort.test.mjs      (from backend/)
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist/effort.test.mjs');
fs.mkdirSync(path.dirname(out), { recursive: true });
await esbuild.build({
  entryPoints: [path.join(root, 'src/config/effort.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile: out,
});
const { EFFORT_PROFILES, effortProfile, isEffort, normalizeEffort } =
  await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const { draft, checked } = EFFORT_PROFILES;

// --- there are two, and they answer one question --------------------------------
check('two modes, no more', Object.keys(EFFORT_PROFILES).sort(), ['checked', 'draft']);

// 下書き is sold as "no checking, and it may not work". What makes it cheap is
// skipping the stages that check, so each of those has to actually be off.
check('draft skips the design graph', draft.designGraph, false);
check('draft skips verification', draft.browserVerify, false);
check('draft runs no repair', draft.repairPasses, 0);
check('draft skips the vision critic', draft.visualCritic, false);

// --- the default must not have moved --------------------------------------------
// 仕上げ is what every generation did before modes existed. Restructuring the
// menu must not change what somebody gets by leaving it alone.
check('checked runs the design graph', checked.designGraph, true);
check('checked runs retrieval', checked.knowledgeBase, true);
check('checked runs verification', checked.browserVerify, true);
check('checked repairs three times', checked.repairPasses, 3);
check('checked runs the vision critic', checked.visualCritic, true);
check('checked keeps the library default image count', checked.stockImages, 5);

// --- and they differ ONLY in checking -------------------------------------------
/*
 * The inputs are equal on purpose. `fast` had retrieval and five images while
 * `economy` had neither, which made 「cheap」 mean two unrelated things at once —
 * fewer stages AND less context — and neither mode said which. Retrieval and
 * the image count are inputs, not checks, so they do not belong on this axis.
 */
check('the two modes agree about every input', [
  draft.knowledgeBase === checked.knowledgeBase,
  draft.stockImages === checked.stockImages,
  draft.perFileBuild === checked.perFileBuild,
], [true, true, true]);

const checks = (p) =>
  (p.designGraph ? 1 : 0) + (p.browserVerify ? 1 : 0) + (p.visualCritic ? 1 : 0) + p.repairPasses;
check('and differ only by how much they check', checks(draft) < checks(checked), true);

// --- the model is nobody's business but the picker's -----------------------------
/*
 * The assertion this file exists for now.
 *
 * `fixedModel` let a mode override the model picker, and three of the four did
 * — so the menu and the picker were two controls for one decision, with one
 * silently winning. Re-adding it to either profile fails here, which is the
 * point: the coupling was removed deliberately and this is what stops it
 * growing back.
 */
for (const [name, profile] of Object.entries(EFFORT_PROFILES)) {
  check(`${name} does not choose a model`, 'fixedModel' in profile, false);
}
const src = fs.readFileSync(path.join(root, 'src/config/effort.ts'), 'utf8');
check('and nothing here resolves one', /export function modelForRun/.test(src), false);

// --- what an unknown or missing value does ---------------------------------------
/*
 * Absent means checked, and the direction matters: an unrecognised value gets
 * the build that IS verified. Defaulting the other way would mean a typo, an
 * old client or a truncated field silently buying the pipeline that ships
 * unexamined output.
 */
check('missing effort is checked', effortProfile(undefined), checked);
check('an unknown effort is checked', effortProfile('turbo'), checked);
check('so is a non-string', effortProfile(3), checked);

// --- and the four names it replaced still arrive ---------------------------------
/*
 * A job stored under an old name is resumed months later; a tab left open sends
 * one; a version row written in August carries one. Rejecting them would fail a
 * build over a menu item that used to exist, so they are mapped rather than
 * refused — and mapped by MEANING: the two that skipped checking become draft,
 * the two that did not become checked.
 */
const LEGACY = [['economy', 'draft'], ['fast', 'draft'], ['standard', 'checked'], ['thinking', 'checked']];
for (const [old, want] of LEGACY) {
  check(`${old} still arrives, as ${want}`, normalizeEffort(old), want);
  check(`and ${old} is still a known effort`, isEffort(old), true);
  check(`and gets ${want}'s profile`, effortProfile(old), EFFORT_PROFILES[want]);
}
check('the current names normalise to themselves',
  [normalizeEffort('draft'), normalizeEffort('checked')], ['draft', 'checked']);
check('plan is NOT an effort', isEffort('plan'), false);
check('an unknown string is not', isEffort('turbo'), false);
check('a non-string is not', isEffort(3), false);
check('and neither normalises', [normalizeEffort('turbo'), normalizeEffort(3)], [undefined, undefined]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
