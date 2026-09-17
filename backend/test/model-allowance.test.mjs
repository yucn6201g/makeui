// Tests for the administrator's model permissions.
//
// The clamp decides what a user's request actually costs, and it is invisible
// when wrong: an over-permissive set spends Opus money for someone restricted to
// Haiku, and nothing in the output says so. `auto` is the member worth the most
// attention — it is not a model, it is a decision that can land on Opus, so
// allowing Opus and allowing `auto` are different permissions.
//
// The set replaced a ladder, so the first block below is the old ladder's whole
// truth table, asserted against the new rules. A rewrite that changes behaviour
// for the settings people already have is a rewrite that silently re-permits
// them, and every stored ladder expands into one of these sets on read.
//
//   node test/model-allowance.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

execSync(
  `npx esbuild "${path.join(root, 'src/config/model-config.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/mc.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'inherit', cwd: root }
);
const { decideTier, fixedTierFor } = await import(pathToFileURL(path.join(root, 'dist/mc.test.mjs')).href);

execSync(
  `npx esbuild "${path.join(root, 'src/services/token-usage.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/tu.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'inherit', cwd: root }
);
const { normalizeModelSet } = await import(pathToFileURL(path.join(root, 'dist/tu.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}
      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const ORDER = { haiku: 0, sonnet: 1, opus: 2 };
/**
 * The real decision, with the classifier's answer supplied rather than called.
 *
 * The offered set is passed explicitly, and it is all three. This file is about
 * the clamp — what an administrator's permitted set does to a request — and a
 * model being temporarily withheld from the build is a different question,
 * asked in withdrawn.test.mjs. Letting the withdrawal reach in here would
 * silently retire every Opus case for as long as it lasts, which is exactly
 * when the rules are most likely to be edited.
 */
const OFFERED = ['haiku', 'sonnet', 'opus'];
const decide = (requested, allowed, routerPicks) => {
  const first = decideTier(requested, allowed, undefined, OFFERED);
  if (!first.useRouter) return { ...first, ranRouter: false };
  return { ...decideTier(requested, allowed, routerPicks ?? 'opus', OFFERED), ranRouter: true };
};

// --- the ladder that this replaced, as sets -------------------------------
// What each stored rung expands to on read. These must behave exactly as the
// ladder did, or shipping the checkboxes changes what existing users may run.
const LADDER = {
  haiku: ['haiku'],
  sonnet: ['haiku', 'sonnet'],
  opus: ['haiku', 'sonnet', 'opus'],
  auto: ['haiku', 'sonnet', 'opus', 'auto'],
};
const ceilingOf = (rung) => (rung === 'auto' ? 'opus' : rung);
for (const [rung, allowed] of Object.entries(LADDER)) {
  for (const requested of ['haiku', 'sonnet', 'opus']) {
    const permitted = ORDER[requested] <= ORDER[ceilingOf(rung)];
    const want = permitted ? requested : ceilingOf(rung);
    check(`ladder ${rung} / asks ${requested} → ${want}`, decide(requested, allowed).tier, want);
  }
}

// --- auto is its own permission ------------------------------------------
// The whole reason `auto` is a member rather than implied: it can choose Opus,
// so restricting only what the user typed leaves Opus reachable by leaving the
// dropdown alone.
check('auto without auto does not run the router', decide('auto', LADDER.opus).ranRouter, false);
check('and lands on the top permitted model', decide('auto', LADDER.opus).tier, 'opus');
check('auto without auto, up to sonnet', decide('auto', LADDER.sonnet).tier, 'sonnet');
check('auto without auto, haiku only', decide('auto', LADDER.haiku).tier, 'haiku');
// Not running the classifier is the point: asking a model which model to use and
// then overriding it is a call that buys nothing.
check('no router call when auto is forbidden', decide('auto', LADDER.haiku).ranRouter, false);

check('auto permitted runs the router', decide('auto', LADDER.auto).ranRouter, true);
check('and keeps what it picked', decide('auto', LADDER.auto, 'opus').tier, 'opus');
check('a modest pick is kept too', decide('auto', LADDER.auto, 'haiku').tier, 'haiku');
check('nothing is reported as limited there', decide('auto', LADDER.auto, 'opus').limited, false);

// --- sets the ladder could not express -----------------------------------
// The reason for the change. Each of these is a setting an administrator can now
// make and previously could not, so each is a rule with no prior art to inherit.

// A gap in the middle. Sonnet is off; asking for it falls to the best permitted
// model *below* it, never up — a withdrawn model must not become an upgrade.
const gap = ['haiku', 'opus'];
check('gap / asks sonnet → haiku', decide('sonnet', gap).tier, 'haiku');
check('gap / asks sonnet is flagged as limited', decide('sonnet', gap).limited, true);
check('gap / asks haiku → haiku', decide('haiku', gap).tier, 'haiku');
check('gap / asks opus → opus', decide('opus', gap).tier, 'opus');
check('gap / an allowed choice is not limited', decide('opus', gap).limited, false);

// Only the expensive one. Nothing is permitted below Haiku, so the request goes
// up rather than failing — refusing to run is worse than running dearer.
const opusOnly = ['opus'];
check('opus only / asks haiku → opus', decide('haiku', opusOnly).tier, 'opus');
check('opus only / that is a limit', decide('haiku', opusOnly).limited, true);
check('opus only / asks sonnet → opus', decide('sonnet', opusOnly).tier, 'opus');

// Only the cheap one, with auto on. The router may say Opus; the set says no.
const haikuAuto = ['haiku', 'auto'];
check('haiku+auto runs the router', decide('auto', haikuAuto).ranRouter, true);
check('haiku+auto clamps an opus pick', decide('auto', haikuAuto, 'opus').tier, 'haiku');
check('haiku+auto reports the clamp', decide('auto', haikuAuto, 'opus').limited, true);
check('haiku+auto keeps a haiku pick', decide('auto', haikuAuto, 'haiku').tier, 'haiku');
check('haiku+auto does not flag a kept pick', decide('auto', haikuAuto, 'haiku').limited, false);

// Auto with a gap: the router's middle choice is clamped down, not up.
const gapAuto = ['haiku', 'opus', 'auto'];
check('gap+auto clamps a sonnet pick to haiku', decide('auto', gapAuto, 'sonnet').tier, 'haiku');
check('gap+auto keeps an opus pick', decide('auto', gapAuto, 'opus').tier, 'opus');

// --- a set with no model in it -------------------------------------------
// The resolver ignores it rather than refusing every request, because a user
// with nothing permitted cannot be served at all. The endpoint is what refuses
// to store it — see the next block.
check('an empty set is ignored, not enforced', decide('opus', []).tier, 'opus');
check('auto alone is ignored too', decide('opus', ['auto']).tier, 'opus');

// --- what may be stored ---------------------------------------------------
check('a plain set is accepted', normalizeModelSet(['opus', 'haiku']), ['haiku', 'opus']);
check('order is canonical, not as sent', normalizeModelSet(['auto', 'opus']), ['opus', 'auto']);
check('duplicates collapse', normalizeModelSet(['haiku', 'haiku']), ['haiku']);
check('every model is fine', normalizeModelSet(['haiku', 'sonnet', 'opus', 'auto']), ['haiku', 'sonnet', 'opus', 'auto']);
// Unchecking everything must not be stored as "unrestricted", which is what the
// resolver would make of it.
check('an empty set is refused', normalizeModelSet([]), null);
check('auto alone is refused', normalizeModelSet(['auto']), null);
check('an unknown id is refused', normalizeModelSet(['haiku', 'gpt']), null);
check('a non-array is refused', normalizeModelSet('haiku'), null);
check('null is refused', normalizeModelSet(null), null);

// --- a job with no brief to route on ----------------------------------------
//
// Reverse-engineering is handed an image, not a prompt, so there is nothing to
// classify. It used to pick its model entirely inside the agent, from its
// argument alone, and consulted nobody about permissions — so the setting every
// other path rounds into did not apply there at all.
const ALL = ['haiku', 'sonnet', 'opus', 'auto'];

check('unrestricted and unasked is sonnet, as it has always been',
  fixedTierFor(undefined, ALL, OFFERED), 'sonnet');
check('so is auto, because there is no brief to route on',
  fixedTierFor('auto', ALL, OFFERED), 'sonnet');
check('and auto does NOT get promoted to the top of the set',
  fixedTierFor('auto', ALL, OFFERED) === 'opus', false);
check('an explicit choice is honoured when permitted', fixedTierFor('opus', ALL, OFFERED), 'opus');

// The clamp that was missing.
check('opus asked for by a haiku-only user becomes haiku',
  fixedTierFor('opus', ['haiku'], OFFERED), 'haiku');
check('and auto by that user becomes haiku too',
  fixedTierFor('auto', ['haiku'], OFFERED), 'haiku');
check('a no-opus user asking for opus gets sonnet',
  fixedTierFor('opus', ['haiku', 'sonnet'], OFFERED), 'sonnet');
// Rounding goes DOWN to the nearest permitted tier, never up.
check('haiku asked for by an opus-only user is the only tier there is',
  fixedTierFor('haiku', ['opus'], OFFERED), 'opus');

// --- every field on the resolved model is one somebody reads --------------------
//
// `BedrockModelConfig` carried `maxTokens`, `temperature` and `region` for
// months and nothing read any of them. `temperature: 0.7` for Opus in particular
// reads as a design decision — it was asked about as a possible cause of Opus
// being refused — and it never reached Bedrock at all.
//
// A dead field on a config type is worse than a missing one. It answers a
// question wrongly, and the answer looks authoritative because it is sitting in
// the file named for it.
{
  const configSrc = fs.readFileSync(path.join(root, 'src/config/model-config.ts'), 'utf8');
  const body = configSrc.slice(
    configSrc.indexOf('export interface BedrockModelConfig'),
    configSrc.indexOf('}', configSrc.indexOf('export interface BedrockModelConfig'))
  );
  const fields = [...body.matchAll(/^\s{2}(\w+)[?]?:/gm)].map((m) => m[1]);
  check('the interface was read', fields.length > 0, true);

  /*
   * Read across the whole of src, minus the file that defines them — the
   * definition is not a use. Anything reached through `ResolvedModel` counts,
   * since that is what the resolvers actually hand back.
   */
  const consumers = ['src/orchestration/graph.ts', 'src/orchestration/meta-orchestrator.ts', 'src/handlers/lambda-handler.ts']
    .map((f) => fs.readFileSync(path.join(root, f), 'utf8'))
    .join('\n');
  const unread = fields.filter((f) => !new RegExp(`\\.${f}\\b`).test(consumers));
  check('no field on the resolved model goes unread', unread, []);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
