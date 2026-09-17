/**
 * The stylesheet's own rules about itself, and whether text can be read.
 *
 * `css-hygiene.test.mjs` asks whether every rule is reachable and every class
 * used. This asks a different question: whether the things that are SUPPOSED to
 * be the same actually are, and whether what the product prints can be read.
 * Both are the kind of defect that never breaks a build, never fails a type
 * check, and is invisible in a diff — you have to go and measure.
 *
 * What measuring found:
 *
 *   `--figma-accent` was used seven times and defined nowhere, so every use
 *     fell through to its own fallback and there were three different ones. The
 *     structural input's focus ring was #3b5bdb, an indigo in no palette; the
 *     CSS inspector's was #4c9aff, a blue for a dark interface, on white.
 *   `--radius-8` was 6px and `--radius-12` was 8px. A token whose name states a
 *     size and yields another is worse than no token: it is read and believed.
 *   buttons had seven different corner radii — 2, 3, 4, 5, 6, 8px and a token —
 *     which is visible when two of them sit in one toolbar.
 *   two colour palettes coexist, `--figma-*` and the Digital Agency `--color-*`,
 *     and they disagree about blue: #0d99ff against #0017c1. The admin panel
 *     used both, plus the darker on-white blue, so one screen showed three
 *     accents — indigo checkboxes, a light-blue tab ring, and #0b76c9 buttons
 *     next to #0d99ff bars.
 *   thirty-two font sizes were in px where two hundred were in rem, so those
 *     thirty-two did not respond to the reader's browser setting.
 *   and every column heading in the admin panel was #999999 on #fafafa, which
 *     is 2.73:1 — the same colour, in the same role, that `--figma-text-dim`
 *     had already been moved away from for the same reason.
 *
 *   node test/design-tokens.test.mjs      (from frontend/)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// LF on every checkout, so a selector list named below with `\n` is found in a
// Windows worktree (CRLF) as it is in CodeBuild.
const raw = fs.readFileSync(path.join(root, 'src/index.css'), 'utf8').replace(/\r\n/g, '\n');
/** Comments quote the values they explain, so they are not evidence. */
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]]);
const tokens = Object.fromEntries([...css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

// --- every variable resolves ---------------------------------------------------------
{
  const used = new Set([...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
  /*
   * `--i` is set inline from the markup for a stagger delay, and the two below
   * are third-party surfaces that carry their own. Everything else that is read
   * has to exist, because a variable that does not silently becomes whatever
   * fallback happens to be written at that one call site.
   */
  const supplied = new Set(['--i', '--vsc-guide-left', '--figma-font']);
  const undefinedVars = [...used].filter((v) => !(v in tokens) && !supplied.has(v));
  check('no colour or size variable is used without being defined', undefinedVars.sort(), []);
}

// --- the radius scale means what it says ----------------------------------------------
{
  const wrong = Object.entries(tokens)
    .filter(([k]) => /^--radius-\d+$/.test(k))
    .filter(([k, v]) => Math.round(parseFloat(v) * 16) !== Number(k.split('-').pop()));
  check('every radius token yields the size its name states', wrong, []);
}

// --- one shape language for buttons ---------------------------------------------------
{
  const radii = new Set();
  for (const [sel, decl] of rules) {
    if (!/(btn|button)/i.test(sel) || /:(hover|focus|active|disabled)/.test(sel)) continue;
    const m = /border-radius:\s*([^;]+)/.exec(decl);
    if (m) radii.add(m[1].trim());
  }
  /*
   * Tokens, plus the two shapes that are shapes rather than corners: a circular
   * icon button and a pill. Seven raw pixel values is what this replaced.
   */
  const offScale = [...radii].filter((r) => !r.startsWith('var(--radius-') && r !== '50%' && r !== '999px');
  check('button corners come from the scale', offScale.sort(), []);
}

// --- type scales with the reader's browser --------------------------------------------
{
  const px = [...css.matchAll(/font-size:\s*(\d+px)/g)].map((m) => m[1]);
  check('no font size is fixed in pixels', px, []);
  // And one spelling of white, which was #fff forty times and #ffffff thirty-six.
  check('white is written one way', [...css.matchAll(/#fff\b(?![0-9a-fA-F])/g)].length, 0);
}

// --- and the text can be read ----------------------------------------------------------
{
  const resolve = (v) => {
    const m = /var\(\s*(--[\w-]+)/.exec(v.trim());
    const value = m ? tokens[m[1]] : v.trim();
    return value && /^#[0-9a-fA-F]{3,8}$/.test(value) ? value : null;
  };
  const lum = (hex) => {
    let h = hex.slice(1);
    if (h.length === 3) h = [...h].map((c) => c + c).join('');
    const ch = (x) => {
      const n = parseInt(x, 16) / 255;
      return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch(h.slice(0, 2)) + 0.7152 * ch(h.slice(2, 4)) + 0.0722 * ch(h.slice(4, 6));
  };
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  /*
   * The rules that failed, each measured where it is drawn. Asserted by name
   * rather than by sweeping the file: a sweep cannot model the cascade, and the
   * one thing it flagged that was NOT a defect was a rule three thousand lines
   * later had already overridden.
   */
  const at = (selector) => {
    const hit = rules.filter(([sel]) => sel === selector).pop();
    return hit ? hit[1] : '';
  };
  const contrastOf = (selector, bg) => {
    const decl = at(selector);
    const fg = resolve((/(?<![-\w])color:\s*([^;]+)/.exec(decl) ?? [])[1] ?? '');
    const back = bg ?? resolve((/(?<![-\w])background(?:-color)?:\s*([^;]+)/.exec(decl) ?? [])[1] ?? '');
    return fg && back ? Math.round(ratio(fg, back) * 100) / 100 : null;
  };

  const cases = [
    ['.adm-th', null, 4.5],                                   // every column heading in the panel
    ['.adm-toggle-btn--off', null, 4.5],
    ['.app__proposal-btn--primary', null, 4.5],
    ['.project-list__card-action:hover', null, 4.5],
    ['.adm-tab--active,\n.adm-tab--active:hover', null, 4.5], // the hover that outranks the resting rule
  ];
  for (const [sel, bg, need] of cases) {
    const r = contrastOf(sel, bg);
    check(`${sel.split(',')[0]} clears AA (${r})`, r !== null && r >= need, true);
  }

  // White on the primary button's own blue, which is the pair that was 2.99:1.
  check('white on the primary button clears AA',
    Math.round(ratio('#ffffff', tokens['--figma-blue-on-white-text']) * 100) / 100 >= 4.5, true);
}

// --- one palette, and one blue in it -----------------------------------------------------
{
  /*
   * The product standardises on the Figma family. What is left of the Digital
   * Agency palette is the part that family has no colour for — error, success,
   * warning, the two link states and two greys with no exact equivalent. Every
   * blue, every grey that WAS an exact equivalent, and white have moved.
   */
  const second = [...new Set([...css.matchAll(/var\(\s*(--color-[\w-]+)/g)].map((m) => m[1]))];
  const notSemantic = second.filter((t) => !/^--color-(error|success|warning|link|gray-200|gray-700)/.test(t));
  check('nothing reaches into the second palette for a blue, a white or a grey with a token',
    notSemantic.sort(), []);
  // And its dead half is gone: 22 tokens nothing referenced any more.
  const defined = [...new Set([...css.matchAll(/(--color-[\w-]+)\s*:/g)].map((m) => m[1]))];
  check('every token it still defines is still used',
    defined.filter((t) => !second.includes(t)).sort(), []);

  /*
   * And one rule decides which blue: a FILL is the product's own, because
   * nothing is read off it; TEXT, a glyph or a border on a light ground is the
   * darker one, because #0d99ff on white is 2.9:1. Five badges, checkmarks and
   * sort arrows were drawn in the fill colour.
   */
  const brandAsText = [...css.matchAll(/(?<![-\w])color:\s*#0d99ff/g)].length;
  check('the fill colour is never used as text', brandAsText, 0);

  // One red for error text, where there were three: #ec0000, #dc2626, #b91c1c.
  const reds = [...new Set([...css.matchAll(/#(ec0000|dc2626|b91c1c)/gi)].map((m) => m[0].toLowerCase()))];
  check('one error red is defined and nothing else is written', reds, ['#b91c1c']);

  /*
   * And the same colours written in decimals, which a search for the hex does
   * not find. Four survived the first pass this way — a focus halo and the
   * generating screen's sheen still carrying rgb(0,23,193), the low-score badge
   * and the error banner's border still carrying rgb(236,0,0) — and turned up
   * only when the DEPLOYED stylesheet was grepped, because the minifier had
   * folded them back to hex.
   */
  const retired = [
    [/rgba?\(\s*0,\s*23,\s*193/g, 'the indigo, as decimals'],
    [/rgba?\(\s*236,\s*0,\s*0/g, 'the old error red, as decimals'],
    [/rgba?\(\s*220,\s*38,\s*38/g, 'the second error red, as decimals'],
  ];
  for (const [pattern, what] of retired) {
    check(`no rule still carries ${what}`, [...css.matchAll(pattern)].length, 0);
  }
}

// --- the two that were not hard to read but invisible ---------------------------------------
{
  /*
   * Both were light-on-light, written for a dark interface and never revisited
   * when this one went light — the same origin as the #4c9aff focus rings.
   * `rgba()` over the ground is why the first sweep missed them: it resolved
   * hex and gave up on everything else.
   */
  const chip = rules.filter(([sel]) => sel === '.css-inspector__selector-value').pop()?.[1] ?? '';
  check('the selector chip is dark on a tint, not pale on pale',
    /color: var\(--figma-blue-on-white-text-hover\)/.test(chip) && /background: var\(--figma-blue-tint\)/.test(chip),
    true);
  const remove = rules.filter(([sel]) => sel === '.app__attach-remove:hover').pop()?.[1] ?? '';
  check('the attachment cross does not vanish when pointed at',
    /color: var\(--color-error-1\)/.test(remove) && !/#ff7070/.test(remove), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
