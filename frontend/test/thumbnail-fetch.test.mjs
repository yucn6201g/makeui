/**
 * A project card fetches its own document.
 *
 * The project row stopped carrying one — `GET /projects` was shipping 992KB for
 * ten projects, of which 4KB was the projects — so the list arrives with
 * `hasDocument` and nothing to draw. The card asks for the document itself, on
 * the same near-viewport deferral the compile already used.
 *
 * Three things here are easy to get wrong and expensive to notice, because the
 * failure is a thumbnail that never appears rather than an error:
 *
 *   - the fetch must not go inside `enqueueBuild`. That queue is serial, and it
 *     exists to keep Sucrase off the main thread; a network read in it makes one
 *     slow response hold up every other card's compile.
 *   - cancellation must not be a local flag. The effect re-runs the instant the
 *     fetch lands, because the fetched document is one of its dependencies — a
 *     local flag would be raised by the outgoing run's cleanup and throw away
 *     the compile the same run had just started.
 *   - the fetch must be deduplicated. StrictMode mounts every effect twice, so
 *     without a cache each card fetches an 87KB document twice in development.
 *
 * Source-read: what is asserted is the shape of an effect and where a call sits
 * relative to a queue, which is what was wrong each time.
 *
 *   node test/thumbnail-fetch.test.mjs      (from frontend/)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProjectList } from './lib/project-list-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'src/components/project-list/ProjectThumbnail.tsx'), 'utf8');
const list = readProjectList();

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/** Comments stripped, so a phrase quoted in prose cannot satisfy an assertion. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

// --- the list hands over the means to fetch -----------------------------------------
{
  check('the card is given its project id', /projectId=\{project\.projectId\}/.test(list), true);
  check('and whether there is one to get', /hasDocument=\{project\.hasDocument\}/.test(list), true);
  /*
   * The callback comes straight from the hook rather than being wrapped here.
   * `fetchHtml={() => fetchProjectPreview(id)}` would be a new function every
   * render, and it is an effect dependency — the effect would restart on every
   * parent render, forever.
   */
  check('through a callback that is stable', /fetchHtml=\{fetchProjectPreview\}/.test(list), true);
}

// --- the fetch is outside the compile queue -----------------------------------------
{
  const at = code.indexOf('loadDocument(projectId, fetchHtml)');
  check('the document is loaded', at > 0, true);

  /*
   * `enqueueBuild` wraps the compile and only the compile. Asserted by position:
   * the load happens before the queue is entered, not inside the callback given
   * to it.
   */
  const queued = code.indexOf('enqueueBuild(() => compile(');
  check('the compile is still queued', queued > 0, true);
  check('and the load happens before the queue', at < queued, true);
  check('the queue is handed a compile and nothing else',
    /enqueueBuild\(\(\) => compile\(doc\)\)/.test(code), true);
}

// --- cancellation survives the effect re-running -------------------------------------
{
  check('cancellation is a ref', /const cancelled = useRef\(false\)/.test(code), true);
  check('and is read as one', /if \(cancelled\.current\) return;/.test(code), true);
  check('nothing declares a local shadowing it', /let cancelled = false/.test(code), false);

  /*
   * It is raised only when the card goes away or points somewhere else — the
   * effect that owns it depends on the project, not on the document.
   */
  const owner = code.indexOf('cancelled.current = false;');
  check('the reset effect was found', owner > 0, true);
  const deps = code.slice(owner, owner + 200).match(/\}, \[([^\]]*)\]\);/);
  check('and it is keyed on the project alone', deps?.[1].trim(), 'projectId, html');
}

// --- the fetch is deduplicated --------------------------------------------------------
{
  check('documents are cached', /const documents = new Map<string, Promise<string \| null>>/.test(code), true);
  check('the promise is cached, not the result', /documents\.set\(projectId, pending\)/.test(code), true);
  /*
   * Both the empty answer and the rejection drop the entry. A cached `null`
   * would mean a card that missed once never tries again while the tab is open.
   */
  const misses = [...code.matchAll(/documents\.delete\(projectId\)/g)];
  check('a failed lookup is not kept', misses.length >= 2, true);
  check('the cache is bounded', /documents\.size >= MAX_CACHE/.test(code), true);
}

// --- a card with nothing to fetch does not spin ----------------------------------------
{
  /*
   * `hasDocument` false means there is no document anywhere — two projects have
   * one only in version history and one has none at all — and the card should
   * draw its empty mark rather than wait on a request that will answer nothing.
   */
  const m = code.match(/const wanted =\s*([\s\S]*?);/);
  check('the gate was found', Boolean(m), true);
  check('it requires something to fetch', /Boolean\(hasDocument\)/.test(m?.[1] ?? ''), true);
  check('and somewhere to fetch it from', /Boolean\(projectId\)/.test(m?.[1] ?? ''), true);
  check('and still covers a document in hand that needs compiling',
    /isProject && !reactDoc/.test(m?.[1] ?? ''), true);
}

// --- a long list stays light (2026-09-27) --------------------------------------------
/*
 * 「まだ重い」: with 150 cards a tab, a tab change or a filter held the main
 * thread 100–170 ms (four times that on a slower machine), the underline stood
 * still, and a click waited. What the profile found, and what holds each fix.
 */
{
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
  const thumb = src.replace(/\r\n/g, '\n');
  // Frames one at a time, each its own task, and never straight after a press or a key.
  check('frames are made in turn', /const turn = useFrameTurn\(frameDue\);/.test(thumb) && /const showFrame = frameDue && turn\.granted;/.test(thumb), true);
  check('a turn ends when the frame has loaded', (thumb.match(/onLoad=\{turn\.done\}/g) ?? []).length, 3);
  check('and waits out the moment after a press', /window\.addEventListener\('pointerdown', hush/.test(thumb) && /const QUIET_MS = \d+;/.test(thumb), true);
  // The per-card box check before paint forced the new grid's layout inside the commit.
  check('no card measures itself before paint', /useLayoutEffect|getBoundingClientRect/.test(thumb), false);
  // A card drawn before shows the page it drew, without starting the app again.
  check('a live frame reports what it drew', /const doc = built \? withSnapshot\(built\) : null;/.test(thumb), true);
  check('only from its own frame', /if \(e\.source !== liveRef\.current\?\.contentWindow\) return;/.test(thumb), true);
  check('and the copy runs no scripts', /srcDoc=\{snapshot\}\s*sandbox=""/.test(thumb), true);
  const shot = read('src/utils/preview/thumbnail.ts');
  check('the copy has its scripts removed and canvases as images',
    /copy\.querySelectorAll\('script'\),function\(s\)\{s\.remove\(\);\}/.test(shot) && /img\.src=c\.toDataURL\(\)/.test(shot), true);
  // The grid: a screenful at a time, and a paint before it changes.
  check('the grid draws a screenful, and more near its end', /const \{ count: drawn, sentinel \} = useProgressiveCount\(shown\.length, view\);/.test(list) && /ref=\{sentinel\}/.test(list), true);
  check('every filter follows a painted frame, not only the tab',
    /const chosen = useMemo\(\s*\(\) => \(\{ tab, query, framework, favouriteOnly, sortKey, sortDir \}\)/.test(list) && /const view = usePaintFirst\(chosen\);/.test(list), true);
  const progressive = read('src/hooks/useProgressiveCount.ts');
  check('a new view starts from one screenful', /if \(state\.key !== resetKey\) \{\s*\/\/[^\n]*\n\s*count = chunk;/.test(progressive), true);
  const flip = read('src/hooks/useFlip.ts');
  check('cards added below the fold do not fade the grid again', /if \(animate && bulk && arrivedInView\)/.test(flip), true);
  check('one date formatter for every card', /const DATE_FORMAT = new Intl\.DateTimeFormat\(/.test(read('src/components/project-list/ProjectCard.tsx')), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
