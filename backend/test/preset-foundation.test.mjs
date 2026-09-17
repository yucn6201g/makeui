/**
 * The token block MakeUI writes for a bound design system, and the checks around it.
 *
 * Measured on the four verification runs of 2026-09-14: every one scored 100%
 * conformance and not one loaded its typeface. The block is generated from the
 * published tokens so that the values, the font import and the focus rule are
 * code's job; these hold the properties that make that safe to rely on:
 *
 *   - the block agrees with the spec the model reads and the signature the
 *     document is measured against (one source of values, not three)
 *   - putting it in is idempotent and survives a model that re-declared the tokens
 *   - the measurement ignores it, so it cannot satisfy the check on its own
 *   - a font import survives being concatenated behind another stylesheet
 *
 *   node test/preset-foundation.test.mjs      (from backend/)
 */
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist/preset-foundation.test.mjs');
const entry = path.join(root, 'dist/preset-foundation-entry.ts');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(entry, [
  "export * from '../src/orchestration/preset-foundation.js'",
  "export { presetIds, getPresetSpec, presetConformance } from '../src/orchestration/design-presets.js'",
  "export { hoistImports } from '../src/tools/react-bundle.js'",
  "export { clampDecorativeShadows } from '../src/orchestration/deterministic-fixes.js'",
  "export { measureDesignSystem, auditDesignSystem } from '../src/orchestration/design-system-audit.js'",
  "export { withUsedFoundationTokens } from '../src/orchestration/preset-conformance.js'",
].join('\n'));
await esbuild.build({
  entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out,
  external: ['@aws-sdk/*', '@smithy/*', '@strands-agents/*', 'esbuild', 'sucrase', 'vue', 'svelte', '@vue/*', 'svelte/*'],
  logLevel: 'error',
});
const m = await import(pathToFileURL(out).href);
const src = fs.readFileSync(path.join(root, 'src/orchestration/design-presets.ts'), 'utf8');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
};

const BUILT_IN = m.presetIds().filter((id) => id !== 'none');
const fence = (files) => Object.entries(files).map(([p, body]) => `@@@makeui:file ${p}\n${body}\n@@@makeui:endfile`).join('\n');
const read = (source, p) => new RegExp(`@@@makeui:file ${p.replace(/[.]/g, '\\.')}\\n([\\s\\S]*?)\\n@@@makeui:endfile`).exec(source)?.[1];

/** A signature's palette, read from the source (the table is not exported). */
function palette(id) {
  const key = id.includes('-') ? `'${id}'` : id;
  const start = src.indexOf(`  ${key}: {`, src.indexOf('const PRESET_SIGNATURE'));
  const body = src.slice(start, src.indexOf('\n  },', start));
  return [...(/palette: \[([^\]]*)\]/.exec(body)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1].toUpperCase());
}
const neutral = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return Math.max(r, g, b) - Math.min(r, g, b) <= 12;
};

// --- every built-in preset has a block, and the block agrees with the spec and signature ----
check('every built-in preset has a foundation', BUILT_IN.filter((id) => !m.presetFoundation(id)), []);
check('none has no foundation', m.presetFoundation('none'), null);
for (const id of BUILT_IN) {
  const f = m.presetFoundation(id);
  const spec = m.getPresetSpec(id).toUpperCase();
  const colours = [...new Set(f.vars.flatMap(([, v]) => [...v.matchAll(/#([0-9A-Fa-f]{6})(?![0-9A-Fa-f])/g)].map((x) => `#${x[1].toUpperCase()}`)))];
  check(`${id}: every token colour is stated in the spec`, colours.filter((c) => !spec.includes(c)), []);
  const pal = new Set(palette(id));
  check(`${id}: every token colour is on the signature palette or neutral`, colours.filter((c) => !pal.has(c) && !neutral(c)), []);
  check(`${id}: every type size is stated in the spec`,
    f.typeScale.filter((v) => !new RegExp(`(^|[^\\d])${v}(px| /|\\s*/)`).test(m.getPresetSpec(id))), []);
  check(`${id}: every button and field height is stated in the spec`,
    [...f.buttonHeights, ...f.fieldHeights].filter((v) => !m.getPresetSpec(id).includes(`${v}px`)), []);
  const css = m.foundationCss(id);
  check(`${id}: the block declares the font stack variable and uses it on body`,
    css.includes(`${f.fontVar}:`) && css.includes(`body { font-family: var(${f.fontVar}); }`), true);
  check(`${id}: the focus rule is in the block and important`, /:focus-visible \{ outline: [^}]*!important/.test(css), true);
  check(`${id}: a web font starts the block right after its marker`,
    f.fontImport ? css.split('\n')[1].startsWith(`@import url('https://fonts.googleapis.com/css2?`) : !css.includes('@import'), true);
}
check('spindle has no web font — its stack is the platform fonts, as published', m.presetFoundation('spindle').fontImport, undefined);
check('digital-agency focus is the black outline over yellow',
  m.foundationCss('digital-agency').includes('outline: 4px solid #000000 !important; outline-offset: 2px !important; box-shadow: 0 0 0 2px #FFD43D !important;'), true);

// --- applying it -----------------------------------------------------------------------------
{
  const modelCss = [
    "@import url('https://fonts.googleapis.com/css2?family=Inter&display=swap');",
    ':root {',
    '  --color-key-900: #123456;',
    '  --brand: var(--color-key-900);',
    '}',
    '.btn { background: var(--brand); border-radius: 8px; min-height: 48px; }',
  ].join('\n');
  const project = fence({ 'src/main.tsx': "import './styles/globals.css'", 'src/styles/globals.css': modelCss });
  const once = m.applyPresetFoundation(project, 'digital-agency');
  const css = read(once.html, 'src/styles/globals.css');
  check('applied to the project', once.applied, true);
  check('the block is at the top of globals.css, after the project imports', css.split('\n')[1].startsWith('/* makeui:foundation:start digital-agency'), true);
  check('a model re-declaration of a block token is removed', [once.overridden, css.includes('#123456')], [['--color-key-900'], false]);
  check('the model\'s own aliases are kept', css.includes('--brand: var(--color-key-900);'), true);
  check('the model\'s import moves ahead of every rule',
    css.indexOf("@import url('https://fonts.googleapis.com/css2?family=Inter") < css.indexOf(':root {'), true);
  // The shape of the first real run: a weight list in the URL, and a :root of nothing but copies.
  const realistic = m.applyPresetFoundation(fence({ 'src/styles/globals.css': [
    "@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;700&display=swap');",
    '',
    ':root {',
    '  --color-key-900: #0017C1;',
    '  --color-gray-900: #1A1A1A;',
    '}',
    '',
    'body { color: var(--color-gray-900); }',
  ].join('\n') }), 'digital-agency').html;
  const realCss = read(realistic, 'src/styles/globals.css');
  check('an import with a semicolon in its URL still moves above the block',
    realCss.startsWith("@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;700&display=swap');\n/* makeui:foundation:start"), true);
  check('a :root holding only copies of the block is removed, not left empty',
    realCss.slice(realCss.indexOf('/* makeui:foundation:end */')).includes(':root'), false);
  check('and that is still idempotent', m.applyPresetFoundation(realistic, 'digital-agency').applied, false);
  const twice = m.applyPresetFoundation(once.html, 'digital-agency');
  check('applying again changes nothing', [twice.applied, twice.html === once.html], [false, true]);
  const dropped = once.html.replace(/\/\* makeui:foundation:start[\s\S]*?\/\* makeui:foundation:end \*\/\n*/, '');
  check('a stylesheet a repair rewrote without the block gets it back',
    [read(dropped, 'src/styles/globals.css').includes('makeui:foundation:start'),
      read(m.applyPresetFoundation(dropped, 'digital-agency').html, 'src/styles/globals.css') === css], [false, true]);
  check('none and removed presets are left alone',
    [m.applyPresetFoundation(project, 'none').applied, m.applyPresetFoundation(project, 'warm').applied], [false, false]);
  const noSheet = fence({ 'src/main.tsx': 'export {}' });
  check('a project with no stylesheet gets globals.css',
    Boolean(read(m.applyPresetFoundation(noSheet, 'carbon').html, 'src/styles/globals.css')?.includes('--cds-interactive: #0F62FE;')), true);
  const doc = '<!DOCTYPE html><html><head><title>x</title></head><body></body></html>';
  const single = m.applyPresetFoundation(doc, 'material3').html;
  check('a single document gets it as the first style in head',
    /<head>\n<style data-makeui-foundation>\n\/\* makeui:foundation:start material3/.test(single), true);
  check('and only once', m.applyPresetFoundation(single, 'material3').html.match(/data-makeui-foundation/g).length, 1);
}

// --- the measurement cannot be satisfied by the block alone ----------------------------------
{
  const bare = fence({ 'src/styles/globals.css': '.card { color: #FF00AA; background: #00AAFF; } .x { color: #AA00FF; }' });
  const withBlock = m.applyPresetFoundation(bare, 'digital-agency').html;
  const r = m.presetConformance(withBlock, 'digital-agency');
  check('a stylesheet that uses none of the system still misses its colour anchors', r.missing, ['#0017C1', '#1A1A1A']);
  check('and its palette share is its own, not the block\'s', r.paletteShare, 0);
  const referenced = m.applyPresetFoundation(fence({
    'src/styles/globals.css': '.btn { background: var(--color-key-900); color: var(--color-gray-900); }',
  }), 'digital-agency').html;
  const ok = m.presetConformance(referenced, 'digital-agency');
  check('one that references the block\'s tokens satisfies them through var()', [ok.ratio, ok.violations], [1, 0]);
}

// --- the system's own elevation is not a decorative shadow ------------------------------------
{
  // Found replaying the 2026-09-14 Spindle run: its published lv6 is a 28px blur.
  const dialog = m.applyPresetFoundation(fence({
    'src/styles/globals.css': '.btn { background: var(--color-surface-accent-primary); color: var(--color-text-high-emphasis); font-family: var(--font-family-base); } .dialog { box-shadow: var(--shadow-lv6); }',
  }), 'spindle').html;
  check('a build using the published lv6 shadow is not reported', m.presetConformance(dialog, 'spindle').violations, 0);
  const invented = dialog.replace('.dialog { box-shadow: var(--shadow-lv6); }', '.dialog { box-shadow: 0 12px 40px 0 #08121A1F; }');
  check('an invented 40px blur still is', m.presetConformance(invented, 'spindle').details.some((d) => d.startsWith('影が強すぎます')), true);
  const clamped = m.clampDecorativeShadows(dialog);
  check('the shadow clamp leaves the block alone', clamped.fixed.length, 0);
  const clampedInvented = m.clampDecorativeShadows(invented);
  check('and still clamps what the build invented',
    [clampedInvented.fixed, read(clampedInvented.html, 'src/styles/globals.css').includes("--shadow-lv6: 0 11px 28px 0 #08121A1F;")], [['preset-drift'], true]);
  const textarea = m.applyPresetFoundation(fence({ 'src/styles/globals.css': 'textarea, .form-textarea { min-height: 140px; }' }), 'material3').html;
  check('a textarea height is not a field height', m.measureComponentDrift(textarea, 'material3').details, []);
}

// --- the coherence audit counts what the project uses, not what the block declares ------------
{
  // Found on the first generations built with the block (2026-09-14): palette-size fired on
  // digital-agency and material3 for 29 colours when the pages used 16 and 21.
  const css = [
    '.a { color: var(--color-gray-900); background: var(--color-white); }',
    '.b { color: var(--color-key-900); border-color: var(--color-gray-200); }',
    '.c { color: var(--color-error-1); background: var(--color-gray-50); font-size: var(--font-size-body); }',
  ].join('\n');
  const doc = m.applyPresetFoundation(fence({ 'src/styles/globals.css': css }), 'digital-agency').html;
  const metrics = m.measureDesignSystem(doc);
  check('only the referenced block colours count', metrics.colours, 6);
  // Seven from the rules above, and the font stack the body rule references.
  check('only the referenced block tokens count as declared', metrics.tokensDeclared, 8);
  check('no palette-size for a block nobody used', m.auditDesignSystem(doc).map((d) => d.id).includes('palette-size'), false);
  check('the used-tokens view keeps what is referenced', m.withUsedFoundationTokens(read(doc, 'src/styles/globals.css')).includes('--color-key-900: #0017C1;'), true);
  check('and drops the rest, the import and the focus rule',
    ['--color-key-50:', '@import', ':focus-visible'].filter((t) => m.withUsedFoundationTokens(read(doc, 'src/styles/globals.css')).includes(t)), []);
}

// --- fonts -------------------------------------------------------------------------------------
{
  const project = m.applyPresetFoundation(fence({
    'src/styles/globals.css': "h1 { font-family: 'Inter', sans-serif; } code { font-family: 'JetBrains Mono', monospace; } .x { font-family: inherit; }",
    'src/App.vue': "<template><div/></template>\n<style scoped>.t { font-family: Georgia, serif; }</style>",
  }), 'carbon').html;
  const snapped = m.snapFontFamilies(project, 'carbon');
  const css = read(snapped.html, 'src/styles/globals.css');
  check('two stray stacks are put on the system typeface', snapped.changes, 2);
  check('the body stack becomes the token', css.includes('h1 { font-family: var(--cds-font-family); }'), true);
  check('monospace and inherit are left alone', css.includes("'JetBrains Mono', monospace") && css.includes('font-family: inherit'), true);
  check('a scoped block in a component is reached', read(snapped.html, 'src/App.vue').includes('font-family: var(--cds-font-family)'), true);
  check('the block itself is untouched', css.includes("--cds-font-family: 'IBM Plex Sans JP'"), true);
  check('no preset, no change', m.snapFontFamilies(project, 'none').changes, 0);
}

// --- component sizes ---------------------------------------------------------------------------
{
  const project = m.applyPresetFoundation(fence({
    'src/styles/globals.css': [
      '.title { font-size: 1.5rem; }',           // 24px, on the DA scale
      '.caption { font-size: 13px; }',            // off
      '.lead { font-size: var(--font-size-h2); }', // token, on
      '.btn-primary { min-height: 44px; }',        // off
      '.btn-small { height: 36px; }',              // on
      '.icon-button { height: 32px; }',            // not a sized button
      '.search-input, select { min-height: 42px; }', // off
      '.form-field { min-height: 48px; }',         // on
      '.field-error { min-height: 20px; }',        // a message, not a field
    ].join('\n'),
  }), 'digital-agency').html;
  const d = m.measureComponentDrift(project, 'digital-agency');
  check('off-scale font sizes are found, tokens and rem resolved', d.fontSizes, [13]);
  check('button heights off the system are found, icon buttons ignored', d.buttonHeights, [44]);
  check('field heights off the system are found, messages ignored', d.fieldHeights, [42]);
  check('each kind is one finding', d.details.length, 3);
  check('the block\'s own values are never counted', m.measureComponentDrift(m.applyPresetFoundation(fence({ 'src/styles/globals.css': '' }), 'material3').html, 'material3').details, []);
  check('none measures nothing', m.measureComponentDrift(project, 'none').details, []);
}

// --- prompts ------------------------------------------------------------------------------------
{
  const block = m.foundationPromptBlock('spindle');
  check('the build is told not to declare the tokens and to reference them', /Do NOT declare any of these names/.test(block) && /var\(--name\)/.test(block), true);
  // Names, not declarations: a `--name: value` list was copied out as a :root block (72-85 tokens a run).
  check('the build is shown no declarations to copy', /--[\w-]+:\s/.test(block), false);
  check('the build is shown every token by name', m.presetFoundation('spindle').vars.every(([n]) => new RegExp(`${n}(,|
|$)`).test(block)), true);
  check('no preset, no block', m.foundationPromptBlock('none'), '');
  const note = m.presetScaleNote('carbon');
  check('the critic is given the scale to choose numbers from', /文字サイズ 12px \/ 14px/.test(note) && /ボタンの高さ 32px \/ 40px \/ 48px/.test(note), true);
  check('no preset, no note', m.presetScaleNote('none'), '');
}

// --- a font import survives concatenation ------------------------------------------------------
{
  const joined = ".a { color: red; }\n\n@import url('https://fonts.googleapis.com/css2?family=Roboto');\n.b {}\n@import url('https://fonts.googleapis.com/css2?family=Roboto');";
  const hoisted = m.hoistImports(joined);
  check('imports move ahead of every rule, once', hoisted.startsWith("@import url('https://fonts.googleapis.com/css2?family=Roboto');\n.a"), true);
  check('and appear once', hoisted.match(/@import/g).length, 1);
  check('css without imports is returned as is', m.hoistImports('.a{}'), '.a{}');
}

// --- wired where it has to be ------------------------------------------------------------------
{
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  const graph = read('src/orchestration/graph.ts');
  const count = (s, needle) => s.split(needle).length - 1;
  check('generation writes the block before measuring and again after the repairs', count(graph, 'applyPresetFoundation(finalHtml, presetName)'), 2);
  check('both critic calls are given the scale', count(graph, 'presetScaleNote(presetName)'), 2);
  check('the single-call build is told the tokens are written', graph.includes('foundationPromptBlock(presetName)'), true);
  check('the per-file build writes the block into the foundation before any screen',
    read('src/orchestration/build-files.ts').indexOf('withFoundationCss(foundation.get') < read('src/orchestration/build-files.ts').indexOf('const contract = contractBlock(foundation'), true);
  check('an edit carries the block', read('src/orchestration/meta-orchestrator.ts').includes('applyPresetFoundation(modifiedHtml, preset)'), true);
  check('the preview hoists imports too',
    fs.readFileSync(path.join(root, '../frontend/src/utils/reactPreview.ts'), 'utf8').includes('const css = hoistImports(['), true);
}

// --- the spec the code-writing calls see ---------------------------------------------------------
// Names-only in the token list did not stop it: the foundation still re-declared 67-80 tokens a run,
// copying the spec's own `--name: value` lines.
for (const id of BUILT_IN) {
  const rewritten = m.withoutTokenDeclarations(m.getPresetSpec(id), id);
  check(`${id}: no token is written as a declaration`, (rewritten.match(/--[\w-]+:\s/g) ?? []).length, 0);
  check(`${id}: every value is still stated beside its name`,
    m.presetFoundation(id).vars.filter(([n]) => m.getPresetSpec(id).includes(`${n}:`)).every(([n]) => rewritten.includes(`${n} (= `)), true);
}
check('a preset without a block is left as written', m.withoutTokenDeclarations('--x: 1px', 'none'), '--x: 1px');
{
  const bf = fs.readFileSync(path.join(root, 'src/orchestration/build-files.ts'), 'utf8');
  const gr = fs.readFileSync(path.join(root, 'src/orchestration/graph.ts'), 'utf8');
  check('both build prompts use the rewritten spec',
    [bf.includes('withoutTokenDeclarations(ctx.presetSpec, ctx.presetName)'), gr.includes('${withoutTokenDeclarations(presetSpec, presetName)}')], [true, true]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
