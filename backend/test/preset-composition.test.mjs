/**
 * A design system's shell, checked from the layout the walk measured.
 *
 * The fixtures are the layout facts the production walk recorded on the eight
 * preset runs of 2026-09-14, each checked against a screenshot of the page:
 * Carbon's dark 48px header, the Agency's missing breadcrumb row, Material 3's
 * rail in one run and top tabs in the other, Spindle's bottom navigation.
 *
 *   node test/preset-composition.test.mjs      (from backend/)
 */
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist/preset-composition.test.mjs');
const entry = path.join(root, 'dist/preset-composition-entry.ts');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(entry, [
  "export { auditComposition, hasCompositionCheck } from '../src/orchestration/presets/preset-composition.js'",
  "export { auditRuntime } from '../src/orchestration/audit/runtime-audit.js'",
  "export { mergeLayout, walkExpression } from '../src/tools/browser/browser-verify.js'",
  "export { presetIds } from '../src/orchestration/presets/design-presets.js'",
  "export { shellRequirement } from '../src/orchestration/presets/preset-composition.js'",
  "export { repairable, worthRepairing } from '../src/orchestration/repair/repair-yield.js'",
].join('\n'));
await esbuild.build({
  entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out,
  external: ['@aws-sdk/*', '@smithy/*', '@strands-agents/*', 'esbuild'], loader: { '.txt': 'text' }, logLevel: 'error',
});
const m = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
};

const layout = (o) => ({ header: null, sideNavWidth: 0, bottomNav: false, topNav: false, fab: false, breadcrumb: false, table: false, ...o });
// Recorded by the walk, 2026-09-14.
const RUNS = {
  'carbon (both runs)': ['carbon', layout({ header: { height: 48, luminance: 0.09 }, sideNavWidth: 256, table: true })],
  'digital-agency (both runs)': ['digital-agency', layout({ header: { height: 64, luminance: 1 }, table: true })],
  'material3, first run': ['material3', layout({ header: { height: 64, luminance: 0.98 }, sideNavWidth: 80, fab: true })],
  'material3, second run': ['material3', layout({ header: { height: 64, luminance: 0.94 }, topNav: true, fab: true })],
  'spindle (both runs)': ['spindle', layout({ header: { height: 56, luminance: 1 }, bottomNav: true })],
};
const ids = (preset, l) => m.auditComposition(l, preset).map((d) => d.id);
const text = (preset, l) => m.auditComposition(l, preset).map((d) => d.instruction).join('');

check('every built-in preset has a composition check', m.presetIds().filter((p) => p !== 'none' && !m.hasCompositionCheck(p)), []);
check('carbon with its UI shell conforms', ids(...RUNS['carbon (both runs)']), []);
check('the agency without a breadcrumb row does not', ids(...RUNS['digital-agency (both runs)']), ['preset-composition']);
check('and is told to add exactly that', /パンくずリスト/.test(text(...RUNS['digital-agency (both runs)'])) && !/サイドバー/.test(text(...RUNS['digital-agency (both runs)'])), true);
check('material3 with a rail conforms', ids(...RUNS['material3, first run']), []);
check('material3 with tabs across the top does not', ids(...RUNS['material3, second run']), ['preset-composition']);
check('and the instruction says what it measured', /上部のタブ/.test(text(...RUNS['material3, second run'])), true);
check('spindle with bottom navigation conforms', ids(...RUNS['spindle (both runs)']), []);

// --- the boundaries -------------------------------------------------------------------------
check('carbon with a light header does not', ids('carbon', layout({ header: { height: 48, luminance: 0.95 } })), ['preset-composition']);
check('carbon with a 64px dark header does not', ids('carbon', layout({ header: { height: 64, luminance: 0.09 } })), ['preset-composition']);
check('carbon with a transparent header does not', ids('carbon', layout({ header: { height: 48, luminance: null } })), ['preset-composition']);
check('the agency with a breadcrumb and a side nav is told about the side nav', /サイドバー/.test(text('digital-agency', layout({ breadcrumb: true, sideNavWidth: 240 }))), true);
check('the agency with a breadcrumb and no side nav conforms', ids('digital-agency', layout({ breadcrumb: true, header: { height: 64, luminance: 1 } })), []);
check('material3 with a drawer conforms', ids('material3', layout({ sideNavWidth: 280 })), []);
check('material3 with a bottom bar conforms', ids('material3', layout({ bottomNav: true })), []);
check('material3 with a 200px side nav does not (neither rail nor drawer)', ids('material3', layout({ sideNavWidth: 200 })), ['preset-composition']);
check('spindle with a header nav conforms on desktop', ids('spindle', layout({ topNav: true })), []);
check('spindle with only a side nav does not', ids('spindle', layout({ sideNavWidth: 240 })), ['preset-composition']);
check('no preset, removed preset or no layout: nothing', [ids('none', layout({})), ids('warm', layout({})), m.auditComposition(undefined, 'carbon').length], [[], [], 0]);

// --- merged across screens --------------------------------------------------------------------
const merged = m.mergeLayout([
  layout({ header: { height: 64, luminance: 1 } }),
  layout({ breadcrumb: true, sideNavWidth: 0, table: true }),
]);
check('a breadcrumb on any screen is the system\'s breadcrumb', [merged.breadcrumb, merged.table, merged.header.height], [true, true, 64]);
check('no screens, no layout', m.mergeLayout([]), undefined);

// --- wired into the runtime audit --------------------------------------------------------------
const CLEAN = { screens: [], deadNav: [], deadActions: [], throwing: [], smallFields: [], unreachable: [], consoleErrors: [], contrast: [], mobile: null };
check('the runtime audit reports it for the bound preset',
  m.auditRuntime({ ...CLEAN, layout: RUNS['material3, second run'][1] }, '', 'material3').some((d) => d.id === 'preset-composition'), true);
check('and not without one', m.auditRuntime({ ...CLEAN, layout: RUNS['material3, second run'][1] }, '').some((d) => d.id === 'preset-composition'), false);
const graph = fs.readFileSync(path.join(root, 'src/orchestration/generate/graph.ts'), 'utf8');
check('every generation call passes the preset', (graph.match(/auditRuntime\([^)]*\)/g) ?? []).every((c) => c.endsWith(', presetName)')), true);

// --- measured by the walk ------------------------------------------------------------------------
const walk = m.walkExpression(['home']);
const measure = walk.slice(walk.indexOf('const measure = ('), walk.indexOf('const screens = new Map();'));
check('the layout is returned with each screen', /hiddenBy, unstyledNav, oversizedIcons, layout \};/.test(measure), true);
check('a side nav is docked left and at least half the viewport tall', /r\.left <= 2 && r\.height >= vh \* 0\.5 && r\.width >= 48 && r\.width <= 360/.test(measure), true);
check('a bottom nav reaches the foot of the viewport and holds a destination', /r\.bottom >= vh - 4 && r\.width >= vw \* 0\.6/.test(measure) && /controlsIn\(el\) >= \(el\.tagName === 'NAV'/.test(measure), true);
check('the walk expression still parses', (() => { try { new Function(`return ${walk}`); return true; } catch { return false; } })(), true);

// --- reported, not repaired; asked for at build time instead ------------------------------------
// The material3 run of 2026-09-14: six repair candidates, none accepted, three of them broke navigation.
check('the finding is not handed to a repair', m.repairable('preset-composition'), false);
check('but stays in what is reported', m.worthRepairing([{ id: 'preset-composition', instruction: 'x' }]).skipped.map((d) => d.id), ['preset-composition']);
check('every checked preset states its shell for the build', m.presetIds().filter((p) => m.hasCompositionCheck(p) && !m.shellRequirement(p)), []);
check('the material3 shell names the rail and rules out top tabs', /navigation rail: 80px wide/.test(m.shellRequirement('material3')) && /NOT tabs across the top/.test(m.shellRequirement('material3')), true);
check('the agency shell names the breadcrumb row and no side nav', /breadcrumb row/.test(m.shellRequirement('digital-agency')) && /NO persistent side navigation/.test(m.shellRequirement('digital-agency')), true);
check('no preset, no shell', m.shellRequirement('none'), '');
check('both build paths ask for it',
  [fs.readFileSync(path.join(root, 'src/orchestration/generate/build-files.ts'), 'utf8').includes('${shellRequirement(ctx.presetName)}'),
    fs.readFileSync(path.join(root, 'src/orchestration/generate/graph.ts'), 'utf8').includes('${shellRequirement(presetName)}')], [true, true]);

// --- the two false findings from the runs of 2026-09-14 (third round) ---------------------------
{
  // The agency: two screens, both in the header nav. Nothing below the top level, so no breadcrumb is owed.
  const flat = layout({ header: { height: 52, luminance: 1 }, table: true, navItems: 2 });
  check('a flat agency app with every screen in its nav owes no breadcrumb', m.auditComposition(flat, 'digital-agency', 2).map((d) => d.id), []);
  const deep = layout({ header: { height: 65, luminance: 1 }, table: true, navItems: 0 });
  check('one with screens the nav does not reach still does', m.auditComposition(deep, 'digital-agency', 4).map((d) => d.id), ['preset-composition']);
  check('and without a screen count the breadcrumb is still asked for', m.auditComposition(flat, 'digital-agency').map((d) => d.id), ['preset-composition']);
  check('the runtime audit passes the screen count',
    m.auditRuntime({ ...CLEAN, screens: [{ id: 'a' }, { id: 'b' }].map((x) => ({ ...x, fill: 1, emptyBoxes: [], reachable: true, broken: [] })), layout: flat }, '', 'digital-agency').some((d) => d.id === 'preset-composition'), false);
  check('merged layouts keep the largest nav', m.mergeLayout([layout({ navItems: 0 }), layout({ navItems: 4 })]).navItems, 4);
  // Spindle: a real bottom bar carrying one destination.
  const walkSrc = m.walkExpression(['home']);
  check('a <nav> across the foot counts with a single destination',
    /controlsIn\(el\) >= \(el\.tagName === 'NAV' \|\| el\.getAttribute\('role'\) === 'navigation' \? 1 : 2\)/.test(walkSrc), true);
  check('breadcrumb navs are not counted as destinations', /breadcrumb\|パンくず/.test(walkSrc), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
