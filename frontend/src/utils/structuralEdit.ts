/**
 * Deleting and reordering an element by editing the source that produced it.
 *
 * The same two operations can be faked with CSS. `display: none` hides a node
 * and `order: N` reorders a flex child, both of which `directEdit` could already
 * write as overrides, with no new machinery at all. That is the version worth
 * refusing: a hidden element is still in the file, so the next model edit still
 * sees it, the conformance pass still measures it, and the exported project
 * still ships it. The document would look right and be wrong — which is this
 * codebase's characteristic failure, not a new one worth adding.
 *
 * So these edit the source. Everything here is a pure function of (source,
 * line); nothing reaches the network and the previous string is the undo.
 *
 * The rule throughout is to refuse rather than guess. An edit that lands in the
 * wrong place is worse than one that does not happen: the user watches a screen
 * change in a way they did not ask for, and the file it came from is not the one
 * they were looking at.
 */

/** Where an element begins and ends in its file, and what tag it is. */
export interface ElementRange {
  /** Index of the `<`. */
  start: number;
  /** Index one past the final `>`. */
  end: number;
  tag: string;
}

const NAME = /[a-zA-Z0-9.\-_$]/;

/**
 * Elements HTML closes on their own.
 *
 * JSX requires the slash — `<img />` — so this changes nothing there. A Svelte
 * or Vue template does not, and without the list a `<br>` was pushed onto the
 * stack and never popped: the scanner ran to the end of the file and returned
 * null. That is the safe failure and it was still a failure, since it took every
 * element AFTER a void one with it — measured on a template holding an `<img>`,
 * a `<p>` with a `<br>` inside, and an `<input>`, all three of which refused.
 */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

function nameAt(src: string, i: number): string {
  let j = i + 1;
  let name = '';
  while (j < src.length && NAME.test(src[j])) { name += src[j]; j += 1; }
  return name;
}

/**
 * The `>` that ends an opening or closing tag, and whether it self-closed.
 *
 * Character by character rather than `indexOf('>')`, because an attribute value
 * may hold one: `<input placeholder="<b>bold</b>" />` ends at the slash, not
 * inside the placeholder. Reading the first `>` cut the element off mid-string
 * and every offset after it was wrong.
 */
function endOfTag(src: string, i: number): { gt: number; selfClosing: boolean } | null {
  let j = i + 1;
  let quote: string | null = null;
  while (j < src.length) {
    const c = src[j];
    if (quote) {
      if (c === '\\') { j += 2; continue; }
      if (c === quote) quote = null;
      j += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; j += 1; continue; }
    if (c === '>') return { gt: j, selfClosing: src[j - 1] === '/' };
    j += 1;
  }
  return null;
}

/**
 * Walks forward from an opening tag to the `>` that closes the element.
 *
 * Keeps a stack of tag NAMES rather than a depth count. A count alone cannot
 * tell a correct nesting from a broken one: a `<span>` left unclosed inside a
 * `<div>` decrements to zero at the div's closing tag and reports that the span
 * ended there, so an edit anchored on the span would take the div's text with
 * it. With the stack, a close that does not match the top is a refusal.
 *
 * Strings and comments are skipped for the reason they are in `sourceAnchors`:
 * a `<` inside one is not a tag.
 */
function scanTo(src: string, from: number): number | null {
  let i = from;
  const stack: string[] = [];
  let mode: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (mode === 'line') { if (c === '\n') mode = 'code'; i += 1; continue; }
    if (mode === 'block') { if (c === '*' && next === '/') { i += 2; mode = 'code'; continue; } i += 1; continue; }
    if (mode === 'single' || mode === 'double' || mode === 'template') {
      if (c === '\\') { i += 2; continue; }
      if ((mode === 'single' && c === "'") || (mode === 'double' && c === '"') || (mode === 'template' && c === '`')) mode = 'code';
      i += 1;
      continue;
    }

    if (c === '/' && next === '/') { i += 2; mode = 'line'; continue; }
    if (c === '/' && next === '*') { i += 2; mode = 'block'; continue; }
    // Only outside a tag: inside one, a quote opens an attribute value, which
    // `endOfTag` handles on its own.
    if (stack.length === 0 && i > from && (c === "'" || c === '"' || c === '`')) {
      mode = c === "'" ? 'single' : c === '"' ? 'double' : 'template';
      i += 1;
      continue;
    }

    if (c === '<' && next === '/') {
      const name = nameAt(src, i + 1);
      const end = endOfTag(src, i);
      if (!end) return null;
      if (stack.pop() !== name) return null;
      i = end.gt + 1;
      if (stack.length === 0) return i;
      continue;
    }

    if (c === '<' && nameAt(src, i)) {
      const name = nameAt(src, i);
      const end = endOfTag(src, i);
      if (!end) return null;
      const closes = end.selfClosing || VOID_TAGS.has(name.toLowerCase());
      if (!closes) stack.push(name);
      i = end.gt + 1;
      if (closes && stack.length === 0) return i;
      continue;
    }

    i += 1;
  }
  return null;
}

/** The 0-based index at which a 1-based line starts, or null past the end. */
function lineStart(src: string, line: number): number | null {
  if (line < 1) return null;
  let i = 0;
  for (let n = 1; n < line; n += 1) {
    const nl = src.indexOf('\n', i);
    if (nl === -1) return null;
    i = nl + 1;
  }
  return i;
}

/**
 * The element written on `line`, or null.
 *
 * The anchor records the line the tag opens on, so the search starts there and
 * takes the first `<` — an element written across several lines is found by its
 * opening line, which is the one that was recorded.
 */
export function elementRange(source: string, line: number): ElementRange | null {
  const from = lineStart(source, line);
  if (from === null) return null;
  const lineEnd = source.indexOf('\n', from);
  const limit = lineEnd === -1 ? source.length : lineEnd;

  for (let i = from; i < limit; i += 1) {
    if (source[i] !== '<' || source[i + 1] === '/') continue;
    const tag = nameAt(source, i);
    if (!tag) continue;
    const end = scanTo(source, i);
    if (end === null) return null;
    return { start: i, end, tag };
  }
  return null;
}

/**
 * The element immediately before or after this one among its siblings.
 *
 * Only whitespace may separate them. Text, a `{expression}`, a comment — any of
 * those means the two are not simply adjacent, and moving one past something
 * whose role is unknown is exactly the guess this file refuses to make. The user
 * sees the control do nothing rather than see the screen rearrange in a way they
 * cannot predict.
 */
function siblingRange(source: string, range: ElementRange, dir: -1 | 1): ElementRange | null {
  if (dir === 1) {
    let i = range.end;
    while (i < source.length && /\s/.test(source[i])) i += 1;
    if (source[i] !== '<' || source[i + 1] === '/') return null;
    const tag = nameAt(source, i);
    if (!tag) return null;
    const end = scanTo(source, i);
    return end === null ? null : { start: i, end, tag };
  }

  // Backwards: the previous sibling ends where the whitespace before this one
  // begins, and its own start has to be found by scanning candidates forward —
  // there is no way to walk a tag backwards, so every `<` before this element is
  // tried and the one whose extent lands exactly on our start is the sibling.
  let i = range.start - 1;
  while (i >= 0 && /\s/.test(source[i])) i -= 1;
  if (i < 0 || source[i] !== '>') return null;
  const prevEnd = i + 1;

  for (let j = prevEnd - 1; j >= 0; j -= 1) {
    if (source[j] !== '<' || source[j + 1] === '/') continue;
    const tag = nameAt(source, j);
    if (!tag) continue;
    const end = scanTo(source, j);
    if (end === prevEnd) return { start: j, end, tag };
    if (end !== null && end > prevEnd) return null;
  }
  return null;
}

/** Trailing whitespace on the line the element sat on, so no blank line is left. */
function withGapRemoved(source: string, range: ElementRange): string {
  let end = range.end;
  let start = range.start;
  // Take the indentation in front of it and the newline behind it, together, so
  // the surrounding lines close up instead of leaving a hole.
  while (start > 0 && (source[start - 1] === ' ' || source[start - 1] === '\t')) start -= 1;
  if (source[end] === '\n') end += 1;
  else if (start > 0 && source[start - 1] === '\n') start -= 1;
  return source.slice(0, start) + source.slice(end);
}

/** Removes the element written on `line`. Returns null when it cannot be found. */
export function deleteElement(source: string, line: number): string | null {
  const range = elementRange(source, line);
  if (!range) return null;
  return withGapRemoved(source, range);
}

/**
 * Swaps the element written on `line` with the sibling before or after it.
 *
 * A swap rather than a move: the two occupy each other's spans exactly, so the
 * surrounding text — indentation, the lines above and below — is untouched.
 */
export function moveElement(source: string, line: number, dir: -1 | 1): string | null {
  const range = elementRange(source, line);
  if (!range) return null;
  const sib = siblingRange(source, range, dir);
  if (!sib) return null;

  const first = dir === -1 ? sib : range;
  const second = dir === -1 ? range : sib;
  return (
    source.slice(0, first.start) +
    source.slice(second.start, second.end) +
    source.slice(first.end, second.start) +
    source.slice(first.start, first.end) +
    source.slice(second.end)
  );
}

/**
 * The element's text, when its text is all it has.
 *
 * `directEdit` can already do this for a single-page mock, by selector, and says
 * why it cannot for a project: the rendered DOM had no path back to the file.
 * The anchor is that path, so the operation becomes available — for the elements
 * where it is honest.
 *
 * Refused when the content holds anything but text. `<h1>在庫 {n}</h1>` has a
 * binding in it, and replacing the content wholesale would delete the binding
 * while looking like a wording change; a nested element would be deleted the
 * same way. Both are the class of edit this file exists to not make.
 */
export function elementText(source: string, line: number): string | null {
  const range = elementRange(source, line);
  if (!range) return null;
  if (VOID_TAGS.has(range.tag.toLowerCase())) return null;
  const open = endOfTag(source, range.start);
  if (!open || open.selfClosing) return null;
  const close = source.lastIndexOf('</', range.end);
  if (close <= open.gt) return null;
  const inner = source.slice(open.gt + 1, close);
  if (inner.includes('<') || inner.includes('{')) return null;
  return inner.trim();
}

/**
 * Replaces that text, keeping the whitespace around it.
 *
 * The new text is refused if it carries `<` or `{`. Neither is text in any of
 * the three languages — one opens an element and the other an expression — so
 * accepting them would turn something typed into a text box into markup, which
 * is not what the box says it does.
 */
export function setElementText(source: string, line: number, text: string): string | null {
  if (text.includes('<') || text.includes('{')) return null;
  const range = elementRange(source, line);
  if (!range) return null;
  if (VOID_TAGS.has(range.tag.toLowerCase())) return null;
  const open = endOfTag(source, range.start);
  if (!open || open.selfClosing) return null;
  const close = source.lastIndexOf('</', range.end);
  if (close <= open.gt) return null;
  const inner = source.slice(open.gt + 1, close);
  if (inner.includes('<') || inner.includes('{')) return null;
  const lead = /^\s*/.exec(inner)?.[0] ?? '';
  const trail = /\s*$/.exec(inner)?.[0] ?? '';
  return source.slice(0, open.gt + 1) + lead + text + trail + source.slice(close);
}
