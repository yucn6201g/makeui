// A guard against a mistake that has now cost this codebase four real defects.
//
// Every one of them was a regex escape that silently became a control
// character or was dropped, producing a pattern that compiles fine and matches
// nothing — the worst possible failure mode, because "matches nothing" reads
// exactly like "there is nothing wrong".
//
//   virtualFs.ts        `^${FILE_OPEN}\s` inside a template literal became
//                       `^@@@makeui:files`, so no fenced project was ever
//                       recognised and every one rendered as its own source text.
//   interaction-audit   `\b(currentUser|…)\b` written with a literal backspace,
//                       so the auth-gate check could never fire.
//   reactPreview.ts     `\bmount\s*\(` the same way, so a Svelte entry point
//                       could not be found by the fallback.
//   framework-fixups    `navigate\b` the same way, so the SvelteKit rewrite
//                       found no navigation module and did nothing.
//
// Two rules, both mechanical:
//   1. No source file may contain a raw control character.
//   2. Inside a template literal, an escape JavaScript does not recognise is
//      dropped — so `\s`, `\d`, `\w` and `\b` in a `new RegExp(`…`)` must be
//      written doubled.
//
//   node test/source-hygiene.test.mjs      (from backend/)
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots = [path.join(root, 'src'), path.join(root, 'test'), path.resolve(root, '../frontend/src')];

function sources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!/node_modules|dist|\.git/.test(p)) sources(p, out);
    } else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) out.push(p);
  }
  return out;
}

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const files = roots.filter((d) => fs.existsSync(d)).flatMap((d) => sources(d));
check('there are sources to check', files.length > 50, true);

// --- 1. no raw control characters ------------------------------------------
const controls = [];
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g)) {
    const line = text.slice(0, m.index).split('\n').length;
    controls.push(`${path.relative(root, file)}:${line} U+${m[0].charCodeAt(0).toString(16).padStart(4, '0')}`);
  }
}
check('no source file contains a raw control character', controls, []);

// --- 2. regex escapes inside template literals ------------------------------
//
// `new RegExp(\`…\s…\`)` is the shape that bites: the template literal eats the
// backslash before the RegExp constructor ever sees it. A regex LITERAL is fine,
// which is why this only looks inside backticks passed to RegExp.
const dropped = [];
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const m = /new RegExp\(\s*`([^`]*)`/.exec(line);
    if (!m) return;
    // A single backslash before a class shorthand, i.e. not already doubled.
    const bad = /(^|[^\\])\\[sdwbSDWB]/.exec(m[1]);
    if (bad) dropped.push(`${path.relative(root, file)}:${i + 1}  ${line.trim().slice(0, 90)}`);
  });
}
check('no template-literal regex has a single-escaped class shorthand', dropped, []);

// --- the scripts that run inside the browser ---------------------------------
// browser-verify.ts carries whole programs as template literals and evaluates
// them in the page under test. A syntax error in one of those does not fail the
// build and does not fail a type check — it fails at runtime, in a browser
// nobody is watching, and the pipeline records the verification as having found
// nothing. "Found nothing" and "could not run" are indistinguishable downstream,
// which is the worst possible way for a check to break.
//
// The contents are a string as far as the compiler is concerned, so nothing
// checks them. Verified while writing this: putting `if (faults {` inside the
// literal leaves `tsc --noEmit` completely clean.
//
// (A stray backtick — writing `children` in a comment inside the literal, which
// happened twice while editing this file — does break the TypeScript parse,
// because it ends the literal early. That one the compiler already catches. The
// hazard this covers is the one it cannot see.)
//
// So the scripts are extracted and actually parsed.
const verifySrc = fs.readFileSync(path.join(root, 'src/tools/browser-verify.ts'), 'utf8');
const scripts = [...verifySrc.matchAll(/^const ([A-Z_]+) = `([\s\S]*?)`\r?$/gm)];

check('the injected browser scripts were found', scripts.length >= 2, true);

for (const [, name, body] of scripts) {
  let parsed = null;
  try {
    // Not executed — there is no DOM here, and running it is not the question.
    // eslint-disable-next-line no-new-func
    new Function(body);
  } catch (e) {
    parsed = String(e.message ?? e);
  }
  check(`${name} parses as JavaScript`, parsed, null);
  // A stray backtick inside the literal would have ended it early, so whatever
  // survived extraction still has to look like the whole program it claims to be.
  check(`${name} is a complete IIFE`, /^\(\(\)\s*=>\s*\{[\s\S]*\}\)\(\)\s*$/.test(body.trim()), true);
}

// --- and the biggest one, which this never looked at --------------------------
//
// The extraction above matches `const NAME = ` + backtick, uppercase only. The
// walk is built by `walkExpression(declared)` — a lowercase arrow function that
// interpolates the declared screens into its literal — so the longest injected
// script in the codebase was never parse-checked.
//
// Not hypothetical. Editing `hashId` in that literal turned `\/` into `\/`,
// which the compiler accepts and which emits `/^#/?/` — an unterminated regex.
// Every check above stayed green.
const bvOut = path.join(root, 'dist/bv-hygiene.test.mjs');
execSync(
  `npx esbuild "${path.join(root, 'src/tools/browser-verify.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${bvOut}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'pipe', cwd: root }
);
const { walkExpression } = await import(pathToFileURL(bvOut).href);
const walkSrc = walkExpression(['home', 'detail']);
let walkParsed = null;
try {
  // eslint-disable-next-line no-new-func
  new Function('return ' + walkSrc);
} catch (e) {
  walkParsed = String(e.message ?? e);
}
check('the walk expression parses as JavaScript', walkParsed, null);
check('and the declared screens reached it', walkSrc.includes('"home"'), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
