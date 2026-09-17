/**
 * Marks each rendered element with the source line that produced it.
 *
 * Direct manipulation needs one thing the app did not have: a path from a node
 * in the preview back to the code that made it. Without it the only edits that
 * can be applied by hand are style overrides — which is why `directEdit` writes
 * override rules, and why editing text is possible on a single-page mock and not
 * on a project, as the comment there says: 「a React project's text lives in a
 * .tsx file and the rendered DOM has no honest path back to it」.
 *
 * Sucrase can already supply this. With `production: false` its JSX transform
 * emits `__source: { fileName, lineNumber }`, and the compiler is handed
 * `filePath` today. But that lands in React's element props and then in the
 * fiber, not in the DOM, so reading it back means walking React's internals and
 * tracking their shape across versions.
 *
 * An attribute is written instead. It is in the DOM, `querySelector` finds it,
 * every framework's compiler leaves an unknown `data-` attribute alone, and it
 * needs no agreement with any runtime.
 *
 * INJECTED FOR THE PREVIEW ONLY. The compile that feeds the iframe is a separate
 * pass from the one that produces an export, so nothing here reaches the ZIP or
 * the published site — the attribute exists for as long as the frame does.
 */

/** The attribute carrying `<path>:<line>`. Line numbers are 1-based. */
const ANCHOR_ATTR = 'data-mkui-src';

/**
 * A host element is one the DOM will actually have: a lowercase tag name.
 *
 * `<Button>` is a component — the DOM gets whatever it renders, and anchoring
 * the call site would point at a line that does not describe the node the user
 * clicked. Its own host elements are anchored where they are written, inside
 * that component's file, which is the file an edit has to change anyway.
 */
const HOST_TAG = /^[a-z][a-zA-Z0-9-]*$/;

type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';

/**
 * Whether the `<` at `i` opens a tag rather than being a less-than.
 *
 * JSX text cannot contain a bare `<`, so anything in code position followed by a
 * name is a tag. `a < b` is followed by a space, `a<b` by an identifier — which
 * is why the check is for a NAME rather than for any letter, and why the caller
 * only anchors lowercase names: `a<b>(c)` is a generic call, and `b` there is a
 * type, but it is also not a host tag, so it is skipped for a second reason.
 */
function tagNameAt(src: string, i: number): string | null {
  let j = i + 1;
  let name = '';
  while (j < src.length && /[a-zA-Z0-9.\-_$]/.test(src[j])) {
    name += src[j];
    j += 1;
  }
  return name || null;
}

/**
 * Keywords a JSX element may follow.
 *
 * Everything else that reads as a name before a `<` is a value, and a `<` after
 * a value is an operator or a type argument — never a tag.
 */
const EXPRESSION_KEYWORDS = new Set([
  'return', 'yield', 'await', 'typeof', 'void', 'delete', 'new', 'throw',
  'in', 'of', 'else', 'do', 'case', 'default',
]);

/**
 * Whether a `<` in code position opens a tag, given what came before it.
 *
 * This was missing, and it shipped: `useState<string>('')` was read as a tag
 * named `string` — lowercase, so it passed the host-element test — and the
 * anchor was written INTO the type argument, producing
 * `useState<string data-mkui-src="…">('')`. Every stored project using a
 * lowercase generic stopped compiling in the preview, reported as
 * `Unexpected token, expected ";"`. `Record<string, string>` and a plain
 * `a < b` fail the same way.
 *
 * The distinction is the token before it. After a value — an identifier, a
 * closing bracket, a number — a `<` is a comparison or a type argument. After
 * an operator, an opening bracket, or a keyword that expects an expression, it
 * can be a tag.
 */
function opensTag(before: string): boolean {
  let i = before.length - 1;
  while (i >= 0 && /\s/.test(before[i])) i -= 1;
  if (i < 0) return true;
  const c = before[i];
  if (!/[A-Za-z0-9_$)\]]/.test(c)) return true;
  // A name: a tag may follow it only when the name is a keyword expecting one.
  let j = i;
  while (j >= 0 && /[A-Za-z0-9_$]/.test(before[j])) j -= 1;
  return EXPRESSION_KEYWORDS.has(before.slice(j + 1, i + 1));
}

/**
 * Adds the anchor attribute to every host element in a JSX/TSX source.
 *
 * Scans rather than parses. A parser would be more exact and would mean carrying
 * one into the browser bundle for a job whose whole difficulty is quoting: the
 * only way to mistake a `<` for a tag is to read one inside a string, a comment
 * or a template literal, and those four states are what the scanner tracks.
 */
export function anchorJsx(path: string, source: string): string {
  let out = '';
  let mode: Mode = 'code';
  let line = 1;
  let i = 0;

  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (c === '\n') line += 1;

    if (mode === 'line') {
      out += c;
      if (c === '\n') mode = 'code';
      i += 1;
      continue;
    }
    if (mode === 'block') {
      out += c;
      if (c === '*' && next === '/') { out += next; i += 2; mode = 'code'; continue; }
      i += 1;
      continue;
    }
    if (mode === 'single' || mode === 'double' || mode === 'template') {
      out += c;
      if (c === '\\') { out += next ?? ''; i += 2; continue; }
      if ((mode === 'single' && c === "'") || (mode === 'double' && c === '"') || (mode === 'template' && c === '`')) {
        mode = 'code';
      }
      i += 1;
      continue;
    }

    // code
    if (c === '/' && next === '/') { out += '//'; i += 2; mode = 'line'; continue; }
    if (c === '/' && next === '*') { out += '/*'; i += 2; mode = 'block'; continue; }
    if (c === "'") { out += c; i += 1; mode = 'single'; continue; }
    if (c === '"') { out += c; i += 1; mode = 'double'; continue; }
    if (c === '`') { out += c; i += 1; mode = 'template'; continue; }

    if (c === '<' && next !== '/' && next !== '<' && next !== '=' && opensTag(out)) {
      const name = tagNameAt(source, i);
      if (name && HOST_TAG.test(name)) {
        out += `<${name} ${ANCHOR_ATTR}="${path}:${line}"`;
        i += 1 + name.length;
        continue;
      }
    }

    out += c;
    i += 1;
  }

  return out;
}

/** Splits `path:line` back into its two halves, or null if it is not one. */
export function readAnchor(value: string | null | undefined): { path: string; line: number } | null {
  if (!value) return null;
  const at = value.lastIndexOf(':');
  if (at <= 0) return null;
  const line = Number(value.slice(at + 1));
  if (!Number.isInteger(line) || line < 1) return null;
  return { path: value.slice(0, at), line };
}

/**
 * The same anchors, for a template language rather than for JSX.
 *
 * Vue and Svelte both hand their compiler a whole file and take markup out of
 * part of it, so the injection point is the same place React's is — before the
 * compiler runs — and only the region differs. A `data-` attribute the compiler
 * does not recognise is emitted as a static attribute, which is what makes this
 * work at all: neither framework has to know the attribute exists.
 *
 * Simpler than JSX in one way and harder in another. There is no arbitrary
 * JavaScript around the markup to mistake for it, but the markup itself is not
 * the whole file — and Svelte's blocks (`{#if a < b}`) put expressions inside
 * the markup, so a `<` between braces is still not a tag.
 */
function anchorMarkup(path: string, source: string, from: number, to: number, startLine: number): string {
  let out = '';
  let line = startLine;
  let quote: string | null = null;
  let braces = 0;
  let inTag = false;
  let i = from;

  while (i < to) {
    const c = source[i];
    if (c === '\n') line += 1;

    if (quote) {
      out += c;
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (inTag && (c === '"' || c === "'")) { out += c; quote = c; i += 1; continue; }
    if (c === '>' && inTag && braces === 0) { out += c; inTag = false; i += 1; continue; }

    // `{...}` is an expression in both languages — Svelte's blocks and
    // interpolations, Vue's bindings inside attribute values.
    if (c === '{') { braces += 1; out += c; i += 1; continue; }
    if (c === '}') { braces = Math.max(0, braces - 1); out += c; i += 1; continue; }

    if (c === '<' && braces === 0 && !inTag) {
      const name = tagNameAt(source, i);
      if (name && HOST_TAG.test(name)) {
        out += `<${name} ${ANCHOR_ATTR}="${path}:${line}"`;
        i += 1 + name.length;
        inTag = true;
        continue;
      }
      if (name) { inTag = true; }
    }

    out += c;
    i += 1;
  }
  return out;
}

/** The 1-based line an index sits on. */
function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (source[i] === '\n') line += 1;
  return line;
}

/**
 * Anchors a `.vue` single-file component.
 *
 * Only inside `<template>`. A `<script>` block's `<` is JavaScript, and a
 * `<style>` block's is nothing at all.
 */
export function anchorVue(path: string, source: string): string {
  const open = /<template[^>]*>/.exec(source);
  if (!open) return source;
  const start = open.index + open[0].length;
  const end = source.lastIndexOf('</template>');
  if (end <= start) return source;
  return (
    source.slice(0, start) +
    anchorMarkup(path, source, start, end, lineOf(source, start)) +
    source.slice(end)
  );
}

/**
 * Anchors a `.svelte` component.
 *
 * The markup is everything that is not a `<script>` or `<style>` block, so the
 * regions are found by cutting those out rather than by naming one container.
 */
export function anchorSvelte(path: string, source: string): string {
  const blocks: { start: number; end: number }[] = [];
  const re = /<(script|style)[^>]*>[\s\S]*?<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) blocks.push({ start: m.index, end: m.index + m[0].length });

  let out = '';
  let cursor = 0;
  for (const b of blocks) {
    out += anchorMarkup(path, source, cursor, b.start, lineOf(source, cursor));
    out += source.slice(b.start, b.end);
    cursor = b.end;
  }
  out += anchorMarkup(path, source, cursor, source.length, lineOf(source, cursor));
  return out;
}
