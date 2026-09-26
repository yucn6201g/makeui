import type { RuntimeFacts } from '../../tools/browser/browser-verify.js';
import { passingPair, toHexColour } from '../audit/runtime-audit.js';
import { isDecorativeShadow, outsideFoundation, withoutFoundation } from '../presets/preset-conformance.js';
import { stylesheetOf, spliceStylesheet, readProjectFiles, writeProjectFile } from '../../tools/project/project-transport.js';

/**
 * Defects that are arithmetic, fixed without asking a model.
 *
 * The repair loop rewrites a whole file to fix whatever it was given: measured
 * at 2,768 output tokens a call, and it is 43% of everything a run writes. For
 * a defect whose answer is computable that is the wrong trade twice over — it
 * costs a file rewrite, and it asks a model to guess a number that was already
 * known.
 *
 * Two of them are computable today, and the pipeline was already computing the
 * answers and then putting them in a prompt as advice.
 *
 * `contrast-low` — `passingPair` already returns the exact hex that clears the
 * ratio. The instruction says 「文字色を #xxxxxx にすれば基準を満たします」 and
 * then asks a model to apply it. Applying it here is not only cheaper, it is
 * more reliable: a computed colour clears 4.5:1 and a chosen one might.
 *
 * `input-small` — the instruction is already fully prescriptive: 40px, 16px,
 * padding, line-height, and 「個々の要素にその場しのぎで指定するのではなく、共通の
 * フォームコントロールのスタイルを直してください」. That is a CSS rule, written out.
 *
 * Both land in stylesheets, which is what makes them safe: a pass that can only
 * touch CSS cannot damage the code. Contrast reaches every stylesheet in the
 * project, because a colour the shared file tokenised can still be written as a
 * literal in a screen's own sheet.
 *
 * What is NOT here, and why:
 *
 *   `mobile-no-viewport` looked like the easiest of the three and has no live
 *   case. `toRunnableDocument` writes the meta tag into every page it builds, so
 *   for a fenced project the defect cannot fire. Implementing a fix for it would
 *   have been work that never runs.
 *
 *   `mobile-overflow`, `text-over-image` and the rest need a judgement about
 *   which element to change and how. A rule applied blind there would be a
 *   guess with a deterministic pass's authority, which is worse than a model's
 *   guess because nothing downstream doubts it.
 *
 *   `palette-size` was built here and removed, and the measurement is the point.
 *   The design-system audit computes `nearDuplicates` — the colours close enough
 *   to be one decision, with the survivor chosen by a stated rule — and its own
 *   comment records 45->38, 33->28, and two of five documents dropping under the
 *   threshold. So the answer looked already computed and merely unapplied, which
 *   is the shape of every fix in this file.
 *
 *   It is not. Measured over 40 stored documents, 2026-09-05: `palette-size`
 *   fires on 15 of them and ALL FIFTEEN ARE VUE. The count is 31 to 52 colours,
 *   of which 12 to 27 are in the stylesheet and 15 to 41 are in the components'
 *   own `<style>` blocks. Merging every pair the audit names clears the
 *   threshold on ZERO of the 15 when confined to the stylesheet — which is the
 *   only file this pass may touch — and on ONE of the 15 even if it could edit
 *   every style source, because the named merges are 2 to 11 colours against
 *   counts of 31 to 52.
 *
 *   Which says the defect is not a substitution problem at all. A colour count
 *   summed across twenty component `<style>` blocks cannot be moved by rewriting
 *   one file, and that is equally true of the model: `palette-size` was fixed 0
 *   times in 19. The thing that would move it is `scoped-styling` — the defect
 *   that already fires for exactly this shape, asking for shared classes to move
 *   into the stylesheet — and it is fixed 4 times in 8. The palette follows the
 *   rules; chasing the palette on its own is chasing the symptom.
 */

/** The ceilings `isDecorativeShadow` measures against, as the values to clamp to. */
const MAX_BLUR_PX = 24;
const MAX_ALPHA = 0.25;

/** What the audit demands of a form control, as the CSS that satisfies it. */
const FORM_CONTROL_RULE = `
/* Added deterministically: measured form controls were below the usable floor.
   Height comes from padding and line-height rather than a fixed value, and the
   16px font size is what stops iOS zooming the page on focus. */
input:not([type="checkbox"]):not([type="radio"]),
select,
textarea {
  min-height: 40px;
  font-size: 16px;
  padding: 10px 12px;
  line-height: 1.4;
}
`;

// Not the form-control rule's marker: that rule is skipped when its marker is already present.
const ICON_RULE_MARK = '/* MakeUI: unsized icons get the size of an icon */';
const ICON_GRIDS = [16, 20, 24, 32, 48].map((n) => `svg[viewBox="0 0 ${n} ${n}"]:not([width]):not([height])`).join(', ');
const ICON_RULE = `
${ICON_RULE_MARK}
:where(${ICON_GRIDS}) {
  width: 1.25em;
  height: 1.25em;
  flex-shrink: 0;
}
`;

interface DeterministicResult {
  html: string;
  /** Defect ids resolved here, so the repair planner never sees them. */
  fixed: string[];
  /** What changed, for the log. Empty when nothing did. */
  notes: string[];
}

/**
 * Replaces one colour with another throughout the stylesheet.
 *
 * Word-bounded and case-insensitive, because a stylesheet writes `#059669` and
 * `#059669;` and occasionally `#059669 ` inside a shorthand. Returns null when
 * the colour is not in the stylesheet at all — the v205 case, where the value
 * was written into four components and no token existed. That one belongs to
 * the model, which can create the token; this pass cannot.
 */
function recolour(css: string, from: string, to: string): string | null {
  // Never inside the design system's token block: it is restored verbatim afterwards,
  // so a recolour there would revert and leave `contrast-low` claimed but unfixed.
  const outside = withoutFoundation(css);
  const pattern = new RegExp(from.replace('#', '#') + '\\b', 'gi');
  if (!pattern.test(outside)) return null;
  return outsideFoundation(css, (part) => part.replace(new RegExp(from + '\\b', 'gi'), to));
}

export function applyDeterministicFixes(html: string, facts: RuntimeFacts): DeterministicResult {
  const styled = applyStylesheetFixes(html, facts);
  const revealed = revealHiddenScreens(styled.html, facts);
  return {
    html: revealed.html,
    fixed: [...styled.fixed, ...revealed.fixed],
    notes: [...styled.notes, ...revealed.notes],
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Screens whose content is there and hidden, shown, when the cause is one of the
 * two the runtime audit has named in real runs. Both have one answer.
 *
 *   A toggle class nothing sets. The carbon run of 2026-09-14: the stylesheet
 *   said `.screen { display: none }` and `.screen.is-active { display: flex }`,
 *   three screens wrote `className="screen is-active"` and the shared `Screen`
 *   component wrote `screen ${className}` — so every screen built on it was
 *   blank. In a routed app the mounted screen IS the active one, and the project
 *   says so itself by writing the pair literally elsewhere; the missing class is
 *   added where the class appears without it. Only with that evidence: a project
 *   that never writes the pair is not using the class this way.
 *
 *   A screen that is a closed <dialog>. The material3 run of the same day routed
 *   to a component whose root was `<dialog className="screen is-active">`,
 *   opened by `showModal()` from another screen — reached by its route, it was a
 *   closed dialog and showed nothing. A closed dialog with that screen's classes
 *   is shown in the page flow; opening it modally still works, because
 *   `showModal()` only needs it not to be open.
 *
 * `hiddenBy` is `tag.class.class { display: none }`, as the walk describes it.
 * Claimed only when every hidden screen's cause was addressed, as `contrast-low` is.
 */
export function revealHiddenScreens(html: string, facts: RuntimeFacts): DeterministicResult {
  const none: DeterministicResult = { html, fixed: [], notes: [] };
  const hidden = (facts.screens ?? []).filter((s) => s.hiddenBy && s.hiddenBy !== 'empty');
  if (hidden.length === 0) return none;
  const sheet = stylesheetOf(html);
  if (!sheet) return none;
  const files = readProjectFiles(html);
  const allCss = [...files].filter(([p]) => p.endsWith('.css')).map(([, b]) => b).join('\n');

  let out = html;
  let css = sheet.body;
  const notes: string[] = [];
  const causes = new Map<string, boolean>();

  for (const s of hidden) {
    const cause = s.hiddenBy!;
    if (causes.has(cause)) continue;
    const m = /^([a-z][\w-]*)((?:\.[\w-]+)*) \{ (?:display: none|visibility: hidden) \}$/.exec(cause);
    if (!m) { causes.set(cause, false); continue; }
    const tag = m[1];
    const classes = m[2].split('.').filter(Boolean);

    if (tag === 'dialog') {
      if (classes.length === 0) { causes.set(cause, false); continue; }
      const selector = `dialog${classes.map((c) => `.${c}`).join('')}:not([open])`;
      if (!css.includes(selector)) {
        css += `\n/* MakeUI: a routed screen that is a closed <dialog> is shown in the page */\n${selector} {\n  display: block;\n  position: static;\n  margin: 0 auto;\n}\n`;
      }
      notes.push(`screen-hidden: ${cause} → shown in the page flow`);
      causes.set(cause, true);
      continue;
    }

    let done = false;
    for (const c of classes) {
      const hides = new RegExp(`(?:^|[\\s,}])\\.${escapeRe(c)}\\s*\\{[^}]*display\\s*:\\s*none`).test(allCss);
      const active = new RegExp(`\\.${escapeRe(c)}\\.([\\w-]+)\\s*\\{[^}]*display\\s*:\\s*(?!none)[a-z]`).exec(allCss)?.[1] ??
        new RegExp(`\\.([\\w-]+)\\.${escapeRe(c)}\\s*\\{[^}]*display\\s*:\\s*(?!none)[a-z]`).exec(allCss)?.[1];
      if (!hides || !active) continue;
      const token = (t: string) => new RegExp(`(^|\\s)${escapeRe(t)}(?=\\s|$)`);
      // The project's own evidence that "mounted" means "active".
      const literal = /class(?:Name)?\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      const evidence = [...files].some(([p, b]) => /\.(tsx|jsx|vue)$/.test(p) &&
        [...b.matchAll(literal)].some((x) => { const v = x[1] ?? x[2] ?? ''; return token(c).test(v) && token(active).test(v); }));
      if (!evidence) continue;
      const add = (v: string) => (token(c).test(v) && !token(active).test(v) && !/\?|&&|\|\|/.test(v)
        ? v.replace(token(c), (_w, lead) => `${lead}${c} ${active}`) : v);
      let changed = 0;
      for (const [p, body] of files) {
        if (!/\.(tsx|jsx|vue)$/.test(p)) continue;
        const next = body
          .replace(/(class(?:Name)?\s*=\s*)"([^"]*)"/g, (_w, head, v) => { const n = add(v); if (n !== v) changed++; return `${head}"${n}"`; })
          .replace(/(class(?:Name)?\s*=\s*)'([^']*)'/g, (_w, head, v) => { const n = add(v); if (n !== v) changed++; return `${head}'${n}'`; })
          .replace(/(class(?:Name)?\s*=\s*\{\s*)`([^`]*)`/g, (w, head, v) => {
            const bare = v.replace(/\$\{[^}]*\}/g, ' ');
            if (!token(c).test(bare) || token(active).test(bare)) return w;
            changed++;
            return `${head}\`${v.replace(token(c), (_x: string, lead: string) => `${lead}${c} ${active}`)}\``;
          });
        if (next !== body) {
          const written = writeProjectFile(out, p, next);
          if (written) out = written;
        }
      }
      if (changed > 0) {
        notes.push(`screen-hidden: .${c} without .${active} in ${changed} place(s) → added`);
        done = true;
        break;
      }
    }
    causes.set(cause, done);
  }

  if (css !== sheet.body) {
    const spliced = spliceStylesheet(out, sheet.path, css);
    if (spliced) out = spliced;
  }
  if (out === html) return none;
  const all = hidden.every((s) => causes.get(s.hiddenBy!) === true);
  return { html: out, fixed: all ? ['screen-hidden'] : [], notes };
}

function applyStylesheetFixes(html: string, facts: RuntimeFacts): DeterministicResult {
  const sheet = stylesheetOf(html);
  if (!sheet) return { html, fixed: [], notes: [] };

  let css = sheet.body;
  const fixed: string[] = [];
  const notes: string[] = [];

  /*
   * Contrast first, because the form-control rule below appends and would
   * otherwise shift nothing but the offsets of what follows.
   */
  const faults = facts.contrast.filter((c) => !c.overImage);
  /*
   * Every stylesheet in the project, not only the shared one.
   *
   * Measured on the 2026-09-13 run: the muted text colour was a token in
   * globals.css AND a literal in `AlertsScreen.css`, the token was recoloured
   * and the literal was not, so the screen kept the failing colour.
   */
  const otherSheets = [...readProjectFiles(html)]
    .filter(([path]) => /\.css$/i.test(path) && path !== sheet.path);
  const rewritten = new Map<string, string>();
  /*
   * The same pair measured on three elements is one recolour, not three.
   *
   * The run above measured three faults at 4.37:1 and logged one recolour,
   * #7a7066 -> #786e64, marked partial. The first fault replaced the colour; the
   * others found nothing left to replace and were counted as unaddressed, so a
   * complete fix was reported as partial and `contrast-low` went to a model. A colour already moved to
   * the hex this fault needs is addressed; moved to a different one, it is not.
   */
  const applied = new Map<string, string>();
  let recoloured = 0;
  for (const c of faults) {
    const fix = passingPair(c.fg, c.bg, c.required);
    if (!fix) continue;
    const current = toHexColour(fix.side === 'fg' ? c.fg : c.bg);
    if (!current || current.toLowerCase() === fix.hex.toLowerCase()) continue;
    const key = current.toLowerCase();
    if (applied.has(key)) {
      if (applied.get(key) === fix.hex.toLowerCase()) recoloured += 1;
      continue;
    }
    let hit = false;
    const next = recolour(css, current, fix.hex);
    if (next) {
      css = next;
      hit = true;
    }
    for (const [path, body] of otherSheets) {
      const moved = recolour(rewritten.get(path) ?? body, current, fix.hex);
      if (moved) {
        rewritten.set(path, moved);
        hit = true;
      }
    }
    if (!hit) continue;
    applied.set(key, fix.hex.toLowerCase());
    recoloured += 1;
    notes.push(`contrast ${current} -> ${fix.hex} (${c.ratio}:1 -> >=${c.required}:1)`);
  }
  /*
   * Only when every fault was addressable. A partial fix leaves the defect open
   * and the instruction still true, so claiming it is closed would hand the
   * repair loop a shorter list than the document deserves.
   */
  if (recoloured > 0 && recoloured === faults.length) fixed.push('contrast-low');

  /*
   * Icons with no size, given the size an icon has.
   *
   * `:where()` keeps the rule at zero specificity, so every class that already
   * sizes an icon still wins and only the unsized ones change. Limited to the
   * small grids icons are drawn on; an illustration with a 400-unit viewBox is
   * meant to be large and is left alone.
   */
  if ((facts.oversizedIcons ?? []).length > 0 && !css.includes(ICON_RULE_MARK)) {
    css += ICON_RULE;
    fixed.push('icon-oversized');
    notes.push(`icons: ${facts.oversizedIcons!.length} rendered past 96px with no size`);
  }

  if (facts.smallFields.length > 0 && !css.includes('/* Added deterministically')) {
    css += FORM_CONTROL_RULE;
    fixed.push('input-small');
    notes.push(`form controls: ${facts.smallFields.length} measured below the floor`);
  }

  if (css === sheet.body && rewritten.size === 0) return { html, fixed: [], notes: [] };
  let out = html;
  if (css !== sheet.body) {
    const spliced = spliceStylesheet(out, sheet.path, css);
    if (!spliced) return { html, fixed: [], notes: [] };
    out = spliced;
  }
  for (const [path, body] of rewritten) {
    const next = writeProjectFile(out, path, body);
    // All or nothing: a claim of `contrast-low` covers every sheet it recoloured.
    if (!next) return { html, fixed: [], notes: [] };
    out = next;
  }
  return { html: out, fixed, notes };
}

/**
 * Brings decorative shadows back to elevation, in the stylesheet, arithmetically.
 *
 * `elevation: 'subtle'` is violated by two measurable things: a blur past 24px,
 * and a TINTED shadow past 0.25 alpha — the coloured glow that is the clearest
 * tell of a machine-made default. Both have computable answers, so the model
 * call that used to be made for them is not.
 *
 * That call has a measured record of failing at this: of three conformance
 * repairs run on 2026-09-03, two came back 「no improvement」 and one was
 * accepted. The two failures were a check defect rather than a model failure —
 * it was asking for shadows at 0.12 and 0.16 alpha to be made subtler, which
 * they already were — but the shape of the ask does not improve once the check
 * is right: 「make this shadow less strong」 has one arithmetic answer and a
 * model returns a rewritten stylesheet to deliver it.
 *
 * Only the two numbers move. The colour, the offsets and the selector are left
 * exactly as written, because which colour the shadow should be is a judgement
 * and clamping it is not.
 */
export function clampDecorativeShadows(html: string): DeterministicResult {
  const sheet = stylesheetOf(html);
  if (!sheet) return { html, fixed: [], notes: [] };

  let changed = 0;
  const notes: string[] = [];
  /*
   * Custom properties too, not only `box-shadow:` declarations.
   *
   * Found by the run of 2026-09-04, which drifted on 「影が強すぎます: 0 10px 25px
   * rgba(0, 0, 0, 0.1)」 while this pass reported nothing to clamp. The stylesheet
   * writes `--shadow-lg: 0 10px 25px rgba(0,0,0,0.1)` and then
   * `box-shadow: var(--shadow-lg)`, so the value the check complains about is
   * never next to the word `box-shadow`.
   *
   * The check sees it because `presetConformance` measures `normaliseCss`, which
   * resolves var() first. A fix that reads the raw stylesheet and a check that
   * reads the resolved one will disagree about every tokenised value, which is
   * the whole of this defect.
   *
   * `isDecorativeShadow` is the guard against clamping something that is not a
   * shadow: it needs two or more lengths, so `--space-6: 24px` and
   * `--radius-lg: 12px` cannot match, and a colour or a blur past the ceiling to
   * return true at all.
   */
  /*
   * The design system's token block is not the build's to clamp.
   *
   * Its shadows are the system's published elevation — Spindle's lv6 is a 28px
   * blur — and the measurement exempts exactly those values. Clamping them here
   * would rewrite a block that the pipeline puts back verbatim a step later.
   */
  const clamp = (text: string) => text.replace(/(?:box-shadow|--[\w-]+)\s*:\s*([^;}\n]+)/gi, (whole, value: string) => {
    if (!isDecorativeShadow(value)) return whole;
    const next = value
      // The blur is the third length. Written to match the value in place so a
      // shadow list keeps its other layers untouched.
      .replace(/(^|,)(\s*-?[\d.]+(?:px|rem|em)?\s+-?[\d.]+(?:px|rem|em)?\s+)(-?[\d.]+)(px)/g,
        (m, lead, head, blur, unit) => (parseFloat(blur) > MAX_BLUR_PX ? `${lead}${head}${MAX_BLUR_PX}${unit}` : m))
      .replace(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/g,
        (m, r, g, b, a) => {
          const neutral = r === '0' && g === '0' && b === '0';
          return !neutral && parseFloat(a) > MAX_ALPHA ? `rgba(${r}, ${g}, ${b}, ${MAX_ALPHA})` : m;
        });
    if (next === value) return whole;
    changed += 1;
    if (notes.length < 3) notes.push(`${value.trim()} → ${next.trim()}`);
    return whole.replace(value, next);
  });
  const css = outsideFoundation(sheet.body, clamp);

  if (changed === 0) return { html, fixed: [], notes: [] };
  const spliced = spliceStylesheet(html, sheet.path, css);
  if (!spliced) return { html, fixed: [], notes: [] };
  return {
    html: spliced,
    fixed: ['preset-drift'],
    notes: [`${changed} decorative shadow${changed === 1 ? '' : 's'} clamped: ${notes.join(', ')}`],
  };
}
