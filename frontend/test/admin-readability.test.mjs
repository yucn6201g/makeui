/**
 * Seven places where the panel held the right number and showed it badly.
 *
 * None of these is a wrong figure. Every one is a figure a person could not
 * read, could not act on, or could not tell from the one beside it — which for
 * a screen whose whole job is reporting is the same defect as being wrong.
 *
 *   the account's spend and its group's were two identical captions stacked,
 *     both 「今月の金額 / 予算」, both at caption size, both separating their two
 *     numbers with a slash. The figure people open the panel to read was the
 *     same weight as its own label.
 *   a month's tokens and requests were one number each, which answers "how
 *     much" and not "on what" — and the tiers differ by five times in price.
 *   getting from a group's member to that member's projects meant leaving the
 *     tab, opening another and typing their name into its search, from a screen
 *     that already knew exactly who was meant.
 *   a prompt was three clamped lines and a `title` tooltip, which cannot be
 *     scrolled, cannot be selected, and goes away when the pointer moves.
 *   every budget was 「$10.00」. A dozen currencies use that sign, and the price
 *     table these figures come from carries a `currency` field precisely
 *     because the amount and the unit are two facts.
 *   the usage tab's empty row spanned eight columns of a six-column table, and
 *     its money column put a right-aligned heading over a value pinned to the
 *     left edge of the cell.
 *   which models a member may use could only be set from the user tab, though
 *     the group's administrator manages that member from the group tab.
 *
 *   node test/admin-readability.test.mjs      (from frontend/)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN_FILES, readAdminPanel, adminSection } from './lib/admin-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const admin = readAdminPanel();
const menu = read('src/components/common/UsageMenu.tsx');
const css = read('src/index.css');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- 1. the account's money, and the group's, told apart ---------------------------
{
  check('the amount is its own line, not half of a caption',
    /usage-menu__allowance-amount/.test(menu), true);
  check('and the largest thing in the block',
    /\.usage-menu__allowance-spent \{[^}]*font-size: 1\.0625rem/.test(css), true);
  /*
   * Both blocks read 「今月の金額 / 予算」, so two identical captions sat one
   * above the other and only a heading above the second told them apart.
   */
  check('the two blocks say whose money each is', [
    menu.includes('label="あなたの利用金額"'),
    menu.includes('label="グループ合計の利用金額"'),
  ], [true, true]);
  // What is left, spelled out rather than inferred from the width of a bar.
  check('and what is left is a number', /usage-menu__allowance-rest/.test(menu), true);
  check('with a rule between the two', /\.usage-menu__allowance ~ \.usage-menu__limits-title/.test(css), true);
}

// --- 2. the counts say which model they went to ------------------------------------
{
  check('there is a per-model breakdown', /function ByModel\(/.test(admin), true);
  check('under the token count', /of=\{\(m\) => formatNumber\(m\.inputTokens \+ m\.outputTokens\)\}/.test(admin), true);
  check('and under the request count', /of=\{\(m\) => formatNumber\(m\.requestCount\)\}/.test(admin), true);

  /*
   * The part no model claims used to be a 「内訳なし」 entry in every cell and is
   * gone on the operator's instruction. What it named has not gone:
   * `tok_<model>_*` began part-way through the product's life, so the rows can
   * add up to a fraction of the total above them — measured 2026-09-10, August
   * is 0 of 165 requests. A breakdown that silently drops most of a month is
   * worse than none, because every number in it looks right.
   *
   * So it is said once, in the model tab's caption, instead of per cell.
   * Comments stripped: the notes explaining the removal name the thing removed.
   */
  const markup = admin.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('the per-cell remainder is gone', /内訳なし/.test(markup), false);
  check('and the coverage is stated once instead',
    /モデル別に記録されているのは \$\{formatNumber\(covered\.requests\)\}/.test(markup), true);
  check('computed rather than assumed', /covered\.total > covered\.requests/.test(markup), true);
}

// --- 3. a member leads to their projects -------------------------------------------
{
  check('the member list can open the projects tab', /onOpenProjects\(row\.userId\)/.test(admin), true);
  check('which is what the panel does with it', /const openProjectsFor = \(userId: string\)/.test(admin), true);
  check('and the projects tab accepts being opened on somebody', /openOn: \{ userId: string; token: number \} \| null/.test(admin), true);
  /*
   * A token as well as an id, so asking for the SAME person twice reopens them.
   * A bare id would equal the one already showing, the effect would not fire,
   * and the button would read as doing nothing.
   */
  check('asking twice for the same person still works', /openOn\.token === openOnRef\.current/.test(admin), true);
  // Only where there is a usage row: the projects tab is addressed by `sub`,
  // which the directory entry does not carry.
  check('and only where the sub is known', /\{row && \(/.test(admin), true);
}

// --- 4. a prompt opens --------------------------------------------------------------
{
  check('the prompt is a button, not a div with a tooltip', /className=\{`adm-prompt\$\{/.test(admin), true);
  check('and says whether it is open', /aria-expanded=\{expanded\.has\(v\.versionId\)\}/.test(admin), true);
  check('the open state drops the clamp', /\.adm-prompt--open \{[^}]*-webkit-line-clamp: unset/.test(css), true);
  // A tooltip that repeated the whole prompt is what this replaces.
  check('the cell no longer leans on a title attribute', /title=\{v\.prompt\}/.test(admin), false);
}

// --- 5. every budget carries its unit ------------------------------------------------
{
  check('money is formatted in one place', [
    /const usd = \(n: number\): string => `\$\$\{money\(n\)\} USD`/.test(admin),
    /const usd = \(n: number\): string => `\$\$\{money\(n\)\} USD`/.test(menu),
  ], [true, true]);
  /*
   * And nothing draws a bare `$`. This is the assertion that matters: adding
   * the helper is easy and missing one of the six call sites is the whole risk.
   */
  const bare = [...admin.matchAll(/\$\$\{money\(/g)].length;
  check('and no bare dollar figure is left in the panel', bare, 1); // the helper itself
  const bareMenu = [...menu.matchAll(/\$\$\{money\(/g)].length;
  check('nor in the account menu', bareMenu, 1);
}

// --- 6. headings sit over their own values --------------------------------------------
{
  /*
   * The empty row said eight columns and seven, left over from when the limits
   * and the model list were on this tab. The header draws six, or five without
   * a price table, so 「該当するユーザーがいません」 ran two columns past the
   * end of the table.
   */
  check('the empty usage row spans the columns that exist',
    /colSpan=\{priced \? 6 : 5\}/.test(admin), true);

  /*
   * `adm-bar-label` pinned the figure to `left: 8px` inside the bar, under a
   * heading that right-aligns — so the column label and the column value sat at
   * opposite ends of the same cell.
   */
  check('the money cell stacks instead of overlaying', /adm-money-cell/.test(admin), true);
  check('and aligns to the same edge as its heading',
    /\.adm-money-cell \{[^}]*align-items: flex-end/.test(css), true);
  check('the label that pinned it left is gone', /adm-bar-label/.test(css), false);

  /*
   * Flex packs to the start whatever `text-align` a cell has, so the groups
   * tab's budget control sat at the left of a right-aligned column.
   */
  check('a control in a numeric column packs to the right',
    /\.adm-td--num \.adm-limit-row \{[^}]*justify-content: flex-end/.test(css), true);
  // A group name is not a model name: `adm-th--model` is the 84px model column.
  check('the group column is sized for a group name', /\.adm-split \.adm-th--grp/.test(css), true);
}

// --- 7. models are settable where the member is managed --------------------------------
{
  const groups = adminSection('GroupsTab.tsx', 'function GroupsTab');
  check('the member row carries a model picker', /<ModelPicker/.test(groups), true);
  check('over the same setter the user tab uses', /onSetModels\(row\.userId, models\)/.test(groups), true);
  /*
   * Joined by email, which is this pool's Cognito username as well: a usage row
   * is keyed by `sub` and a directory row is not, and the address is the only
   * field both hold.
   */
  check('joined to the usage row by the one field both carry',
    /usage\.find\(\(x\) => x\.email && x\.email === u\.email\)/.test(groups), true);
  /*
   * Five now: a budget column was added between the group and the models, so a
   * member's own allowance can be set from the list they are being managed in.
   * The empty row spans the table it is in, and a stale count leaves a gap in it.
   */
  check('and the member table spans all five of its columns', /colSpan=\{5\}/.test(groups), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
