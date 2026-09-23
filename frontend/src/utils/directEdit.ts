/**
 * Edits a generated document without asking a model.
 *
 * Every change to a generated UI used to go through the pipeline, because the
 * only way to alter the document was to describe the alteration in words. That
 * is right for "add an approval screen" and absurd for "make this heading
 * darker": minutes of waiting, a token bill, and a non-deterministic result, for
 * a change the browser could make in a frame.
 *
 * Two operations, chosen because they are the ones that are safe to do by hand:
 *
 *   - a style declaration, written as an override rule. Applies to both output
 *     kinds, because CSS is CSS whether the markup came from HTML or from TSX.
 *   - text content, addressed by selector. Single-HTML output only — a React
 *     project's text lives in a .tsx file and the rendered DOM has no honest
 *     path back to it.
 *
 * Everything here is a pure function of (document, edit). Nothing reaches the
 * network, so an edit is undoable by keeping the previous string.
 */

import { splitHtmlToFiles } from './virtualFs';
import { detectKind } from './frameworkKind';
import { applyFileEdit } from './sourceEdit';

/** The block edits are collected into, so hand edits never rewrite generated CSS. */
const OVERRIDE_FILE = 'styles/overrides.css';

/**
 * Where hand edits live inside a project's own stylesheet.
 *
 * A single HTML page gets its own `<style data-file="styles/overrides.css">`
 * block, which keeps hand edits separable from generated CSS. A project has no
 * such block — its preview is compiled from the files, and a `<style>` tag
 * sitting in the document is not one of them. Measured: `splitHtmlToFiles`
 * returned the same three files before and after such a block was injected, so
 * the inspector reported 保存しました and the preview did not change.
 *
 * The separation still matters — `readOverrides` has to answer "what has the
 * user changed", not "what does the generated CSS say" — so the edits go into a
 * marked region at the end of the project's stylesheet instead. Last in the
 * last stylesheet is the same cascade position the override block had.
 */
const OVERRIDE_MARKER = '/* makeui:hand-edits — このコメント以降はエディタが管理します */';

/** The project's stylesheet, split into what was generated and what was edited. */
function projectSheet(
  html: string
): { path: string; generated: string; overrides: string } | null {
  const files = splitHtmlToFiles(html);
  if (files.length === 0 || detectKind(files) === null) return null;

  const sheet =
    files.find((f) => f.path === 'src/styles/globals.css') ??
    files.find((f) => f.path.endsWith('.css'));
  if (!sheet) return null;

  const at = sheet.content.indexOf(OVERRIDE_MARKER);
  return at === -1
    ? { path: sheet.path, generated: sheet.content, overrides: '' }
    : {
        path: sheet.path,
        generated: sheet.content.slice(0, at),
        overrides: sheet.content.slice(at + OVERRIDE_MARKER.length),
      };
}

export interface StyleEdit {
  selector: string;
  property: string;
  /** Empty removes the declaration rather than writing an empty value. */
  value: string;
}

/**
 * True when the document is a project rather than a single editable page.
 *
 * This was `/data-file=["'][^"']+\.(?:tsx|jsx)["']/` — the transport React
 * projects travelled in before line fences, and a test naming React while the
 * question is "is this a project". False for every current document, and it is
 * what guards the text-editing path.
 *
 * Text editing is single-page only: a project's text lives in a .tsx, .vue or
 * .svelte file, and the rendered DOM has no honest path back to it. With the
 * guard reading false, the path was offered on every project. `applyTextEdit`
 * then parses the whole document with DOMParser and re-serialises it — and a
 * fenced project's source sits in the body as text, so `<button className=…>`
 * comes back as `&lt;button className=…&gt;`. Not a no-op: a round trip through
 * that parser escapes every source file in the project.
 *
 * Both transports, and by regex rather than through `splitHtmlToFiles`: reading
 * the legacy one needs DOMParser, and a guard that protects against document
 * corruption should not be the thing that depends on a parser being present.
 */
export function isReactDocument(html: string): boolean {
  // A fenced project: a whole-line opener naming a component file.
  if (/^@@@makeui:file .*\.(?:tsx|jsx|vue)\s*$/m.test(html)) return true;
  // The transport stored projects still travel in.
  return /data-file=["'][^"']+\.(?:tsx|jsx|vue)["']/i.test(html);
}

function escapeSelector(selector: string): string {
  return selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The one stylesheet hand edits are written to, and read back from.
 *
 * Reading and writing must name the same file or the inspector shows one thing
 * and the document contains another. They were separate at first and disagreed
 * immediately: the reader matched any `.css` block, found the generated
 * stylesheet before the override one, and reported the generated values as the
 * user's edits.
 *
 * A React project writes into the stylesheet it already has, because a second
 * CSS file is not in its build. A single page gets its own override block, so
 * hand edits stay separable from generated CSS.
 */
function targetCssPath(html: string): string {
  if (isReactDocument(html)) {
    const m = /<style\b[^>]*data-file=["']([^"']+\.css)["']/i.exec(html);
    if (m) return m[1];
  }
  return OVERRIDE_FILE;
}

/** The stylesheet block for an exact data-file path. */
function findBlock(
  html: string,
  path: string
): { css: string; index: number; length: number; open: string; close: string } | null {
  const re = new RegExp(
    `(<style\\b[^>]*data-file=["']${escapeSelector(path)}["'][^>]*>)([\\s\\S]*?)(</style>)`,
    'i'
  );
  const m = re.exec(html);
  return m ? { css: m[2], index: m.index, length: m[0].length, open: m[1], close: m[3] } : null;
}

/**
 * Reads back the declarations this module has written for a selector.
 *
 * Only the override block is consulted. What the generated CSS says is shown
 * separately by the inspector; what belongs here is what the user has changed,
 * because that is what a second edit of the same property must replace.
 */
export function readOverrides(html: string, selector: string): Record<string, string> {
  const sheet = projectSheet(html);
  const css = sheet ? sheet.overrides : findBlock(html, targetCssPath(html))?.css;
  if (css === undefined || css === null) return {};
  const rule = ruleIn(css, selector);
  if (!rule) return {};
  const out: Record<string, string> = {};
  for (const decl of rule.body.split(';')) {
    const i = decl.indexOf(':');
    if (i > 0) out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
  }
  return out;
}

/**
 * The rule for exactly this selector.
 *
 * Anchored on a rule boundary at the front, because `.card` otherwise matches
 * inside `.card-title` and an edit to one silently reads and rewrites the other.
 */
function ruleIn(
  css: string,
  selector: string
): { index: number; length: number; open: string; body: string; close: string } | null {
  const re = new RegExp(`(^|[};]|\\n)(\\s*${escapeSelector(selector)}\\s*\\{)([^}]*)(\\})`);
  const m = re.exec(css);
  if (!m) return null;
  return {
    index: m.index + m[1].length,
    length: m[0].length - m[1].length,
    open: m[2],
    body: m[3],
    close: m[4],
  };
}

/**
 * Applies a style change and returns the new document.
 *
 * Written as an override rule appended after the generated CSS rather than by
 * editing the rule the value came from. Editing in place would need to know
 * which of several matching rules actually won the cascade, and getting that
 * wrong silently produces a change the user cannot see — while an override at
 * the end of the last stylesheet wins by position, whatever the original said.
 */
export function applyStyleEdit(html: string, edit: StyleEdit): string {
  const { selector, property } = edit;
  const value = edit.value.trim();
  if (!selector || !property) return html;

  /*
   * A project takes the edit into its own stylesheet, because that is the only
   * CSS its preview compiles. Writing a <style> block into the document instead
   * produced no error and no change — see OVERRIDE_MARKER above.
   */
  const sheet = projectSheet(html);
  if (sheet) {
    const nextOverrides = writeDeclaration(sheet.overrides, selector, property, value);
    if (nextOverrides === sheet.overrides) return html;
    const body = nextOverrides.trim()
      ? `${sheet.generated.replace(/\s+$/, '')}\n\n${OVERRIDE_MARKER}\n${nextOverrides.trim()}\n`
      : // The last hand edit was removed: take the marker with it rather than
        // leaving an empty section that reads as an edit nobody made.
        `${sheet.generated.replace(/\s+$/, '')}\n`;
    return applyFileEdit(html, sheet.path, body) ?? html;
  }

  const path = targetCssPath(html);
  const existing = findBlock(html, path);

  const nextCss = writeDeclaration(existing ? existing.css : '', selector, property, value);
  if (existing) {
    return (
      html.slice(0, existing.index) +
      existing.open + nextCss + existing.close +
      html.slice(existing.index + existing.length)
    );
  }

  // Removing something that was never written is not a change, and must not be
  // the reason an empty stylesheet appears in the document.
  if (!nextCss.trim()) return html;

  // No stylesheet to write into: add one at the end of <head>, or of the
  // document, so it still wins on position.
  const block = `<style data-file="${path}">${nextCss}</style>`;
  const head = html.lastIndexOf('</head>');
  if (head !== -1) return html.slice(0, head) + block + html.slice(head);
  const body = html.lastIndexOf('</body>');
  if (body !== -1) return html.slice(0, body) + block + html.slice(body);
  return html + block;
}

/** Insert, replace or delete one declaration inside a stylesheet's text. */
function writeDeclaration(css: string, selector: string, property: string, value: string): string {
  const rule = ruleIn(css, selector);

  if (!rule) {
    if (!value) return css;
    const trimmed = css.replace(/\s+$/, '');
    return `${trimmed}${trimmed ? '\n' : ''}${selector} { ${property}: ${value}; }\n`;
  }

  const decls = rule.body
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .filter((d) => d.slice(0, d.indexOf(':')).trim() !== property);
  if (value) decls.push(`${property}: ${value}`);

  // A rule left with nothing in it is removed rather than kept as `sel { }`,
  // so undoing every edit to an element leaves the document as it started.
  if (decls.length === 0) {
    return (css.slice(0, rule.index) + css.slice(rule.index + rule.length)).replace(/\n{3,}/g, '\n\n');
  }
  const body = ` ${decls.join('; ')}; `;
  return css.slice(0, rule.index) + rule.open + body + rule.close + css.slice(rule.index + rule.length);
}

export interface TextEditResult {
  html: string;
  /** False when the selector matched nothing, so the caller can say so. */
  applied: boolean;
}

/**
 * Replaces the text of the element a selector points at.
 *
 * Serialised through DOMParser rather than by string surgery: the selector is a
 * CSS selector, and the only thing that can resolve one correctly is a DOM.
 * Matching it with a regular expression would work on the simple cases and
 * quietly write into the wrong element on the rest.
 *
 * Refuses an element with element children. Replacing the text of a container
 * would delete everything inside it, which is not what "edit this text" means to
 * anyone who just clicked on a card.
 */
export function applyTextEdit(html: string, selector: string, text: string): TextEditResult {
  if (isReactDocument(html)) return { html, applied: false };
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return { html, applied: false };
  }
  let el: Element | null = null;
  try {
    el = doc.querySelector(selector);
  } catch {
    return { html, applied: false };
  }
  if (!el || el.children.length > 0) return { html, applied: false };
  el.textContent = text;
  const doctype = doc.doctype ? `<!DOCTYPE ${doc.doctype.name}>\n` : '';
  return { html: doctype + doc.documentElement.outerHTML, applied: true };
}

/** The current text of the selected element, or null when it is not editable. */
export function readText(html: string, selector: string): string | null {
  if (isReactDocument(html)) return null;
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const el = doc.querySelector(selector);
    if (!el || el.children.length > 0) return null;
    return el.textContent ?? '';
  } catch {
    return null;
  }
}
