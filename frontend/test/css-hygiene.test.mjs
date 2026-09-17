// A stylesheet you can find things in.
//
// index.css is the largest file in the project and the only one with no
// compiler behind it: nothing tells you that a rule is unreachable, that a
// class no longer exists in any component, or that the block you are reading is
// overridden two thousand lines below. All three had happened, and twice this
// year a change was made to a rule that could not win — including one to the
// preview pane, which was fixed by deleting two blocks rather than by editing
// the one being read.
//
// So the two rules are asserted here instead:
//
//   1. every class defined has a use, statically or by construction
//   2. no rule is fully overridden by a later rule for the same selector
//
//   node test/css-hygiene.test.mjs      (from frontend/)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(root, 'src/index.css'), 'utf8');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/** Every .tsx/.ts in the app, as one blob to search. */
function sources(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (/\.(tsx?|html)$/.test(e.name)) out.push(fs.readFileSync(p, 'utf8'));
  }
  return out;
}
const blob = sources(path.join(root, 'src')).join('\n');

/** Top-level rules: selector, body, and whether a comment introduced it. */
function topLevelRules(text) {
  const rules = [];
  let i = 0, depth = 0, buf = '';
  while (i < text.length) {
    const ch = text[i];
    if (ch === '{') {
      if (depth === 0) {
        const sel = buf.replace(/\/\*[\s\S]*?\*\//g, '').trim();
        let d = 1, j = i + 1;
        while (j < text.length && d) {
          if (text[j] === '{') d++;
          else if (text[j] === '}') d--;
          j++;
        }
        if (sel && !sel.startsWith('@')) rules.push({ sel, body: text.slice(i + 1, j - 1) });
        buf = '';
        i = j;
        continue;
      }
      depth++;
    } else if (ch === '}') depth--;
    else if (depth === 0) buf += ch;
    i++;
  }
  return rules;
}

// --- 0. the file still parses as CSS ------------------------------------------
//
// An unterminated comment disables everything after it until the next `*/`, and
// nothing reports that: the build succeeds, the page renders, and a region of
// the stylesheet is simply gone. A bulk edit produced exactly that here — a
// comment containing a comma was split as if it were a selector list, leaving
// `}/* … {` glued to the rule before it — and the computed-style comparison
// that was supposed to catch it did not, because the swallowed region happened
// to miss the elements being compared.
check('braces balance', css.split('{').length, css.split('}').length);
check('comment markers balance', css.split('/*').length, css.split('*/').length);
check('no rule begins with a comment opener',
  topLevelRules(css).filter((r) => r.sel.includes('/*') || r.sel.includes('*/')).map((r) => r.sel), []);

// --- 1. every class is used ---------------------------------------------------
//
// `className={`x--${kind}`}` is a use of `x--react` even though that string
// appears nowhere, so a class is also considered used when the source builds it
// from a prefix ending at a BEM boundary. Anything else is a rule that cannot
// match an element the app renders.
const selectorText = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/url\([^)]*\)/g, '');
const classes = [...new Set([...selectorText.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]))];
const built = (c) => {
  for (const cut of [c.lastIndexOf('--'), c.lastIndexOf('-'), c.lastIndexOf('__')]) {
    if (cut <= 0) continue;
    for (const pre of [c.slice(0, cut + 2), c.slice(0, cut + 1)]) {
      if (pre && blob.includes(pre + '${')) return true;
    }
  }
  return false;
};
check('the stylesheet was read', classes.length > 400, true);
check('every class has a use', classes.filter((c) => !blob.includes(c) && !built(c)), []);

// --- 2. no rule is unreachable ------------------------------------------------
//
// A block whose every property is set again later, for the identical selector,
// can never affect anything — but it is what someone reading the file finds
// first.
//
// This assertion used to allow seven, on the reasoning that they carried the
// explanation their surviving twin did not. Reading them showed that was wrong:
// all six of the remaining ones were byte-identical to their twin, comment
// included — the same block pasted twice, not a comment stranded on a dead
// rule. There was nothing to preserve, so the allowance is gone and the rule is
// simply zero.
const rules = topLevelRules(css);
const propsOf = (b) => [...b.matchAll(/(?:^|;)\s*([-a-zA-Z]+)\s*:/g)].map((m) => m[1]);
const bySel = new Map();
rules.forEach((r, k) => {
  for (const one of r.sel.split(',').map((x) => x.trim())) {
    if (!bySel.has(one)) bySel.set(one, []);
    bySel.get(one).push(k);
  }
});
const unreachable = [];
for (const [sel, ks] of bySel) {
  if (ks.length < 2) continue;
  ks.slice(0, -1).forEach((k, pos) => {
    const mine = propsOf(rules[k].body);
    const later = new Set(ks.slice(pos + 1).flatMap((k2) => propsOf(rules[k2].body)));
    if (mine.length && mine.every((p) => later.has(p))) unreachable.push(sel);
  });
}
check('no rule is unreachable', unreachable.sort(), []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
