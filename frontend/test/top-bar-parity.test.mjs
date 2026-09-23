// One bar, whichever screen you are on.
//
// Reported 2026-09-20: 「プロジェクト一覧画面とプロジェクト画面で最上部のMakeUIの
// バーの位置が変わるのが気になります」. Measured by rendering both markups under the
// real stylesheet at 1440px, reading computed values rather than the source:
//
//                   project   list        after
//   height             44       54          44
//   side padding       20       24          20
//   wordmark left      20       24          20
//   wordmark centre  20.5     25.6        20.5
//   position        sticky   static      sticky
//   size             16px    16px        14px
//   weight            400      600         600
//   letter-spacing   0.16px  0.32px      0.14px
//
// The size and the weight moved on BOTH bars, which the first pass did not do.
// `button.app__logo` — the reset that makes the wordmark clickable — carried
// `font-size` and `font-weight: inherit`, more specific than `.app__logo`, so
// the wordmark drew at 16px weight 400 where its own rule asks for 14px at 600.
// The giveaway was that it was larger than the `/` beside it (14px) and the
// project name after it (13px). The bar itself does not move: it is 44px tall
// either way and the wordmark is centred in it.
//
//   node test/top-bar-parity.test.mjs      (from frontend/)
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/*
 * Comments stripped before anything is parsed. They hold colons and semicolons
 * — the note beside `.project-list__logo` quotes `font-weight: inherit` — and a
 * declaration reader that splits on those reads the prose as CSS and then loses
 * the declaration that follows it.
 */
const css = fs.readFileSync(path.join(root, 'src/index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every declaration a selector carries, across all of its rules, merged.
 *
 * Later rules win, as they do in the browser. A rule is only counted when the
 * selector stands alone — `.app__header,` at the head of a grouped font rule
 * says nothing about this bar's geometry.
 */
const declarationsOf = (selector, text = css) => {
  const out = {};
  const pattern = new RegExp(`(?:^|[};])\\s*${escape(selector)}\\s*\\{([^}]*)\\}`, 'gm');
  for (const m of text.matchAll(pattern)) {
    for (const d of m[1].split(';')) {
      const at = d.indexOf(':');
      if (at < 0) continue;
      out[d.slice(0, at).trim()] = d.slice(at + 1).trim();
    }
  }
  return out;
};

/**
 * The stylesheet with its `@media` blocks taken out.
 *
 * `declarationsOf` merges every rule for a selector and lets the last one win,
 * as the browser does — and inside a media query that is the 480px padding, so
 * the base inset read as `0 8px`. The narrow widths are checked separately
 * below, where they mean something.
 */
const base = (() => {
  let out = '';
  for (let i = 0; i < css.length; ) {
    const at = css.indexOf('@media', i);
    if (at === -1) { out += css.slice(i); break; }
    out += css.slice(i, at);
    let depth = 0;
    let j = css.indexOf('{', at);
    if (j === -1) { i = css.length; break; }
    for (; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}' && --depth === 0) { j++; break; }
    }
    i = j;
  }
  return out;
})();

const appBar = declarationsOf('.app__header', base);
const listBar = declarationsOf('.project-list__header', base);
check('both bars exist', [Object.keys(appBar).length > 0, Object.keys(listBar).length > 0], [true, true]);

// The complaint, in three numbers.
check('the same height', [appBar.height, listBar.height], ['44px', '44px']);
check('the same side inset', [appBar.padding, listBar.padding], ['0 20px', '0 20px']);
check('and both stay put while the page scrolls',
  [appBar.position, listBar.position], ['sticky', 'sticky']);
check('at the same offset', [appBar.top, listBar.top], ['0', '0']);
check('over the same stacking order', [appBar['z-index'], listBar['z-index']], ['100', '100']);

// The rule underneath it, which was a literal on one side and a token on the other.
check('the same border, from the same token',
  [appBar['border-bottom'], listBar['border-bottom']],
  ['1px solid var(--figma-border)', '1px solid var(--figma-border)']);

/*
 * The narrow widths too, or the bars separate again on a phone.
 *
 * Every block at that width, not the first: the two bars state their narrow
 * padding in blocks of their own, hundreds of lines apart.
 */
const narrow = (width) => {
  let text = '';
  const head = `@media (max-width: ${width}px)`;
  for (let at = css.indexOf(head); at !== -1; at = css.indexOf(head, at + 1)) {
    text += css.slice(at, css.indexOf('\n}', at));
  }
  const pad = (sel) => declarationsOf(sel, text).padding;
  return [pad('.app__header'), pad('.project-list__header')];
};
check('the same inset at 768px', narrow(768), ['0 16px', '0 16px']);
check('and at 480px', narrow(480), ['0 8px', '0 8px']);

// The wordmark: one size, one weight, one colour, one tracking.
const appLogo = declarationsOf('.app__logo', base);
const listLogo = declarationsOf('.project-list__logo', base);
check('the wordmark is the same colour',
  [appLogo.color, listLogo.color], ['var(--figma-text)', 'var(--figma-text)']);
check('and the same tracking',
  [appLogo['letter-spacing'], listLogo['letter-spacing']], ['0.01em', '0.01em']);
/*
 * And the same size and weight, which took a second pass to be true.
 *
 * `button.app__logo` — the reset that makes the wordmark clickable — carried
 * `font-size` and `font-weight: inherit`, which outrank `.app__logo` and
 * quietly cancelled its own design: the wordmark drew at 16px weight 400 where
 * the rule asks for 14px at 600. It showed as the wordmark being LARGER than
 * the `/` beside it (14px) and the project name after it (13px). The reset now
 * covers only what a <button> brings with it.
 */
const reset = declarationsOf('button.app__logo', base);
check('the clickable reset leaves the size alone', reset['font-size'], undefined);
check('and the weight', reset['font-weight'], undefined);
check('so both wordmarks are the size their rule asks for',
  [appLogo['font-size'], listLogo['font-size']], ['0.875rem', '0.875rem']);
check('and both are semibold',
  [appLogo['font-weight'], listLogo['font-weight']], ['600', '600']);
// The wordmark does not outsize what stands beside it in the project bar.
check('the wordmark is not larger than the separator',
  declarationsOf('.app__header-sep', base)['font-size'], '0.875rem');

// And the list header is not padded back into a different height.
check('the list bar sets a height rather than padding one',
  /\.project-list__header\s*\{[^}]*padding:\s*12px/.test(css), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
