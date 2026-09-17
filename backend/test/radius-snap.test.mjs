// Bringing a document's corner radii onto the system's scale.
//
// This exists because the model repair could not. Measured on a real run: the
// deviation was detected, the repair ran, the repair WORKED — one violation to
// none — and was rejected for shortening the document by 13%. The guard was
// right; deleting 9,500 characters to fix a corner radius is not a trade worth
// taking. And prompting cannot carry it either: measured across the corpus, the
// offending values are the conventional scale (4, 8, 10, 2, 6, 12, 16, 24) that
// a model writes by habit at every element.
//
// So the assertions are of two kinds. That the right values move — and, more
// importantly, that the ones which must not move never do. A rewrite that
// squared off every avatar to satisfy a radius scale would be a worse failure
// than the violation it fixed.
//
//   node test/radius-snap.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/orchestration/preset-conformance.ts')}" --bundle --platform=node ` +
    `--format=esm --outfile="${path.join(root, 'dist/rs.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const { snapRadii, snapMotion, measureConformance } = await import(
  pathToFileURL(path.join(root, 'dist/rs.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const ALLOWED = [3, 7];

// --- the leverage: token declarations --------------------------------------
// 92% of shipped documents declare `--radius-*` tokens and 90% use them through
// var() — 2,876 uses against 629 declarations. Three declarations stand behind
// every rounded corner in a typical document.
{
  const src = ':root{--radius-sm:4px;--radius-md:12px;--radius-lg:1.5rem}';
  const out = snapRadii(src, ALLOWED);
  check('every token declaration is brought onto the scale',
    out.html, ':root{--radius-sm:3px;--radius-md:7px;--radius-lg:7px}');
  check('and rem is measured in px before it is snapped',
    out.changes.map((c) => `${c.from}->${c.to}`), ['4->3', '12->7', '24->7']);
  check('each is recorded as a token change', out.changes.every((c) => c.where === 'token'), true);
}
{
  // A token defined in terms of another must keep the indirection: snapping it
  // would inline one token into the other's definition.
  const src = ':root{--radius-card:var(--radius-md);--radius-md:12px}';
  const out = snapRadii(src, ALLOWED);
  check('a token that references another is left alone',
    out.html, ':root{--radius-card:var(--radius-md);--radius-md:7px}');
}

// --- the stray literals ----------------------------------------------------
{
  const src = '.card{border-radius:12px}.btn{border-radius:4px 4px 0 0}';
  const out = snapRadii(src, ALLOWED);
  check('a literal is snapped', out.html.includes('.card{border-radius:7px}'), true);
  check('and every component of a multi-value one',
    out.html.includes('.btn{border-radius:3px 3px 0 0}'), true);
  check('the zeros in it are untouched', out.html.includes('0 0}'), true);
}
{
  // The longhands are just as much a corner. A rewrite that missed them would
  // leave a document the measurement also misses, and the two agreeing on a
  // blind spot is worse than either having one.
  const src = '.a{border-top-left-radius:12px;border-bottom-right-radius:16px}';
  const out = snapRadii(src, ALLOWED);
  check('the longhands are corners too',
    out.html, '.a{border-top-left-radius:7px;border-bottom-right-radius:7px}');
}
{
  // 5px sits exactly between a scale of 3 and 7. Ties are real, so the rule is
  // asserted rather than left to whichever value the reduce saw first: downward,
  // because a corner that is too round reads as a mistake in a way that one
  // which is too square does not.
  check('a tie goes to the smaller radius',
    snapRadii('.a{border-radius:5px}', ALLOWED).html, '.a{border-radius:3px}');
  check('and the rule holds on a wider scale',
    snapRadii('.a{border-radius:8px}', [4, 12]).html, '.a{border-radius:4px}');
}
{
  const src = '.a{border-radius:var(--radius-md)}';
  check('a use through var() is left to its token', snapRadii(src, ALLOWED).html, src);
}

// --- what must never move --------------------------------------------------
// Pill, circle and square are shape decisions, not scale violations, and
// `measureConformance` ignores them for exactly this reason.
{
  const src = '.pill{border-radius:9999px}.avatar{border-radius:50%}.table{border-radius:0}';
  const out = snapRadii(src, ALLOWED);
  check('a pill stays a pill', out.html, src);
  check('and nothing is reported as changed', out.changes, []);
}
{
  const src = '.a{border-radius:500px}.b{border-radius:499px}';
  const out = snapRadii(src, ALLOWED);
  check('500px is the pill boundary the measurement uses, and is respected',
    out.html, '.a{border-radius:500px}.b{border-radius:7px}');
}
{
  const src = '.a{border-radius:3px}.b{border-radius:7px}';
  const out = snapRadii(src, ALLOWED);
  check('a value already on the scale is not rewritten', out.html, src);
  check('and produces no change record', out.changes, []);
}
{
  const src = '.a{border-radius:inherit}.b{border-radius:unset}';
  check('a keyword is not a length', snapRadii(src, ALLOWED).html, src);
}
// Only radii. A border WIDTH of 1px is not a corner, and the property names are
// close enough that a loose pattern would have taken it.
{
  const src = '.a{border:1px solid #ccc;border-radius:12px;padding:24px;gap:16px}';
  const out = snapRadii(src, ALLOWED);
  check('border-width, padding and gap are untouched',
    out.html, '.a{border:1px solid #ccc;border-radius:7px;padding:24px;gap:16px}');
}

// --- nothing to do ---------------------------------------------------------
{
  const src = '.a{border-radius:12px}';
  check('a system that constrains no radii changes nothing', snapRadii(src, []).html, src);
  check('nor one whose only radius is a pill', snapRadii(src, [999]).html, src);
}

// --- the whole point: the measurement then reports clean -------------------
// The snap runs before `measureConformance`, so the repair pass is never spent
// on radii at all.
{
  const sig = { required: ['#0F5C55'], radii: [3, 7] };
  const doc = `<style>:root{--radius-sm:4px;--radius-md:12px}
    .a{color:#0F5C55;border-radius:var(--radius-md)}
    .b{border-radius:20px}
    .pill{border-radius:9999px}</style>`;
  const before = measureConformance(doc, sig);
  check('the document violates the scale to begin with', before.violations, 1);
  check('and the finding names the offenders',
    before.details.some((d) => d.includes('角丸が仕様外')), true);

  const after = measureConformance(snapRadii(doc, sig.radii).html, sig);
  check('after the snap it does not', after.violations, 0);
  check('with nothing left to say', after.details, []);
  check('and the anchor it already had is still there', after.missing, []);
}

// --- motion ----------------------------------------------------------------
// The same discipline, on the axis every preset asked for in prose and nothing
// ever measured. Two rules only, because both can be repaired by substituting a
// value — a rule that can only be REPORTED becomes a model call that will
// probably be rejected, which is the trade the radius work already refused.

const MOTION = { namedPropertiesOnly: true, maxDurationMs: 400 };

{
  // 831 of 2,832 transition declarations in the corpus were `all`, in 70% of
  // documents, against prompts that have always said opacity and transform only.
  const src = '.btn{transition:all 120ms ease}';
  const out = snapMotion(src, MOTION);
  check('transition: all is replaced by the properties it meant',
    out.html, '.btn{transition:background-color 120ms ease, color 120ms ease, border-color 120ms ease, box-shadow 120ms ease, transform 120ms ease, opacity 120ms ease}');
}
{
  // None of the substituted properties may force layout, or the rewrite trades
  // one performance problem for the same one under a longer name.
  const out = snapMotion('.a{transition:all 200ms}', MOTION).html;
  check('no layout property is swept in',
    /(width|height|margin|padding|top|left|font-size)/.test(out), false);
}
{
  /*
   * The token, which is where the leverage is and where the first version
   * missed it entirely.
   *
   * `measureConformance` runs on `normaliseCss`, which resolves var() — so
   * `--transition-base: all 200ms` reads as `all` at every use while the source
   * at those uses says only `var(--transition-base)`. Rewriting the uses alone
   * left two corpus documents still reported, with 5 and 23 offences each,
   * because every one came through a token. 22 distinct motion tokens across
   * the corpus hold `all`.
   */
  const src = ':root{--transition-base:all 200ms ease}.a{transition:var(--transition-base)}';
  const out = snapMotion(src, MOTION);
  check('a transition token holding `all` is rewritten',
    out.html.includes('--transition-base:background-color 200ms ease,'), true);
  check('and the use through var() is left to its token',
    out.html.includes('.a{transition:var(--transition-base)}'), true);
  check('the measurement then agrees, which it could not before',
    measureConformance(out.html, { required: [], motion: MOTION }).violations, 0);
}
{
  const src = '.a{transition:opacity 120ms ease, transform 120ms ease}';
  check('a transition that already names its properties is untouched',
    snapMotion(src, MOTION).html, src);
}
{
  const src = '.a{transition:all}';
  check('bare `all` with no timing still converts',
    snapMotion(src, MOTION).html.startsWith('.a{transition:background-color, color,'), true);
}

// --- the duration ceiling --------------------------------------------------
{
  const src = '.a{animation:fadeIn 900ms ease}.b{transition:opacity 1.2s}';
  const out = snapMotion(src, MOTION);
  check('an over-long duration is clamped, in either unit',
    out.html, '.a{animation:fadeIn 400ms ease}.b{transition:opacity 400ms}');
  check('and both are recorded', out.changes.map((c) => c.from + '->' + c.to), ['900->400', '1200->400']);
}
{
  const src = '.a{animation:spin 300ms linear}';
  check('a duration inside the ceiling is left alone', snapMotion(src, MOTION).html, src);
}
{
  // A spinner needs `infinite`, a pulsing badge does not, and nothing in the CSS
  // tells them apart — so the contract does not carry that rule rather than
  // carrying one this cannot honour.
  const src = '.spinner{animation:spin 800ms linear infinite}';
  const out = snapMotion(src, MOTION);
  check('infinite survives', out.html.includes('infinite'), true);
  check('though its duration is still clamped', out.html.includes('400ms'), true);
}
{
  const src = '.a{transition:all 120ms}';
  check('a contract with neither rule changes nothing', snapMotion(src, {}).html, src);
}

// --- and the measurement then reports clean --------------------------------
{
  const sig = { required: [], motion: MOTION };
  const doc = '<style>.a{transition:all 120ms ease}.b{animation:in 900ms ease}</style>';
  const before = measureConformance(doc, sig);
  check('both faults are found', before.violations, 2);
  check('the first names the count', before.details[0].includes('transition: all'), true);
  check('the second names the value and the ceiling',
    before.details[1].includes('900ms') && before.details[1].includes('400ms'), true);

  const after = measureConformance(snapMotion(doc, MOTION).html, sig);
  check('after the repair there is nothing left to say', [after.violations, after.details], [0, []]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
