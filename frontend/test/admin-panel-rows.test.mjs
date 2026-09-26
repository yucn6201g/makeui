/**
 * Four things the admin panel got wrong about its own rows.
 *
 * Measured in a browser against the real stylesheet before any of this changed
 * (the harness is throwaway; the numbers are not):
 *
 *   groups table   every row's action cell drew its bottom border 20-29px above
 *                  the rest of the row
 *   history table  the same, 15px, on any row whose prompt wrapped
 *   budget editor  opening it grew the row from 68px to 76px and broke the
 *                  controls onto a second line at a point nothing chose
 *
 * All three of the first two are one cause: `display: flex` on a `<td>`. A flex
 * container is not a table-cell, so it stops stretching to the row's height and
 * its border draws at the height of the button inside it. That is the line under
 * 削除 and 表示 being out of place.
 *
 * The fourth is a count that meant something different from the three beside it.
 *
 * Then a second round on the same rows, because the first pass at the budget
 * editor was measured against a fixture that was wrong: it modelled the editing
 * state as the editor alone in the cell, and the real cell keeps the spend and
 * the budget beside it. Three things in 178px, and the ellipsis fell on the
 * number being edited. Everything below the divider is that round, plus a menu
 * that opened past the edge of the pane it lives in.
 *
 *   node test/admin-panel-rows.test.mjs      (from frontend/)
 */
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN_FILES, readAdminPanel } from './lib/admin-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(root, 'src/index.css'), 'utf8');
const panel = readAdminPanel();
const admin = fs.readFileSync(path.join(root, 'src/hooks/useAdmin.ts'), 'utf8');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/** Every declaration block written for exactly this selector, joined. */
const rules = (sel) => {
  const out = [];
  const needle = `\n${sel} {`;
  for (let i = css.indexOf(needle); i !== -1; i = css.indexOf(needle, i + 1)) {
    out.push(css.slice(i + needle.length, css.indexOf('}', i)));
  }
  return out.join('\n');
};

// --- 1 & 2: the line under the button --------------------------------------
const actionCell = rules('.adm-split .adm-td--action');
check('the action cell rule was found', actionCell.length > 0, true);
// The defect itself. A <td> that is a flex container leaves the table layout and
// its border-bottom no longer lines up with the cells beside it.
check('an action cell in a split pane is not a flex container', /display:\s*flex/.test(actionCell), false);
check('nor a grid one', /display:\s*grid/.test(actionCell), false);
// What replaced it: inline-blocks wrap on their own and the cell stays a cell.
check('the controls still wrap rather than scroll', /white-space:\s*normal/.test(actionCell), true);
check('and still sit at the end of the cell', /text-align:\s*right/.test(actionCell), true);
check('with room between wrapped lines', /line-height/.test(actionCell), true);
// The base rule spaces them; the flex version had zeroed it for `gap`.
check('the margin between two controls is not zeroed',
  /margin-left:\s*0/.test(rules('.adm-split .adm-td--action > * + *')), false);
check('and the base rule still supplies one',
  /margin-left:\s*4px/.test(rules('.adm-td--action > * + *')), true);
// No <td> anywhere may be laid out as flex, for the same reason.
const flexTd = [...css.matchAll(/\n(\.[^\n{]*adm-td[^\n{]*) \{([^}]*)\}/g)]
  .filter((m) => /display:\s*(flex|grid)/.test(m[2]))
  .map((m) => m[1].trim());
check('no cell rule anywhere makes a <td> flex', flexTd, []);

// --- 3: the budget editor ---------------------------------------------------
const editor = rules('.adm-td--num .adm-edit-group');
check('the editor stacks deliberately in a numeric column',
  /flex-direction:\s*column/.test(editor), true);
// It broke after the number field at a place nothing chose. Now it cannot break
// anywhere: the two lines are the two children.
check('and cannot wrap at some other point', /flex-wrap:\s*nowrap/.test(editor), true);
check('on the same 4px the reading state stacks on', /gap:\s*4px/.test(editor), true);
check('the field row exists', rules('.adm-edit-group__field').length > 0, true);
check('and the input fills it', /flex:\s*1/.test(rules('.adm-edit-group__field .adm-input')), true);
check('the buttons have their own row, at the end', /justify-content:\s*flex-end/.test(rules('.adm-edit-group__actions')), true);
check('the markup carries both halves',
  /adm-edit-group__field/.test(panel) && /adm-edit-group__actions/.test(panel), true);

// --- 4: a group that nobody administers ------------------------------------
check('the member row works out whether removing this person strands the group',
  /const stranding = here && u\.isGroupAdmin && members\.length > 1;/.test(panel), true);
const removeBtn = panel.slice(panel.indexOf("run(`mem:${u.username}`") - 700, panel.indexOf("run(`mem:${u.username}`") + 80);
check('and the button is disabled when it would', /disabled=\{busy !== null \|\| stranding\}/.test(removeBtn), true);
// Disabled and silent is a control that looks broken. The reason is the point.
check('with the reason on it', /title=\{stranding/.test(removeBtn), true);
check('naming the way out', /管理者にしてください/.test(panel), true);
// The last member is not blocked — an empty group has nothing to administer.
check('the last member is not caught by it', /members\.length > 1/.test(panel), true);

// --- 5 & 6: the counts ------------------------------------------------------
check('a usage row can carry a project count', /projectCount\?: number;/.test(admin), true);
// The badge used to be whatever the pane was showing — one account, and nothing
// at all until somebody had been chosen, in a row of chips that all count the
// whole account.
check('the tab badge adds every account up',
  /const totalProjects = useMemo\(\(\) => \{[\s\S]*?reduce\(\(n, u\) => n \+ \(u\.projectCount \?\? 0\), 0\)/.test(panel), true);
check('and is the badge that is drawn',
  /\{totalProjects !== null && <span className="adm-tab-badge">\{totalProjects\}<\/span>\}/.test(panel), true);
// Null, not 0: a server older than the count answers no field at all, and 0
// would read as an account with nothing in it.
check('an uncounted response shows no badge rather than zero',
  /counted\.length === 0 \? null :/.test(panel), true);
check('the old per-pane reporting is gone', /onCount/.test(panel), false);

check('each person in the picker carries their own count',
  /adm-userpick__count/.test(panel) && /\{u\.projectCount\} 件/.test(panel), true);
check('and only when the server sent one',
  /typeof u\.projectCount === 'number' &&/.test(panel), true);
check('the count has a style', rules('.adm-userpick__count').length > 0, true);
check('it does not shrink away from a long name', /flex:\s*none/.test(rules('.adm-userpick__count')), true);
check('and the name is what gives way', /flex:\s*1/.test(rules('.adm-userpick__line .adm-email')), true);
// `--figma-text-dim` is already the lightest grey that clears AA here — see the
// palette note. Drawing 0 quieter than the rest has nowhere to go.
check('the count is drawn in an accessible grey',
  /var\(--figma-text-dim\)/.test(rules('.adm-userpick__count')), true);
check('and zero is not drawn in something lighter',
  /adm-userpick__count--none/.test(css) || /adm-userpick__count--none/.test(panel), false);

// --- the figure and the editor cannot share a 178px line -------------------
// Reported after the first pass at this: 「編集ボタンを押すと予算の文字が見切れる」.
// The earlier fixture modelled the editing state as the editor ALONE in the
// cell; the real cell keeps the spend and the budget beside it, and the three
// together came to more than twice the column. `.adm-split .adm-td--num` is
// `text-overflow: ellipsis`, so what it cut was the budget being edited.
check('the editor takes the figure as a child', /children\?: React\.ReactNode;/.test(panel), true);
check('the groups tab hands its money cell over',
  /<BudgetEditor[\s\S]{0,240}>\s*<span className="adm-money-cell">/.test(panel), true);
check('and the user tab its limit', /<BudgetEditor[\s\S]{0,240}>\s*<span className="adm-limit-val">/.test(panel), true);

// The whole point: while editing there is nothing else on the line.
const editorFn = panel.slice(panel.indexOf('function BudgetEditor'), panel.indexOf('function ModelPicker'));
const editingBranch = editorFn.slice(editorFn.indexOf('if (editing)'), editorFn.lastIndexOf('return ('));
check('the editing branch draws no children', /\{children\}/.test(editingBranch), false);
check('the reading branch does', /\{children\}/.test(editorFn.slice(editorFn.lastIndexOf('return ('))), true);
// And a group-admin sees the caller's figure once, not the same number twice.
check('a read-only editor defers to the figure the caller already drew',
  /return children \? <>\{children\}<\/>/.test(editorFn), true);

// --- a member's own budget, from the list they are managed in --------------
check('the members table has a budget column',
  /今月の金額 \/ 予算<\/th>[\s\S]{0,220}利用可能モデル/.test(panel), true);
check('with an editor in it', /onSave=\{\(limit\) => onSetUserLimit\(row\.userId, limit\)\}/.test(panel), true);
check('wired from the panel', /onSetUserLimit=\{setUserLimit\}/.test(panel), true);
// The same route the user tab uses, not a second one to keep in step.
check('over the setter that already existed',
  (panel.match(/onSetLimit=\{setUserLimit\}/g) ?? []).length, 1);
// The empty row spans the table it is in; a stale count leaves a gap.
check('the empty row was widened with it',
  /colSpan=\{5\} className="adm-td adm-td--empty">\s*\{userSearch \? '該当するユーザーがいません'/.test(panel), true);

// --- a menu that opened past the edge of its pane --------------------------
// Measured at the initial 420px chat width: the デザイン menu opened at x=219,
// is 240px wide, so its right edge landed at 459 — and `.app__chat-pane` is
// `overflow: hidden`, which cut 39px off it. What went was the description
// text, which is the reason the menu exists rather than a <select>.
//
// The first fix flipped which edge the menu hung from, measured against the
// nearest CLIPPING ancestor. That handled the pane but not the general case: put
// the same control in a scrolling column — the extended chat's settings — and
// the clipper is a box the menu cannot be flipped out of, because it is taller
// than the space between its own top and the trigger. All four menus were cut.
//
// So the menu no longer lives in its trigger's containing block at all. It is
// placed in VIEWPORT coordinates, which is the only box that really bounds it,
// and no ancestor gets a vote.
const dd = fs.readFileSync(path.join(root, 'src/components/common/Dropdown.tsx'), 'utf8');
check('the menu is placed against the viewport', /position: 'fixed'/.test(dd), true);
check('measured from the trigger', /root\.getBoundingClientRect\(\)/.test(dd), true);
check('and the base rule no longer pins it left', /left:\s*0/.test(rules('.dd__menu')), false);
// The old per-edge classes anchored it to the containing block; leaving them in
// the stylesheet would leave a second, losing answer to where the menu goes.
check('the containing-block classes are gone',
  /dd__menu--(up|down|start|end)/.test(dd + css), false);
// Which edge it hangs from, and which way it opens, are both decided on the
// window: the caller's preference is honoured while it fits and abandoned when
// it does not. `up` is right for the composer, on the floor of its pane, and
// wrong for the same control near the top of a sidebar.
check('it hangs from whichever edge keeps it on screen',
  /r\.left \+ menu\.offsetWidth > window\.innerWidth/.test(dd), true);
check('and opens the other way when the wanted side has no room',
  /placement === 'up'[\s\S]{0,160}above >= below/.test(dd), true);
check('never taller than the room it has', /maxHeight: Math\.max/.test(dd), true);
check('before the frame is painted', /useLayoutEffect/.test(dd), true);
check('and re-measures every time it opens', /place\(\);[\s\S]{0,600}\}, \[open, placement\]\)/.test(dd), true);
// A viewport-anchored menu does not travel with its trigger, so a pane scrolling
// under it must move it rather than leave it hanging over the new content.
check('a scroll under it re-places it', /addEventListener\('scroll', place, true\)/.test(dd), true);
check('and the listener is removed', /removeEventListener\('scroll', place, true\)/.test(dd), true);
// Not drawn at a guessed position while it is still unmeasured.
check('it is invisible until placed', /visibility: 'hidden'/.test(dd), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
