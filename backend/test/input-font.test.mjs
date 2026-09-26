// Raising an input font the project sized from a body token.
//
// Reported 2026-09-20: 「入力欄の font-size が var(--fs-body) になっています」. The
// build had picked a reasonable-looking token for its fields; the token is under
// 16px, and iOS answers that by zooming the page whenever a field takes focus.
//
// It is done deterministically because the repair call does not do it.
// `input-sizing` is one of the four ids in NOT_WORTH_RETRYING — 1 fix in 10
// second attempts, 24 of 48 surviving the whole run — and the reason is in the
// instruction: the document is told not to change the token, because the token
// is used elsewhere, and to point the input rules at a bigger one. That requires
// knowing which of the project's tokens is bigger, and usually there is none.
//
// The finder is shared with the audit that reports it (tools/fixups/form-controls.ts),
// so the two cannot drift into disagreeing about the same stylesheet.
//
//   node test/input-font.test.mjs      (from backend/)
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist/if.test.mjs');
await esbuild.build({
  entryPoints: [path.join(root, 'src/tools/fixups/form-controls.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile: out,
  external: ['@aws-sdk/*', '@smithy/*'], logLevel: 'error',
});
const { smallControlFonts, raiseControlFonts } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/** A project document, as the transport carries it. */
const doc = (files) =>
  [...Object.entries(files)]
    .map(([p, b]) => `@@@makeui:file ${p}\n${b}\n@@@makeui:endfile`)
    .join('\n');

const MARKUP = `
  <input type="text" className="field__input" />
  <input type="email" className="field__input" />
  <textarea className="field__input" rows="6" />`;

// --- the reported shape ----------------------------------------------------
const TOKEN = doc({
  'src/styles/globals.css': `:root { --fs-body: 0.875rem; --space-md: 12px; }
.field__input { min-height: 44px; padding: 12px 14px; font-size: var(--fs-body); }
.card__body { font-size: var(--fs-body); }`,
  'src/screens/List.tsx': MARKUP,
});
const tokenFound = smallControlFonts(TOKEN);
check('a body token under the threshold is found', tokenFound.map((f) => [f.value, f.px, f.token]),
  [['var(--fs-body)', 14, '--fs-body']]);

const tokenFixed = raiseControlFonts(new Map(Object.entries({
  'src/styles/globals.css': `:root { --fs-body: 0.875rem; --space-md: 12px; }
.field__input { min-height: 44px; padding: 12px 14px; font-size: var(--fs-body); }
.card__body { font-size: var(--fs-body); }`,
  'src/screens/List.tsx': MARKUP,
})), TOKEN);
const css = tokenFixed.files.get('src/styles/globals.css');
check('the input rule is raised', /\.field__input \{[^}]*font-size: 16px/.test(css), true);
check('the padding it already had is kept', /padding: 12px 14px/.test(css), true);
// The token is what everything else is sized from; changing it would resize the
// whole product to fix a form.
check('the token itself is not touched', /--fs-body: 0\.875rem/.test(css), true);
check('and neither is anything else using it', /\.card__body \{ font-size: var\(--fs-body\); \}/.test(css), true);
check('one rule is reported raised', tokenFixed.raised.length, 1);
// Running it again finds nothing, so a second fixup pass is a no-op.
check('the finding is closed', smallControlFonts(doc({
  'src/styles/globals.css': css, 'src/screens/List.tsx': MARKUP,
})).length, 0);

// --- a selector that styles more than the control --------------------------
// `formControlRules` keeps a rule with ANY control part, so the label arrives
// with it. Raising that rule in place would grow the label too.
const MIXED = {
  'src/styles/globals.css': `:root { --fs-sm: 13px; }
.field input, .field label { font-size: var(--fs-sm); padding: 12px; min-height: 44px; }`,
  'src/screens/List.tsx': MARKUP,
};
const mixed = raiseControlFonts(new Map(Object.entries(MIXED)), doc(MIXED));
const mixedCss = mixed.files.get('src/styles/globals.css');
// Split rather than overridden: appending a winning rule after the original
// renders correctly and leaves the old declaration in the file, so the audit
// reads it and reports the finding again — a fixup that renders right and still
// reports is indistinguishable from one that did not run.
check('the label keeps its own rule and its own size',
  /\.field label \{ font-size: var\(--fs-sm\); padding: 12px; min-height: 44px; \}/.test(mixedCss), true);
check('and the control gets its own, raised',
  /\.field input \{ font-size: 16px; padding: 12px; min-height: 44px; \}/.test(mixedCss), true);
check('the rule that styled both is gone',
  /\.field input, \.field label \{/.test(mixedCss), false);
check('which closes the finding', smallControlFonts(doc({ ...MIXED, 'src/styles/globals.css': mixedCss })).length, 0);

// --- what must not be raised -----------------------------------------------
// A select is not typed into and is legitimately small; so are checkboxes and
// radios. This is the audit's own scoping and the fixup inherits it.
check('a select is left alone', smallControlFonts(doc({
  'src/styles/globals.css': `select { font-size: 12px; } .field__input { font-size: 16px; min-height: 44px; }`,
  'src/screens/List.tsx': MARKUP,
})).length, 0);
// A value that does not resolve to a literal cannot be compared, so neither the
// audit nor the fixup says anything about it.
check('a calc is left alone', smallControlFonts(doc({
  'src/styles/globals.css': `.field__input { font-size: calc(1rem - 2px); padding: 12px; }`,
  'src/screens/List.tsx': MARKUP,
})).length, 0);
check('a percentage likewise', smallControlFonts(doc({
  'src/styles/globals.css': `.field__input { font-size: 90%; padding: 12px; }`,
  'src/screens/List.tsx': MARKUP,
})).length, 0);
check('a token the project never defines likewise', smallControlFonts(doc({
  'src/styles/globals.css': `.field__input { font-size: var(--nothing); padding: 12px; }`,
  'src/screens/List.tsx': MARKUP,
})).length, 0);
check('16px exactly is not under the threshold', smallControlFonts(doc({
  'src/styles/globals.css': `.field__input { font-size: 1rem; padding: 12px; }`,
  'src/screens/List.tsx': MARKUP,
})).length, 0);
// One control is not a form.
check('a single control is not measured', smallControlFonts(doc({
  'src/styles/globals.css': `.field__input { font-size: 12px; padding: 12px; }`,
  'src/screens/List.tsx': `<input type="text" className="field__input" />`,
})).length, 0);

// --- the rule keeps its context --------------------------------------------
// Replaced where it stands, so a media query still only applies on a phone.
const MEDIA = {
  'src/styles/globals.css': `.field__input { font-size: 16px; padding: 12px; }
@media (max-width: 480px) { .field__input { font-size: 14px; } }`,
  'src/screens/List.tsx': MARKUP,
};
const media = raiseControlFonts(new Map(Object.entries(MEDIA)), doc(MEDIA));
check('a rule inside a media query is raised inside it',
  /@media \(max-width: 480px\) \{ \.field__input \{ font-size: 16px; \} \}/.test(media.files.get('src/styles/globals.css')), true);

// Several rules in one file are all raised, and the later ones do not shift.
const MANY = {
  'src/styles/globals.css': `.a input { font-size: 12px; padding: 4px; }
.b textarea { font-size: 13px; padding: 4px; }
.c input { font-size: 14px; padding: 4px; }`,
  'src/screens/List.tsx': MARKUP,
};
const many = raiseControlFonts(new Map(Object.entries(MANY)), doc(MANY));
check('every rule in the file is raised', many.raised.length, 3);
check('and each one kept its own selector',
  (many.files.get('src/styles/globals.css').match(/font-size: 16px/g) || []).length, 3);
check('a document with nothing to raise is returned unchanged', (() => {
  const files = new Map(Object.entries({
    'src/styles/globals.css': `.field__input { font-size: 16px; padding: 12px; }`,
    'src/screens/List.tsx': MARKUP,
  }));
  const r = raiseControlFonts(files, doc(Object.fromEntries(files)));
  return r.files === files && r.raised.length === 0;
})(), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
