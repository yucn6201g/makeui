// Opening a project shows the document the server has, not a copy of it.
//
// Reported 2026-09-19: 「プロジェクト一覧画面からプロジェクトを開いたときにプレビューの
// バージョンとバージョンタブのバージョンがずれているときがある」. The two halves were
// reading different sources for the same question — the dropdown falls back to
// `versions[0]`, which IS the newest, while the canvas opened with
// `project.lastHtml`, the copy carried in from the project list.
//
// That copy is written into the list's state by `onUpdateProject` while the
// browser is watching a run, and by nothing else:
//
//   generate → the list's copy is doc1 · start an edit · go back to the list
//   → this component unmounts and the polling stops · the edit finishes
//   server-side → the project row and version history hold doc2 · reopen
//   → the canvas shows doc1 and the dropdown shows v2
//
//   node test/open-latest-version.test.mjs      (from frontend/)
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/** The body of the effect that recovers the document. */
const at = app.indexOf('const previewFetchedRef');
const effect = app.slice(at, app.indexOf('}, [project.projectId', at));
check('the effect is there', effect.length > 200, true);

/*
 * The guard that made the carried-in copy authoritative. It has to be gone: the
 * fetch runs whether or not something is already on the canvas.
 */
check('a document already on the canvas no longer skips the fetch',
  /if \(loadedHtml \|\| isGenerating\) return;/.test(effect), false);
check('but a run in flight still does', /if \(isGenerating\) return;/.test(effect), true);
// Once per project: a project that genuinely has no document must not turn into
// a request on every render.
check('and it asks once per project',
  /if \(previewFetchedRef\.current === project\.projectId\) return;/.test(effect), true);

/*
 * The answer replaces the carried-in copy and nothing else. Output produced
 * since mount, or a stored version chosen while the request was in flight, is
 * newer than this answer.
 */
check('the copy it opened with is what it may replace',
  /const carriedIn = project\.lastHtml \?\? null;/.test(effect), true);
check('anything else on the canvas is left alone',
  /if \(prev !== null && prev !== carriedIn\) return prev;/.test(effect), true);
check('and a missing answer changes nothing', /if \(cancelled \|\| !html\) return;/.test(effect), true);
// The carried-in copy can change under the component — a run completing writes
// it — so the effect depends on it rather than on the state it sets.
check('the effect watches the copy, not the state it sets',
  /\}, \[project\.projectId, project\.lastHtml, isGenerating, fetchProjectPreview\]\);/.test(app), true);

/*
 * The format picker read the same stale copy, through a once-only flag set the
 * first time ANY document arrived. A project reopened while the list held a
 * React snapshot of what is now a Vue project kept saying React, and the next
 * edit would have gone out in the wrong framework.
 */
check('the format is derived from the document, not from a once-only flag',
  /derivedFormatRef/.test(app), false);
check('and re-derived when the document changes',
  /if \(derivedFormatFromRef\.current === loadedHtml\) return;\s*\n\s*derivedFormatFromRef\.current = loadedHtml;/.test(app), true);
// A person's choice is not a guess to be corrected a second later.
check('but never over a format the person chose',
  /if \(touchedFormatRef\.current \|\| !loadedHtml\) return;/.test(app), true);

/*
 * `GET /projects/:id/preview` is the one source: the project's own document,
 * falling back to the newest version when the row has none — the same document
 * the dropdown's first row names.
 */
check('the document comes from the server', /fetchProjectPreview\(project\.projectId\)/.test(effect), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
