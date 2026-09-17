// What the preview guard decides to do with a clicked link.
//
// The guard runs as a string of JavaScript inside a sandboxed, opaque-origin
// iframe, which is the one place this app cannot look into — so most of its
// behaviour is measured in a real browser, not here. What IS testable is the
// decision it makes about an href, and that is where the bug was:
//
//   A fragment link was classified as "nothing to do" and allowed through. But
//   a srcdoc document's URL is about:srcdoc while its BASE url is inherited
//   from the host page, so the browser resolved href="#/cart" against the HOST
//   and navigated the frame out of the preview to https://<host>/#/cart. Every
//   generated app routes on the hash, so every screen transition did this — the
//   frame left, and 「接続が拒否されました」 is what the user saw.
//
// The function under test is stringified into the guard, so this tests the code
// that ships rather than a second copy of it.
//
//   node test/preview-guard.test.mjs      (from frontend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/utils/previewGuard.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'node_modules/.cache/pg.test.mjs')}"`,
  { stdio: 'inherit', cwd: root }
);
const { classifyHref, PREVIEW_GUARD_SCRIPT } = await import(
  pathToFileURL(path.join(root, 'node_modules/.cache/pg.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- the regression ---------------------------------------------------------
// These must be 'hash', never 'ignore'. 'ignore' means "let the browser do it",
// and what the browser does with a fragment in a srcdoc frame is leave.
check('a hash route', classifyHref('#/cart'), 'hash');
check('a deep hash route', classifyHref('#/detail/42'), 'hash');
check('a plain anchor', classifyHref('#top'), 'hash');
check('a bare hash', classifyHref('#'), 'hash');

// --- links that must not leave the frame ------------------------------------
check('an absolute http url', classifyHref('http://example.com/'), 'external');
check('an absolute https url', classifyHref('https://example.com/x'), 'external');
// The shape that produced ERR_CONNECTION_REFUSED: protocol-relative, so it
// inherits https and points at a host that is not serving.
check('a protocol-relative url', classifyHref('//localhost:3000/x'), 'external');
check('a mailto', classifyHref('mailto:a@b.c'), 'external');
check('a tel', classifyHref('tel:+81300000000'), 'external');
check('a data url', classifyHref('data:text/html,x'), 'external');

// --- links into the app itself ----------------------------------------------
// Resolved in-page if there is somewhere to go, and otherwise reported as a
// screen that was not generated — which is the case the user hit.
check('a root-relative path', classifyHref('/contact'), 'internal');
check('a relative page', classifyHref('contact.html'), 'internal');
check('a nested path', classifyHref('/products/42'), 'internal');
check('a parent-relative path', classifyHref('../about'), 'internal');

// --- links that mean nothing ------------------------------------------------
check('an empty href', classifyHref(''), 'ignore');
check('javascript:void(0)', classifyHref('javascript:void(0)'), 'ignore');
check('javascript:;', classifyHref('javascript:;'), 'ignore');

// --- what the guard actually ships ------------------------------------------
// The function is stringified into the script, so a refactor that leaves the
// tested copy behind is caught here rather than in a browser.
check('the classifier travels with the guard', /function classifyHref/.test(PREVIEW_GUARD_SCRIPT), true);
check('and the handler uses it', /var verdict = classifyHref\(href\)/.test(PREVIEW_GUARD_SCRIPT), true);
/**
 * The guard used to redefine Location.prototype.href and overwrite
 * assign/replace/reload inside try/catch. None of it took — those are
 * [LegacyUnforgeable] own properties of the location object — so it read as
 * protection and was not. Measured in the browser: all four escaped. It is now
 * handled by the watchdog in Preview.tsx, and must not quietly come back here.
 */
// Matched on the code, not the name: the comment above the removal names it too,
// and an assertion that fires on its own explanation is an assertion that will be
// deleted rather than believed.
check('no inert Location override', /defineProperty\(\s*Location\.prototype/.test(PREVIEW_GUARD_SCRIPT), false);
check('no inert assign/replace stubbing', /location\.assign\s*=/.test(PREVIEW_GUARD_SCRIPT), false);
// The watchdog asks; the guard answers. Without this the host cannot tell that
// the frame navigated away, because it is not allowed to read its location.
check('the guard answers the watchdog ping', /makeui-preview-ping/.test(PREVIEW_GUARD_SCRIPT), true);

/**
 * The guard has to work MINIFIED, and that is not the same test.
 *
 * The classifier is stringified into the script while the call to it is plain
 * text inside a template literal. A minifier renames the declaration and leaves
 * the string alone, so a bundle can ship `function ww(e){…}` next to a call to
 * `classifyHref(href)` — a ReferenceError on every click in every preview,
 * which is worse than the bug being fixed. It cannot be seen in dev, where
 * nothing is renamed. Caught in the built artifact, so it is checked here
 * against a built artifact.
 */
execSync(
  `npx esbuild "${path.join(root, 'src/utils/previewGuard.ts')}" --bundle --minify --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'node_modules/.cache/pg.min.test.mjs')}"`,
  { stdio: 'inherit', cwd: root }
);
const min = await import(pathToFileURL(path.join(root, 'node_modules/.cache/pg.min.test.mjs')).href);
const minified = min.PREVIEW_GUARD_SCRIPT;

// The classifier's definition is everything before the guard's own IIFE.
const preamble = minified.slice(
  minified.indexOf('<script data-makeui-nav-block>') + '<script data-makeui-nav-block>'.length,
  minified.indexOf('(function() {')
);
// Run it exactly as the frame would, then call it by the name the frame uses.
const runMinified = new Function(`${preamble}; return classifyHref;`);
let classifyFromBundle = null;
try {
  classifyFromBundle = runMinified();
} catch (e) {
  console.log(`      minified preamble did not evaluate: ${e.message}`);
}
check('the minified bundle defines the name the guard calls', typeof classifyFromBundle, 'function');
check('and it still classifies a hash route', classifyFromBundle?.('#/cart'), 'hash');
check('and an external url', classifyFromBundle?.('https://example.com/'), 'external');
check('and an internal path', classifyFromBundle?.('/contact'), 'internal');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
