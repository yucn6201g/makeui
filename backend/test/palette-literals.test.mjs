// The palette finding names the literals to replace, not just a count.
//
//   node test/palette-literals.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/orchestration/design-system-audit.ts')}" --bundle --platform=node ` +
    `--format=esm --loader:.txt=text --outfile="${path.join(root, 'dist/dsa.test.mjs')}" ` +
    `--external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'pipe', cwd: root }
);
const { measureDesignSystem, auditDesignSystem } = await import(
  pathToFileURL(path.join(root, 'dist/dsa.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const doc = (css) =>
  `<!DOCTYPE html><html><body><div id="root"></div>\n@@@makeui:file src/styles/globals.css\n${css}\n@@@makeui:endfile\n</body></html>`;

// A colour declared once in :root and used through var() is a decision. The
// same value typed into a rule is a copy of one, and the copies are what push
// the count past the threshold — measured on the v197 documents: Vue 26 loose
// of 33 colours, Svelte 21 of 29, React 4 of 15 and no finding.
const TOKENS = ':root { --bg: #ffffff; --text: #1f2933; --accent: #2f6feb; }';
const tokenised = measureDesignSystem(doc(`${TOKENS}\n.a { color: var(--text); background: var(--bg); }`));
check('a colour declared as a token is not loose', tokenised.looseColours, []);

const looseCss =
  `${TOKENS}\n` +
  '.a { color: #6b7280; }\n.b { color: #6b7280; }\n.c { border-color: #6b7280; }\n' +
  '.d { background: rgb(229, 231, 235); }\n.e { background: #e5e7eb; }\n.f { color: #f00; }';
const loose = measureDesignSystem(doc(looseCss));
check('a literal in a rule is', loose.looseColours[0],
  { hex: '#6b7280', uses: 3, files: ['src/styles/globals.css'] });
// A hex and its rgb() spelling are the same colour, here as in the count above.
check('rgb() and hex count together', loose.looseColours[1],
  { hex: '#e5e7eb', uses: 2, files: ['src/styles/globals.css'] });
// Three-digit hex is expanded, so #f00 and #ff0000 are not two colours.
check('short hex is expanded', loose.looseColours.some((c) => c.hex === '#ff0000'), true);
check('most used first',
  loose.looseColours.map((c) => c.uses), [...loose.looseColours.map((c) => c.uses)].sort((a, b) => b - a));

// And the finding carries them. Twenty-seven distinct colours to cross the
// threshold, all written into rules.
const many = Array.from({ length: 27 }, (_, i) => `.c${i} { color: #${(0x111111 * (i + 1)).toString(16).padStart(6, '0').slice(0, 6)}; }`).join('\n');
const found = auditDesignSystem(doc(`${TOKENS}\n${many}`)).find((d) => d.id === 'palette-size');
check('the palette finding is raised', Boolean(found), true);
// These 27 are spaced far apart on purpose, so there is nothing to merge and
// the finding has to say the honest thing: the palette is simply too big.
// The merge half is exercised in palette-size.test.mjs, on colours that are
// actually close.
check('with no near-duplicates it asks for a decision, not a substitution',
  /どの色をやめるか/.test(found.instruction), true);

/*
 * The substitution assertions that stood here have moved to the token-adoption
 * section below, with the finding they belong to.
 *
 * They asserted that `palette-size` writes out 「#2f6feb（2箇所）→ var(--accent)」
 * for every literal matching a declared token. It did, and it was the wrong
 * request: `colours` counts distinct VALUES, and a literal equal to a token is
 * that value already counted once at its declaration. Measured on the five
 * corpus documents where this fires, applying every substitution it named moved
 * the count by zero on all five — which is what 0 fixed of 19 was.
 *
 * What this finding must name is what would change its own number, so the
 * assertion is now about the merges. The substitutions did not disappear; they
 * are `token-adoption`'s, and that is the ratio they do move.
 */
const mixed = auditDesignSystem(doc(
  `${TOKENS}\n` +
  Array.from({ length: 26 }, (_, i) => `.c${i} { color: #${(0x010101 * (i + 3)).toString(16).padStart(6, '0')}; }`).join('\n') +
  '\n.k { color: #2f6feb; }\n.l { border-color: #2f6feb; }'
)).find((d) => d.id === 'palette-size');
check('it does not offer a substitution that cannot move the count',
  /→ var\(--/.test(mixed.instruction), false);
check('and it still names the files to edit',
  /書き換える対象は src\/styles\/globals\.css/.test(mixed.instruction), true);

check('with the files to edit',
  /書き換える対象は src\/styles\/globals\.css/.test(mixed.instruction), true);

// ---------------------------------------------------------------- token-adoption
//
// The finding used to say "35 個宣言しているのに 22% しか参照していません" and
// stop. That is a grade, not a request: it names no literal, no token and no
// file, so the repair re-derives all three. Most of the work is already
// decided — a literal that matches a declared token exactly is the same
// decision typed twice, and the substitution can be written out.

const files = (entries) =>
  `<!DOCTYPE html><html><body><div id="root"></div>\n` +
  Object.entries(entries)
    .map(([p, body]) => `@@@makeui:file ${p}\n${body}\n@@@makeui:endfile`)
    .join('\n') +
  `\n</body></html>`;

const EIGHT =
  ':root { --bg: #ffffff; --surface: #f5f5f4; --text: #1f2933; --muted: #6b7280;\n' +
  '  --accent: #2f6feb; --ok: #059669; --warn: #d97706; --bad: #dc2626; }';
const adoption = files({
  'src/styles/globals.css':
    `${EIGHT}\n.a { color: #6b7280; }\n.b { background: #f5f5f4; }\n.c { color: #1f2933; }`,
  'src/components/Card.vue':
    '<template><div class="k" /></template>\n<style>\n.k { color: #2f6feb; border-color: #ff00aa; }\n</style>',
});

const m = measureDesignSystem(adoption);
// The literal and the token hold the same colour, so the repair is a substitution.
check('a literal that has a token says which one',
  m.looseColours.find((c) => c.hex === '#6b7280')?.token, '--muted');
check('a literal with no token says nothing',
  m.looseColours.find((c) => c.hex === '#ff00aa')?.token, undefined);
// Attribution is per file, and a component's own <style> block is one.
check('a component style block is a source',
  m.looseColours.find((c) => c.hex === '#2f6feb')?.files, ['src/components/Card.vue']);
check('every file holding literals is counted',
  m.literalFiles.map((f) => f.path).sort(),
  ['src/components/Card.vue', 'src/styles/globals.css']);

// A shadow's colour is the shadow, not a palette decision typed twice. It was
// 5.5% of every loose literal in the corpus and, concentrating on one value,
// it topped the "no matching token" list and pushed real colours off it.
const shadowed = measureDesignSystem(files({
  'src/styles/globals.css':
    `${EIGHT}\n.a { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08); }\n` +
    '.b { text-shadow: 0 1px 0 #000000; }\n.c { color: #6b7280; }',
}));
check('a shadow colour is not a loose colour',
  shadowed.looseColours.map((c) => c.hex), ['#6b7280']);

const ta = auditDesignSystem(adoption).find((d) => d.id === 'token-adoption');
check('the adoption finding is raised', Boolean(ta), true);
check('and writes the substitution out', /#6b7280 → var\(--muted\)/.test(ta.instruction), true);
check('and separates the colours with no token', /#ff00aa/.test(ta.instruction), true);
check('and names the files to edit', /src\/components\/Card\.vue/.test(ta.instruction), true);
// The percentage is still there — it is what makes the finding legible as a
// measurement — but it is no longer the whole message.
check('the count is kept', /custom property を 8 個宣言/.test(ta.instruction), true);

// A document that already references its tokens raises nothing, however many
// it declares. The finding is about adoption, not about declaring.
const adopted = files({
  'src/styles/globals.css':
    `${EIGHT}\n.a { color: var(--muted); }\n.b { background: var(--surface); }\n` +
    '.c { color: var(--text); }\n.d { border-color: var(--accent); }\n' +
    '.e { color: var(--ok); }\n.f { color: var(--warn); }\n.g { color: var(--bad); }\n' +
    '.h { background: var(--bg); }\n.i { color: var(--text); }\n.j { color: var(--muted); }',
});
check('a document that uses its tokens is left alone',
  auditDesignSystem(adopted).some((d) => d.id === 'token-adoption'), false);

// `type-scale` counted the sizes and did not say what they were, so a repair
// told to unify a scale had to go and find the eighteen values first. They were
// measured to produce that number.
const sizeRules = Array.from({ length: 14 }, (_, i) => `.t${i} { font-size: ${9 + i}px; }`).join('\n');
const ts = auditDesignSystem(doc(`${TOKENS}\n${sizeRules}`)).find((d) => d.id === 'type-scale');
check('the type-scale finding is raised', Boolean(ts), true);
check('and lists the sizes it counted', /9px \/ 10px \/ 11px/.test(ts.instruction), true);
check('smallest first', /実際に使われているのは 9px/.test(ts.instruction), true);
// Neighbouring values are the ones a scale collapses, and saying so is the
// difference between a rule and a judgement.
check('and says to collapse the near-duplicates', /近い値どうし/.test(ts.instruction), true);

// --- a declaration is not a failure to adopt -------------------------------------
//
// `tokenAdoption` counted every hex in the stylesheet, `:root` included, so each
// token a document declared added one to the denominator: it was charged for the
// exact thing the finding asks for. Measured over 73 stored documents, five
// fired and three of them had no literal outside :root at all — d61 declared 16
// tokens, wrote 32 hexes, every one of them a declaration, and was told it
// referenced tokens 24% of the time.
{
  const declaredOnly = doc(
    ':root {' + Array.from({ length: 12 }, (_, i) => ` --t${i}: #0${i}17c1;`).join('') + ' }' +
    Array.from({ length: 6 }, (_, i) => `.r${i} { color: var(--t${i}); }`).join('')
  );
  const met = measureDesignSystem(declaredOnly);
  check('a document that only uses tokens reads as full adoption', met.tokenAdoption, 1);
  check('and the finding does not fire',
    auditDesignSystem(declaredOnly).some((d) => d.id === 'token-adoption'), false);

  // And it still fires on the thing it is for: literals typed into rules.
  const copies = doc(
    ':root {' + Array.from({ length: 12 }, (_, i) => ` --t${i}: #0${i}17c1;`).join('') + ' }' +
    Array.from({ length: 30 }, (_, i) => `.c${i} { color: #0017c1; border-color: #223344; }`).join('')
  );
  check('a document full of copies still fires',
    auditDesignSystem(copies).some((d) => d.id === 'token-adoption'), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
