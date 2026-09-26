/**
 * What the editing pass asks a thin brief for.
 *
 * The pipeline's output tracks the brief closely, which is what makes a thin
 * brief expensive: 「予約システム作って」 leaves the model to invent the screens,
 * the fields, the states and the data, and the repair loop then spends passes on
 * the parts it guessed badly.
 *
 * So the six things SYSTEM asks for are not a wish list — each is something the
 * build has to decide, decides badly unprompted, and cannot be fixed afterwards
 * by a repair pass. This file pins them, and pins the prohibitions that keep the
 * rewrite from fighting the design phase.
 *
 * It also pins the agreement with the composer's templates. Those are what a
 * user is shown a good brief looks like; a refiner asking for something else
 * would teach two different lessons about the same thing, and the two would
 * drift apart the first time either was edited alone.
 *
 *   node test/refine-prompt.test.mjs      (from backend/)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const src = read('src/orchestration/edit/refine-prompt.ts');
const system = src.slice(src.indexOf('const SYSTEM = `'), src.indexOf('`;', src.indexOf('const SYSTEM = `')));

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

check('the prompt was found at all', system.length > 500, true);

// --- the six things a build cannot decide well on its own ----------------------
/*
 * Five screens or more, and which reaches which: a single-screen brief leaves
 * the router, the store and the list-to-detail route with nothing to do, and
 * those are most of what an application is.
 */
check('it asks for a screen list', /画面の一覧/.test(system), true);
check('with a floor on the count', /5つ以上/.test(system), true);
check('and for the route between them', /どの画面がどの画面に繋がる/.test(system), true);
// The cross-screen consequence is the difference between a store and five
// screens each holding their own copy of the same value.
check('it asks what an action changes elsewhere', /画面をまたぐ因果/.test(system), true);
/*
 * The empty, in-flight and failed states. A brief describes a screen with data
 * in it, so that is the only state that gets built — and it is not the state a
 * user meets first.
 */
check('it asks for the empty state', /0件になったとき/.test(system), true);
check('the in-flight one', /送信中/.test(system), true);
check('and the failure', /送信に失敗したとき/.test(system), true);
// "商品一覧" produces twelve identical invented rows; "12点、3,000円〜28,000円"
// does not.
check('it asks for the volume of the data', /件数の規模/.test(system), true);
check('and the range of its values', /値の幅/.test(system), true);
/*
 * And the rules that make this product not the generic one in its category.
 * This is the section that decides whether the output could be any CRM or is
 * this CRM.
 */
check('it asks for the rules that make it specific',
  /一般的なものと違わせている決まりごと/.test(system), true);

// --- what it must not add -------------------------------------------------------
/*
 * The design phase owns the visual language and a preset can bind it. A brief
 * that names a hex or a radius is a brief fighting the design system it will be
 * generated under.
 */
check('it refuses to specify the visual design', /見た目の指定を足さない/.test(system), true);
check('or a technology', /技術スタックやライブラリ名/.test(system), true);
check('or features nobody asked for', /求めていない機能を足さない/.test(system), true);
// The user's own words survive. A brief that quietly became something else is a
// UI arriving with screens nobody asked for.
check('and it drops nothing the user wrote', /一つも落とさない/.test(system), true);
// A suggestion identical to the input is not a suggestion, which is what this
// instruction looks like when it is followed exactly.
check('a sufficiently specific brief is left alone', /ほとんど書き換えない/.test(system), true);

// --- a demonstrated shape, not a described one ----------------------------------
/*
 * Haiku follows a worked example far more reliably than a list of requirements.
 * The cost is about 700 input tokens on a call that already exists — under a
 * tenth of a cent against a generation of roughly forty.
 */
check('the prompt carries a worked example', /^例（依頼文が/m.test(system), true);
for (const heading of ['画面:', '共有する状態:', '状態:', 'データ:', '外せない点:']) {
  check(`and the example shows ${heading}`, system.includes(`\n${heading}`), true);
}

// --- the reply is still parseable ------------------------------------------------
check('the reply shape is stated', /\{"prompt":"書き直した依頼文","notes":/.test(system), true);
check('with nothing around it', /前後に文章を書かない/.test(system), true);
check('and the notes are bounded', /最大4件/.test(system), true);
// Bounded on the way in too: an editing pass is worth having only while it costs
// a fraction of the build it precedes.
check('the input is capped', /MAX_INPUT_CHARS = \d+/.test(src), true);
/*
 * And the output cap has to fit what is now being asked for. 1,200 tokens
 * truncated a brief of about 800 Japanese characters, which fails in the worst
 * way available: it parses, it reads as finished, and the section that was cut
 * is the one the model never sees.
 */
const cap = Number(/MAX_OUTPUT_TOKENS = (\d+)/.exec(src)?.[1]);
check('and the output cap fits the brief it asks for', cap >= 2000, true);

// --- always Haiku ------------------------------------------------------------------
/*
 * Read from configuration rather than taken as an argument, so no caller can
 * raise it. This runs on a keystroke-adjacent action, before any generation is
 * paid for.
 */
check('the model is not a parameter', /refinePrompt\(\s*prompt: string/.test(src), true);
check('it comes from the configuration', /config\.haikuId/.test(src), true);

// --- the refiner and the templates ask for the same thing ---------------------------
/*
 * The templates are the one place a user is shown what a good brief looks like.
 * If the refiner asked for a different shape, the product would be teaching two
 * lessons about the same thing — and the two would drift the first time either
 * was edited alone.
 */
const templates = read('../frontend/src/data/promptTemplates.ts');
for (const heading of ['画面:', '共有する状態:', '状態:', '外せない点:']) {
  check(`the templates use ${heading} too`, templates.includes(`\n${heading}`), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
