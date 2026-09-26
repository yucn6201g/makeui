// How the app moves: springs, sliding thumbs, things that leave, lists that travel.
//
// Most of what makes motion feel native is a set of agreements between files
// that nothing compiles together — a spring sampled in TypeScript and pasted
// into the stylesheet, a class the thumb takes a fill away from, a
// `data-state="closing"` that a component sets and a rule has to answer. Each
// of those is asserted here, because each one fails silently: the page still
// renders, it just jumps again.
//
//   node test/motion.test.mjs      (from frontend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { ADMIN_FILES, readAdminPanel } from './lib/admin-source.mjs';
import { APP_FILES, readApp } from './lib/app-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/utils/motion/motion.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist-test/motion.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const m = await import(pathToFileURL(path.join(root, 'dist-test/motion.test.mjs')).href);
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const css = read('src/index.css');
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- the springs ---------------------------------------------------------------------
{
  const peak = (s) => {
    let top = 0;
    for (let t = 0; t < 2; t += 0.001) top = Math.max(top, m.springPosition(s, t));
    return top;
  };
  check('smooth never overshoots', peak(m.SPRINGS.smooth) <= 1.0005, true);
  check('snappy settles past its mark by under 2%', peak(m.SPRINGS.snappy) > 1 && peak(m.SPRINGS.snappy) < 1.02, true);
  check('bouncy overshoots visibly, and under 10%', peak(m.SPRINGS.bouncy) > 1.03 && peak(m.SPRINGS.bouncy) < 1.1, true);
  for (const [name, s] of Object.entries(m.SPRINGS)) {
    const { easing, duration } = m.springEasing(s);
    check(`${name} comes to rest in 0.3–0.8s (${duration}ms)`, duration >= 300 && duration <= 800, true);
    check(`${name} starts at 0 and ends at 1`, /^linear\(0, .*, 1\)$/.test(easing), true);
    // The stylesheet carries the same spring, byte for byte, and its duration.
    check(`index.css --spring-${name} is the sampled spring`, css.includes(`--spring-${name}: ${easing};`), true);
    check(`index.css --spring-${name}-ms is its duration`, css.includes(`--spring-${name}-ms: ${duration}ms;`), true);
  }
  check('an engine without linear() still gets curves', /@supports not \(transition-timing-function: linear\(0, 1\)\)[\s\S]{0,200}--spring-smooth: cubic-bezier/.test(css), true);
  check('less motion, when asked for', /@media \(prefers-reduced-motion: reduce\) \{\s*:root \{\s*--spring-smooth-ms: 1ms;/.test(css), true);
}

// --- pressing --------------------------------------------------------------------------
{
  const sizes = [[16, 16], [26, 26], [80, 28], [220, 200], [900, 600]].map(([w, h]) => m.pressScale(w, h));
  check('a press sinks between 1.5% and 6%', sizes.every((s) => s >= 0.94 && s <= 0.985), true);
  check('and a bigger surface sinks by a smaller factor', [...sizes].sort((a, b) => a - b).join() === sizes.join(), true);
  const press = read('src/utils/motion/pressFeedback.ts');
  check('the press animates scale, so a transform is kept', /\{ scale: '1' \}, \{ scale: String\(to\) \}/.test(press), true);
  check('not on a disabled control', /el\.matches\(':disabled, \[aria-disabled="true"\]'\)/.test(press), true);
  check('installed once for the whole app', /installPressFeedback\(\);/.test(read('src/main.tsx')), true);
}

// --- sliding thumbs ----------------------------------------------------------------------
{
  const files = [...APP_FILES, 'src/components/project-list/ProjectList.tsx', ...ADMIN_FILES,
    'src/components/version-diff/VersionDiff.tsx', 'src/components/workspace/PromptTemplates.tsx', 'src/components/workspace/CodeEditor.tsx'];
  const tracks = [];
  for (const f of files) {
    const src = read(f);
    for (const hit of src.matchAll(/className="([\w-]+) motion-track"[^>]*>\s*<SlidingIndicator active=\{([^}]+)\}/g)) {
      tracks.push(`${hit[1]}:${hit[2]}`);
    }
    // A track with no thumb, or a thumb outside a track, is the thing to catch.
    check(`${f}: every motion-track has its thumb first`,
      (src.match(/motion-track"/g) ?? []).length, (src.match(/<SlidingIndicator /g) ?? []).length);
  }
  check('the controls that slide', tracks.sort(), [
    'adm-metrics:metric', 'adm-tabs:tab', 'app__preview-tabs:previewTab', 'app__viewport-chips:device',
    'project-list__segmented:framework', 'project-list__tabs:tab', 'prompt-templates__categories:activeCategory',
    'vc__tabs:diffTab', 'vsc__activity:sidebar',
  ].sort());
  // Each chosen-item class inside a track gives its fill to the thumb, or two fills show.
  for (const cls of ['project-list__segment--on', 'project-list__tab--on', 'app__preview-tab--active',
    'app__viewport-chip--active', 'adm-tab--active', 'adm-metric--active', 'vc__tab--on',
    'prompt-templates__chip--active', 'vsc__activity-btn--active']) {
    check(`the thumb takes ${cls}'s fill`, cssNoComments.includes(`.motion-track > .${cls}`), true);
  }
  const indicator = read('src/components/common/SlidingIndicator.tsx');
  check('the thumb is placed by layout offsets, not by a pressed, scaled box', /x \+= node\.offsetLeft;/.test(indicator), true);
  check('and jumps, rather than slides, into its first place', /const jump = !placed\.current \|\| prefersReducedMotion\(\);/.test(indicator), true);
}

// --- things that leave ----------------------------------------------------------------------
{
  const leaving = [
    ['src/components/common/Dropdown.tsx', 'dd__menu'],
    ['src/components/workspace/ShareButton.tsx', 'share-panel'],
    ['src/components/common/UsageMenu.tsx', 'usage-menu__panel'],
    ['src/components/admin/AdminPanel.tsx', 'adm-panel'],
    ['src/components/admin/AdminPanel.tsx', 'adm-overlay'],
    ['src/components/version-diff/VersionDiff.tsx', 'vc'],
    ['src/components/workspace/PromptTemplates.tsx', 'prompt-templates__panel'],
    ['src/components/project-list/ProjectList.tsx', 'project-list__bulk'],
  ];
  for (const [file, cls] of leaving) {
    const src = read(file);
    check(`${cls}: kept for its exit`, /usePresence\(/.test(src) && new RegExp(`className="${cls}"[\\s\\S]{0,240}data-state=\\{`).test(src), true);
    check(`${cls}: and the stylesheet plays one`, cssNoComments.includes(`.${cls}[data-state="closing"]`), true);
  }
  // An entrance that filled forwards would leave a transform on the element for
  // good, and a transformed ancestor captures position:fixed — every Dropdown
  // menu inside it would open in the wrong place.
  const section = cssNoComments.slice(cssNoComments.indexOf('--spring-swap-ms: 320ms'));
  const entrances = [...section.matchAll(/animation: motion-(?:pop-in|sheet-in|drop-in|swap-in|fade-in|pop)(?![-\w])[^;]*;/g)].map((x) => x[0]);
  check('entrances were found', entrances.length >= 8, true);
  check('and every one fills backwards only', entrances.filter((a) => !/ backwards;$/.test(a)), []);
  check('a chat message too', /animation: chat-msg-in [^;]* backwards;/.test(css), true);
  check('but only one said after the project opened', /\.app__chat-msg--new,\s*\.app__chat-msg--error \{\s*animation: chat-msg-in/.test(css) && /msg\.timestamp >= openedAt \? ' app__chat-msg--new'/.test(readApp()), true);
}

// --- lists that travel ------------------------------------------------------------------------
{
  const list = read('src/components/project-list/ProjectList.tsx');
  check('the project grid animates its layout', /useFlip\(gridRef, gridSignature\)/.test(list) && /className="project-list__grid" ref=\{gridRef\}/.test(list), true);
  // Measured when the list changes, not on every render: the list re-renders on a poll and on every keystroke.
  check('and measures only when what is in it changes', /\}, \[signature\]\);/.test(read('src/hooks/useFlip.ts')), true);
  check('a change of page arrives as one, not card by card', /const bulk = leaving\.length \+ arriving\.length > BULK;/.test(read('src/hooks/useFlip.ts')), true);
  check('and keeps a removed card long enough to leave', /const cards = usePresenceList\(shown, \(p\) => p\.projectId\)/.test(list), true);
  check('a leaving card is marked for useFlip and out of the tab order',
    /tabIndex=\{exiting \? -1 : 0\}[\s\S]{0,120}\[EXITING_ATTR\]: ''/.test(list), true);
  const flip = read('src/hooks/useFlip.ts');
  check('leaving cards are lifted out before the rest are measured',
    flip.indexOf('1. Lift the leaving ones out first') < flip.indexOf('2. Measure everything that stays'), true);
  check('an interrupted move continues from where the card visibly is', /tx = m\.m41; ty = m\.m42;/.test(flip), true);
  check('only what is on screen is animated', /if \(!onScreen\(box\) && !onScreen\(/.test(flip), true);
  const presence = read('src/hooks/usePresence.ts');
  check('a leaving item keeps its place, so its iframe is not moved and reloaded',
    /After the nearest earlier entry that is still in the list being built/.test(presence), true);
  check('the switch to closing happens while rendering, not a frame late', /if \(wasOpen !== open\) \{/.test(presence), true);
  check('the share panel\'s members travel too', /useFlip\(membersRef, /.test(read('src/components/workspace/ShareButton.tsx')), true);
  check('and the templates when a category narrows them', /useFlip\(listRef/.test(read('src/components/workspace/PromptTemplates.tsx')), true);
}

// --- between screens --------------------------------------------------------------------------
{
  const app = readApp();
  check('opening a project is a push', /const open = \(project: Project\) => navigate\(\(\) => setCurrentProject\(project\), 'forward'\);/.test(app), true);
  check('leaving it is a pop', /onBackToProjects=\{\(\) => navigate\(\(\) => setCurrentProject\(null\), 'back'\)\}/.test(app), true);
  const vt = read('src/utils/motion/viewTransition.ts');
  check('without the API, or with less motion, it simply happens', /typeof start !== 'function' \|\| prefersReducedMotion\(\)/.test(vt), true);
  check('the stylesheet slides each way',
    ['forward"]::view-transition-new(root)', 'back"]::view-transition-new(root)'].every((s) => css.includes(s)), true);
  check('tab content arrives rather than appears',
    /className="adm-body motion-swap" key=\{tab\}/.test(readAdminPanel()) && /\.app__pane,/.test(css), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
