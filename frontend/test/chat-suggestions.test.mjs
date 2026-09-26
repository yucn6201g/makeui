// The chips on the empty chat screen insert a brief, not their own label.
//
// That screen kept its own list of six strings — 'ECサイトのトップページ',
// 'ダッシュボード画面', 'ログインフォーム' — and clicking one put exactly that
// into the composer. The pipeline is built around a design phase that decides
// screens and information architecture and an interaction designer that
// enumerates every control; handed five words, both have nothing to do, and the
// build produces the one static page the five words describe. The chips looked
// like a shortcut to a template and were a shortcut past it.
//
// They now draw from the same TEMPLATES the panel does. Worth pinning, because
// CHAT_SUGGESTIONS resolves ids against that list and drops what it cannot
// find — so a renamed id would quietly leave the screen with five chips, or
// none, and nothing else would notice.
//
//   node test/chat-suggestions.test.mjs      (from frontend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/data/promptTemplates.ts')}" --bundle --platform=node --format=esm ` +
    `--jsx=automatic --external:react --external:react/* ` +
    `--outfile="${path.join(root, 'dist/cs.test.mjs')}"`,
  { stdio: 'inherit', cwd: root }
);
const { CHAT_SUGGESTIONS } = await import(pathToFileURL(path.join(root, 'dist/cs.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// Six chips, and six is not an accident of a lookup silently failing.
check('every named id resolved to a template', CHAT_SUGGESTIONS.length, 6);

// The chip carries a short label to render and a long brief to insert. If those
// two were ever the same string, the bug this fixes is back.
for (const t of CHAT_SUGGESTIONS) {
  check(`${t.id}: has a label short enough to be a chip`, t.label.length <= 24, true);
  check(`${t.id}: inserts a brief, not the label`, t.prompt !== t.label, true);
  // A real brief names screens and the state they share. The old chips were
  // five words; the shortest template here is several hundred characters.
  check(`${t.id}: the brief is a brief`, t.prompt.length >= 200, true);
  check(`${t.id}: and names its screens`, /画面:/.test(t.prompt), true);
}

// Spread across categories rather than concentrated — the chips are the first
// thing a new user sees and double as a statement of what this product builds.
const categories = new Set(CHAT_SUGGESTIONS.map((t) => t.category));
check('the six span at least five categories', categories.size >= 5, true);

// --- every brief names the parts the pipeline would otherwise guess ------------
/*
 * Read off the data file rather than the six chips, because the property is
 * about all of them: a template is the one place a user is shown what a brief
 * for this product looks like, and a thin example teaches a thin brief.
 *
 * The three sections below were added after measuring where the repair loop
 * spent its passes. A screen is nearly always generated full of data — the only
 * state a brief describes — so the empty one, which is the state a real user
 * meets first, was left to be invented. Same for the narrow window, and for the
 * rules that separate this CRM from any CRM.
 */
import fs from 'node:fs';
// LF on every checkout: a Windows worktree has CRLF, and against it the pattern
// below found no briefs, so none of the checks in the loop ran.
const data = fs.readFileSync(path.join(root, 'src/data/promptTemplates.ts'), 'utf8').replace(/\r\n/g, '\n');
const bodies = [...data.matchAll(/id: '([\w-]+)',[\s\S]*?prompt: `([\s\S]*?)`,\n  \},/g)]
  .map((m) => ({ id: m[1], prompt: m[2] }));
check('the briefs were found at all', bodies.length >= 16, true);
for (const b of bodies) {
  check(`${b.id}: names its screens`, /\n画面:/.test(b.prompt), true);
  check(`${b.id}: and the state they share`, /\n共有する状態:/.test(b.prompt), true);
  // The empty, in-flight and failed states — the ones a brief normally omits.
  check(`${b.id}: and what each looks like when empty`, /\n状態:/.test(b.prompt), true);
  // What folds. Not breakpoints, which belong to the designer.
  check(`${b.id}: and what folds in a narrow window`, /\n画面が狭いとき:/.test(b.prompt), true);
  // The rules that make it this product rather than its category.
  check(`${b.id}: and the rules that make it specific`, /\n外せない点:/.test(b.prompt), true);
  /*
   * And enough screens to be an application. The build scores a router, a
   * store and a list-to-detail route, all of which a single-screen brief
   * leaves with nothing to do — which is the flat output this file exists to
   * stop teaching.
   */
  // Only the bullets under 画面: — 外せない点 is a bulleted list too, and
  // counting those would let a two-screen brief pass on its rules.
  const block = b.prompt.slice(b.prompt.indexOf('画面:')).split('\n\n')[0];
  const screens = (block.match(/^- /gm) ?? []).length;
  check(`${b.id}: names at least five screens`, screens >= 5, true);
  /*
   * Which screens the menu holds (2026-09-23). A storefront built from this
   * brief listed 商品詳細・チェックアウト・注文完了 in its menu and took payment
   * for an empty cart. A brief with a detail, checkout, completion or form reached
   * from something else says so; settings, all sections, has nothing to say.
   */
  if (/詳細|完了|会計|チェックアウト|申込|問い合わせ|受講画面/.test(block)) {
    check(`${b.id}: says which screens the navigation holds`, /\nナビゲーション(?:（[^）]*）)?: /.test(b.prompt), true);
  }
  // Static data loads at once: a loading state is a fake delay the walk photographs.
  check(`${b.id}: asks for no loading state`, /読み込み中/.test(b.prompt), false);
}
/*
 * And no brief specifies colours, fonts or radii. The design phase owns those
 * and a preset can bind them; a brief that names a hex is a brief fighting the
 * design system it was generated under.
 */
const visual = bodies.filter((b) => /#[0-9a-fA-F]{6}|font-family|border-radius|px;/.test(b.prompt));
check('and none of them specifies the visual design', visual.map((b) => b.id), []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
