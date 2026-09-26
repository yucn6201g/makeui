/**
 * Archiving and deleting several projects at once.
 *
 * Built over the per-project routes rather than a new bulk endpoint, because the
 * server's rules live on those routes — a DELETE is refused with 409 unless the
 * project was archived first, and deleting takes the stored document and the
 * chat thread with it. A second endpoint would be a second copy of those rules.
 *
 * The properties pinned here are the ones that make that safe:
 *
 *   - bounded concurrency, because the unbounded version already happened: 257
 *     writes in 24 seconds on one user's partition throttled DynamoDB on
 *     2026-09-02 and produced sixty 500s
 *   - only what is on screen is acted on, so a filter applied after selecting
 *     cannot put hidden projects into "12件をアーカイブ"
 *   - deleting takes a second, explicit step that states the count
 *
 *   node test/bulk-projects.test.mjs      (from frontend/)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const hook = read('src/hooks/useProjects.ts');
const list = read('src/components/project-list/ProjectList.tsx');
const css = read('src/index.css');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- the hook --------------------------------------------------------------------
check('a bulk archive exists', /const archiveProjects = useCallback/.test(hook), true);
check('and a bulk delete', /const deleteProjects = useCallback/.test(hook), true);
check('both are returned', /archiveProjects,[\s\S]{0,80}deleteProjects/.test(hook.slice(hook.lastIndexOf('return {'))), true);

// Over the same routes the single-project controls use.
check('archive goes through PUT /projects/:id', /archiveProjects[\s\S]{0,900}method: 'PUT'[\s\S]{0,200}JSON\.stringify\(\{ archived \}\)/.test(hook), true);
check('delete goes through DELETE /projects/:id', /deleteProjects[\s\S]{0,700}method: 'DELETE'/.test(hook), true);

// --- bounded ------------------------------------------------------------------------
/*
 * Four at a time. Not a number chosen for speed: a normal selection finishes in
 * well under a second either way, and what four buys is that fifty selected
 * projects cannot become fifty simultaneous writes on one partition key.
 */
const cap = Number(/const CONCURRENCY = (\d+)/.exec(hook)?.[1]);
check('requests are bounded', cap > 0 && cap <= 6, true);
check('by a worker pool, not Promise.all over every id',
  /Array\.from\(\{ length: Math\.min\(CONCURRENCY, ids\.length\) \}, worker\)/.test(hook), true);
check('and the bulk calls use it', (hook.match(/await runBounded\(/g) ?? []).length, 2);

// --- failures are counted, and the list is reconciled --------------------------------
check('a partial failure refetches rather than trusting the optimistic list',
  /if \(failed > 0\) \{[\s\S]{0,200}fetchProjects\(\)/.test(hook), true);
check('and says how many did not go through', /件のうち\$\{failed\}件/.test(hook), true);
// 409 names a different thing to do, so it is counted apart.
check('a refusal to delete an unarchived project is reported as that',
  /res\.status === 409\) refused \+= 1/.test(hook) && /アーカイブされていないため削除できませんでした/.test(hook), true);

// --- the list: only what is on screen -------------------------------------------------
check('the selection is restricted to the shown projects',
  /const selectedShown = shown\.filter\(\(p\) => selected\.has\(p\.projectId\)\)/.test(list), true);
check('and actions read that, not the raw selection',
  /const ids = selectedShown\.map\(\(p\) => p\.projectId\)/.test(list), true);
check('the count shown is the same set', /\{selectedShown\.length\}件を選択中/.test(list), true);
// A selection belongs to the list it was made in.
check('switching tabs clears it', (list.match(/setConfirmingDelete\(null\); leaveSelecting\(\);/g) ?? []).length, 2);

// --- the same rule as the cards: only the archive destroys ------------------------------
const bar = list.slice(list.indexOf('project-list__bulk"'), list.indexOf('project-list__grid'));
check('the active tab offers archive', /runBulk\('archive'\)/.test(bar), true);
check('the archive offers restore', /runBulk\('restore'\)/.test(bar), true);
check('and delete', /runBulk\('delete'\)/.test(bar), true);
check('archive is not offered in the archive, and delete is not offered outside it',
  /!showArchive \? \([\s\S]*runBulk\('archive'\)[\s\S]*\) : confirmingBulkDelete/.test(bar), true);

// --- deleting takes a second step that says what it will do ----------------------------
check('delete first asks', /onClick=\{\(\) => setConfirmingBulkDelete\(true\)\}/.test(bar), true);
check('stating the count and that it cannot be undone',
  /\{selectedShown\.length\}件を完全に削除します。元に戻せません/.test(bar), true);
check('and the destructive call is only on the confirming button',
  bar.indexOf("runBulk('delete')") > bar.indexOf('confirmingBulkDelete ?'), true);

// --- while choosing, a click has one meaning ---------------------------------------------
check('the card selects instead of opening',
  /const activate = \(\) => \(selecting \? toggleSelected\(project\.projectId\) : onOpenProject\(project\)\)/.test(list), true);
check('and is announced as a checkbox', /role=\{selecting \? 'checkbox' : 'button'\}/.test(list), true);
check('with its state', /aria-checked=\{selecting \? isSelected : undefined\}/.test(list), true);
check('Space toggles it from the keyboard', /selecting && e\.key === ' '/.test(list), true);
check('the per-card star steps aside', /!archived && !selecting &&/.test(list), true);
// And for a viewer of a shared project, who may not archive or delete either (2026-09-23).
check('and so do the per-card archive and delete', /\{selecting \|\| !canWrite \? null : !archived \? \(/.test(list), true);
// Shown through usePresence since 2026-09-24, so it can fade out rather than vanish.
check('the new-project card is not selectable',
  /const newCard = usePresence\(tab === 'active' && !selecting\)/.test(list) && /\{newCard\.mounted && \(/.test(list), true);
check('Escape leaves the mode', /e\.key === 'Escape'\) leaveSelecting\(\)/.test(list), true);
// Selected by outline AND the tick, not by colour alone.
check('a selected card is marked by more than colour',
  /project-list__check--on/.test(list) && /\.project-list__card--selected \{[\s\S]{0,60}outline:/.test(css), true);

// --- one new-project control -------------------------------------------------------------
/*
 * The blue 「+ 新規プロジェクト」 in the toolbar did exactly what the card at the
 * head of the grid does, one line above it. Two controls for one action, and the
 * louder of them was the redundant one.
 */
check('the blue button is gone', /project-list__new-btn/.test(list), false);
check('and its styles with it', /\.project-list__new-btn/.test(css), false);
check('the card is still there', /project-list__card--new/.test(list), true);
check('and still creates a project', /project-list__card--new"\s+onClick=\{handleNew\}/.test(list), true);
check('there is exactly one way to create one', (list.match(/onClick=\{handleNew\}/g) ?? []).length, 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
