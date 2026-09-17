/**
 * The score and the audit have to want the same thing.
 *
 * `imagery-missing` fired on 47 of the 56 shipped projects that had an
 * `illustrations/` folder — nothing rendered any of it, and all 47 had an empty
 * state somewhere else drawing a shape of its own. The same 35 documents
 * produced the same three filenames, EmptyState / ContentFrame / Wordmark.
 *
 * That is what an incentive looks like from the outside. The score awarded 6
 * points for three FILES existing under that folder, the prompt described how to
 * draw them and never said where they go, and the audit then reported exactly
 * the state the score had paid for — after which a repair call closed it 41% of
 * the time. The cheap half was rewarded and the expensive half was bought back.
 *
 *   node test/artwork-incentive.test.mjs      (from backend/)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { completeProject, documentOf } from './fixtures/complete-project.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// Bundled the same way score-sanity does it: the real modules, with the SDKs
// left external so nothing here needs credentials.
const entry = path.join(root, 'dist/artwork-entry.ts');
fs.mkdirSync(path.dirname(entry), { recursive: true });
fs.writeFileSync(entry, [
  "export { scoreHtml } from '../src/orchestration/scoring.js';",
  "export { auditInteractivity } from '../src/orchestration/interaction-audit.js';",
  "export { FRAMEWORKS } from '../src/config/frameworks.js';",
].join('\n'));
execSync(
  `npx esbuild "${entry}" --bundle --platform=node --format=esm --outfile="${path.join(root, 'dist/artwork.test.mjs')}" `
    + `--external:@aws-sdk/* --external:@smithy/* --external:@strands-agents/*`,
  { stdio: 'pipe', cwd: root }
);
const { scoreHtml, auditInteractivity, FRAMEWORKS } = await import(
  pathToFileURL(path.join(root, 'dist/artwork.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/** The complete fixture, with its screens no longer rendering the artwork. */
function withArtworkUnrendered() {
  const files = completeProject(FRAMEWORKS.react);
  for (const [p, body] of files) {
    if (!p.startsWith('src/screens/')) continue;
    files.set(p, body
      .replace(/^import \{ \w+ \} from '\.\.\/components\/illustrations\/\w+';\n/m, '')
      .replace(/if \(rows\.length === 0\) return <\w+ \/>;\n\s*/, ''));
  }
  return files;
}

// --- the score pays for artwork that is drawn, not artwork that exists -------------
{
  const rendered = documentOf(completeProject(FRAMEWORKS.react));
  const orphaned = documentOf(withArtworkUnrendered());

  const a = scoreHtml(rendered, undefined, 'react');
  const b = scoreHtml(orphaned, undefined, 'react');
  check('the fixture renders its own artwork', a > 0, true);
  check('and the same files unrendered score lower', b < a, true);

  /*
   * The files are still there in `orphaned` — only the screens changed. A score
   * that counted files would be identical, which is the state this replaced.
   */
  const artFiles = (doc) => [...doc.matchAll(/@@@makeui:file\s+(src\/components\/illustrations\/\S+)/g)].length;
  check('both documents ship the same artwork', [artFiles(rendered), artFiles(orphaned)], [3, 3]);
}

// --- and the audit reports exactly that state --------------------------------------
{
  const ids = (doc) => auditInteractivity(doc, 'react').map((d) => d.id);
  check('rendered artwork is not reported',
    ids(documentOf(completeProject(FRAMEWORKS.react))).includes('imagery-missing'), false);
  check('orphaned artwork is reported',
    ids(documentOf(withArtworkUnrendered())).includes('imagery-missing'), true);

  /*
   * One definition of "rendered", shared. Two would drift, and drifting here
   * means the score rewarding what the audit reports — which is the thing this
   * file exists about.
   */
  const scoring = read('src/orchestration/scoring.ts');
  check('the score asks the audit', /renderedFrom\(files, 'src\/components\/illustrations\/'/.test(scoring), true);
  check('and does not count the files itself',
    /paths\.filter\([^)]*illustrations[^)]*\)\.length/.test(scoring), false);
}

// --- the finding reaches the user in the user's terms --------------------------------
{
  const doc = documentOf(withArtworkUnrendered());
  const found = auditInteractivity(doc, 'react').find((d) => d.id === 'imagery-missing');
  check('the defect was found', Boolean(found), true);
  check('it carries a note', typeof found?.note === 'string' && found.note.length > 0, true);

  /*
   * The note is what a person reads. The instruction is not: it names the
   * directory, lists the component files and says which files to edit, and the
   * chat used to show its first 90 characters — ending mid-filename.
   */
  check('the note names no paths', /src\//.test(found?.note ?? ''), false);
  check('nor any component files', /\.tsx|\.vue|\.svelte/.test(found?.note ?? ''), false);
  check('while the instruction still does', /src\/components\/illustrations\//.test(found?.instruction ?? ''), true);

  const graph = read('src/orchestration/graph.ts');
  check('the reply prefers the note', /note: readerNote\(d\)/.test(graph), true);
  check('and nothing shows the raw instruction any more',
    /note: shortNote\(d\.instruction\)/.test(graph), false);
  check('with the clip kept as the fallback', /return d\.note \?\? shortNote\(d\.instruction\)/.test(graph), true);
}

// --- the prompt says where a piece goes ------------------------------------------------
{
  const prompt = read('src/orchestration/prompt-contracts.ts');
  const at = prompt.indexOf('src/components/illustrations/ holds the artwork');
  check('the IMAGERY section was found', at > 0, true);
  const section = prompt.slice(at, at + 1400);
  /*
   * The section was entirely about how to draw. A model told to draw and not
   * told where to put it does the first half, which is what 47 documents did.
   */
  check('it requires a screen to render each piece', /MUST BE RENDERED BY A SCREEN/.test(section), true);
  check('and says where each of the three goes',
    ['empty-state', 'wordmark', 'content frame'].filter((w) => !section.toLowerCase().includes(w)), []);
  check('and what to do with a piece that has nowhere to go',
    /nowhere to go, do not draw it/.test(section), true);
}

// --- the icons section says the same thing --------------------------------------------
{
  /*
   * Same requirement, one folder over, and prompt-only.
   *
   * The measurement that left the icon SCORE counting files still stands — 50 of
   * the 65 corpus documents that have icons render them — so nothing here asserts
   * a scoring change. What one run after the artwork fix showed is a project that
   * drew ChevronIcon, SearchIcon, CloseIcon and CheckIcon and rendered none of
   * the four: the four names anyone picks before knowing where they go, which is
   * exactly what the artwork section was changed to prevent.
   */
  const prompt = read('src/orchestration/prompt-contracts.ts');
  const at = prompt.indexOf('ICONS — src/components/icons/ is mandatory');
  check('the ICONS section was found', at > 0, true);
  const section = prompt.slice(at, at + 1600);
  check('every glyph has to be rendered', /MUST BE RENDERED BY A SCREEN OR A SHARED COMPONENT/.test(section), true);
  check('and a glyph with nowhere to go is not drawn', /nowhere to go, do not draw it/.test(section), true);
  check('the places are named', ['nav item', 'button', 'empty state'].filter((w) => !section.includes(w)), []);

  // And the score is still counting files here, on the measurement that says so.
  const scoring = read('src/orchestration/scoring.ts');
  check('the icon term still counts svg occurrences', /const svgCount = /.test(scoring), true);
  check('and says why it was left alone', /50 of the 65/.test(scoring), true);
  check('while recording the run that disagrees',
    scoring.replace(/\s+/g, ' ').includes('one sample * against 65')
    || scoring.replace(/[\s*]+/g, ' ').includes('one sample against 65'), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
