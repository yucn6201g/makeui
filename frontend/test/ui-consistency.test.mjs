// MakeUI's own screens, held to one set of sizes, corners and colours.
//
// Measured on 2026-09-24 by rendering every screen with stubbed data and reading
// what the browser actually drew, because the stylesheet's many overriding
// layers make the source a poor guide to the result. What was found:
//
//   nine buttons in Arial at 13.33px — no font rule of their own, and form
//     controls do not inherit the page's font
//   the project list's filter row at 25, 32, 33, 34 and 35px high, and the
//     preview toolbar at 22, 24, 25 and 28px, side by side
//   corners of 3, 4, 5, 6, 8, 9, 10 and 12px on the same kinds of thing
//   three popovers with three shadows, two radii and two border greys
//   five focus rings, and four focus halos on text fields
//   an error drawn in nine reds, five pinks and six red borders; a sign-in
//     button in black where every other primary action is blue
//
// This file keeps the result: tokens for each role, and no raw value back in
// the places that were unified. The deliberate exceptions — the VS Code editor,
// the browser chrome and device frames around the preview, framework badges,
// chart series, the favourite gold, the assistant's avatar, progress bars — are
// named once below and nowhere else.
//
//   node test/ui-consistency.test.mjs      (from frontend/)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN_FILES, readAdminPanel } from './lib/admin-source.mjs';
import { APP_FILES, readApp } from './lib/app-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(root, 'src/index.css'), 'utf8').replace(/\r\n/g, '\n');
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const EXEMPT = /vsc|\.t-|preview__device|preview__nav|preview__omnibox|preview__statusbar|preview__browser|preview__tab\b|preview__tab-favicon|project-list__kind|adm-chart__|app__chat-avatar|:root|card-star|favourite-filter|skeleton|scrollbar|meter|allowance|adm-bar|chat-msg-content|chip-stop-icon/;
const rules = [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((m) => [m[1].trim().replace(/\s+/g, ' '), m[2]])
  .filter(([sel]) => !sel.startsWith('@') && !EXEMPT.test(sel));
const decls = rules.flatMap(([sel, body]) => [...body.matchAll(/([-a-z]+)\s*:\s*([^;]+)/g)].map((d) => [sel, d[1], d[2].trim()]));

// --- the base ------------------------------------------------------------------------
check('form controls take the app\'s font', /button,\s*input,\s*select,\s*textarea \{\s*font-family: inherit;/.test(bare), true);
for (const t of ['--control-h-sm: 24px', '--control-h: 28px', '--control-h-lg: 32px', '--shadow-popover:', '--focus-halo:',
  '--figma-bg-subtle:', '--figma-bg-track:', '--figma-divider:', '--figma-border-strong:', '--figma-blue-on-tint-text:',
  '--color-error-surface:', '--color-error-border:', '--color-error-hover:', '--color-warning-text:', '--color-warning-surface:',
  '--color-warning-border:', '--color-success-surface:', '--color-success-border:']) {
  check(`token ${t.split(':')[0]}`, bare.includes(t), true);
}

// --- corners ------------------------------------------------------------------------------
{
  const onScale = /^(var\(--radius-\d+\)( var\(--radius-\d+\) 0 0)?|0( 0 var\(--radius-\d+\) var\(--radius-\d+\))?|50%|999px)$/;
  const raw = decls.filter(([, p, v]) => p === 'border-radius' && !onScale.test(v)).map(([sel, , v]) => `${sel}: ${v}`);
  check('every corner is on the scale (4, 6, 8, pill, round)', raw, []);
}

// --- colours: the values that were collapsed stay collapsed -------------------------------------
{
  const RETIRED = {
    text: ['#3d3d3d', '#333333', '#555', '#1a1a1a', '#4d4d4d', '#6b6b6b', '#999999', '#8a8a8a', '#8c8c8c', '#b0b0b0',
      '#a33', '#8f2423', '#cc2222', '#c22', '#d32f2f', '#d83c3c', '#c62828', '#b31d1d', '#96302f', '#b62f2f', '#8f1414',
      '#146c45', '#1a7f37', '#1b8a5a', '#3cc97f', '#3f6b4c', '#8a5a06', '#7a5a10', '#8b6d00', '#0d6fbf', '#0a67b0', '#2b5fb8'],
    bg: ['#1a1a1a', '#0080e0', '#0b87e3', '#f7f7f7', '#f7f8f9', '#fbfbfb', '#f6f7f8', '#f6f8fa', '#f4f6f8', '#f2f2f2', '#f1f2f3',
      '#f0f7ff', '#f2faff', '#f0f6ff', '#eef4ff', '#e6f4ff', '#e8f1ff', '#fdf1f1', '#fdf0f0', '#fff5f5', '#fdecec', '#fef2f2',
      '#fdeaea', '#fff4f4', '#c62828', '#a91f1f', '#e3f5ec', '#e7f6ea', '#eef8f0', '#f1f5f2', '#fdf6ee', '#fdf2e0', '#fff8e6'],
    border: ['#e0e0e0', '#ececec', '#e8e8e8', '#ebebeb', '#c0c0c0', '#d0d0d0', '#a8d4f5', '#d3e9fb', '#d98282', '#fdd', '#fecaca',
      '#f3c4c4', '#f3c9c9', '#ffd7d7', '#f0c4c4', '#e79a9a', '#d98b8a', '#eec5c5', '#b7e2cc', '#bfe0c7', '#e6c9a8', '#f3ddb3', '#e0c068'],
  };
  const kind = (p) => (/^(color|fill|stroke|caret-color)$/.test(p) ? 'text' : /^background/.test(p) ? 'bg' : /^(border|outline)/.test(p) ? 'border' : null);
  const back = decls.filter(([, p, v]) => {
    const k = kind(p);
    return k && (v.toLowerCase().match(/#[0-9a-f]{3,6}\b/g) ?? []).some((h) => RETIRED[k].includes(h));
  }).map(([sel, p, v]) => `${sel} { ${p}: ${v} }`);
  check('no retired colour has come back', back, []);
  check('the sign-in button is the primary blue', /\.login__button \{[^}]*background: var\(--figma-blue-on-white-text\)/.test(bare), true);
  check('and so is the send button', rules.filter(([s]) => s === '.app__chat-send-btn').some(([, b]) => /background: var\(--figma-blue-on-white-text\)/.test(b)), true);
}

// --- things that float, and focus ------------------------------------------------------------
{
  for (const sel of ['.share-panel', '.usage-menu__panel', '.dd__menu']) {
    const body = rules.filter(([s]) => s === sel).map(([, b]) => b).join(';');
    check(`${sel} floats like the others`,
      [/border-radius: var\(--radius-8\)/.test(body), /box-shadow: var\(--shadow-popover\)/.test(body), /border: 1px solid var\(--figma-border\)/.test(body)],
      [true, true, true]);
  }
  const rings = decls.filter(([, p, v]) => p === 'outline' && v !== 'none' && v !== '2px solid var(--figma-blue)').map(([sel, , v]) => `${sel}: ${v}`);
  check('one focus ring', rings, []);
  const halos = decls.filter(([sel, p, v]) => /:focus/.test(sel) && p === 'box-shadow' && v !== 'var(--focus-halo)').map(([sel, , v]) => `${sel}: ${v}`);
  check('one focus halo on text fields', halos, []);
}

// --- heights: the rows that did not line up ---------------------------------------------------------
{
  const has = (sel, re) => rules.filter(([s]) => s.split(', ').includes(sel)).some(([, b]) => re.test(b));
  for (const sel of ['.project-list__search-input', '.project-list__segmented', '.project-list__favourite-filter', '.project-list__sort-dir', '.project-list__select-toggle', '.project-list__bulk-btn']) {
    // favourite-filter is exempt from the colour sweep (its gold), not from this.
    const pool = sel === '.project-list__favourite-filter' ? /min-height: var\(--control-h-lg\)/.test(bare.slice(bare.indexOf('.project-list__favourite-filter {'))) : has(sel, /min-height: var\(--control-h-lg\)/);
    check(`${sel} is a page control (32px)`, pool, true);
  }
  for (const sel of ['.app__header-btn', '.usage-menu__email', '.app__preview-tabs', '.app__viewport-chips', '.dd__trigger', '.adm-btn', '.adm-input', '.adm-search', '.adm-tab']) {
    check(`${sel} is a toolbar control (28px)`, has(sel, /(min-)?height: var\(--control-h\)/), true);
  }
  check('.version-diff__open too', has('.version-diff__open', /height: var\(--control-h\)/), true);
  check('the dropdown wrapper adds no line box under its trigger', /\.dd \{ position: relative; display: inline-flex; \}/.test(bare), true);
}

// --- the viewport chooser is the same control as Preview/Code ---------------------------------------
{
  const app = readApp();
  check('a thumb, not a tinted chip', /<SlidingIndicator active=\{device\} \/>/.test(app), true);
  check('on the same grey track', rules.filter(([s]) => s === '.app__viewport-chips').some(([, b]) => /background: var\(--figma-bg-track\)/.test(b)), true);
}

// --- words: one label per action ---------------------------------------------------------------
{
  const tsx = [...APP_FILES, 'src/components/project-list/ProjectList.tsx', ...ADMIN_FILES, 'src/components/workspace/CodeEditor.tsx',
    'src/components/workspace/ShareButton.tsx', 'src/components/version-diff/VersionDiff.tsx'].map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
  // 取消 and やめる stood beside キャンセル for the same thing: stepping back out of a confirmation or an edit.
  check('backing out is always キャンセル', [/^\s*取消\s*$/m.test(tsx), /^\s*やめる\s*$/m.test(tsx)], [false, false]);
  const admin = readAdminPanel();
  check('a row\'s name and budget are edited by the same control, 編集',
    /className="adm-btn adm-btn--link adm-btn--sm"[\s\S]{0,200}ユーザー名を編集`\}\s*>\s*編集/.test(admin), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
