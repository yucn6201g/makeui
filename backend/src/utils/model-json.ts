/**
 * The JSON object out of a model's reply, when the reply is not only JSON.
 *
 * Five call sites asked for it the same way — `text.match(/\{[\s\S]*\}/)` — and
 * that pattern is wrong in both directions, because `[\s\S]*` is greedy and
 * anchored on nothing:
 *
 *   - trailing prose. `{"files":[…]}\n\nこの変更は…{…}` matches from the first
 *     `{` to the LAST `}`, so the object and the sentence after it are handed to
 *     JSON.parse together. Measured 2026-08-29 on the edit planner:
 *     `SyntaxError: Unexpected non-whitespace character after JSON at position
 *     153`. The planner had answered correctly and the reply was thrown away.
 *   - leading prose. A `{` anywhere before the object — a brace in an
 *     explanation, a code fence with an example — moves the start, and the
 *     match is garbage from the first character.
 *
 * What made it expensive is what happens next: the caller reads a failed parse
 * as "no plan" and falls back to rewriting the whole document, which costs about
 * nineteen times what the per-file path costs. A brace in a sentence bought a
 * 77,000-token rewrite.
 *
 * So this scans candidate starts in order and returns the first one that both
 * balances and parses. Strings and escapes are respected, because a `}` inside
 * a string value is not a close — `{"reason":"} と表示される"}` is a real reply
 * shape here, and counting braces naively truncates it.
 */

/** The end index (exclusive) of the object starting at `start`, or -1. */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { if (inString) escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
      /*
       * More closes than opens means this `{` was never the start of an object —
       * it was inside one whose opening brace is further back, or in prose.
       * Giving up here rather than continuing keeps the scan linear per start.
       */
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/**
 * The first well-formed JSON object in `text`, parsed, or null.
 *
 * Objects only. Every caller here asks a model for `{...}` and reads a named
 * field off it; a bare array or a number would be a different reply shape and
 * silently accepting one would move the failure to the field access.
 */
export function firstJsonObject<T = unknown>(text: string): T | null {
  if (typeof text !== 'string') return null;
  for (let i = text.indexOf('{'); i !== -1; i = text.indexOf('{', i + 1)) {
    const end = balancedEnd(text, i);
    if (end === -1) continue;
    try {
      const value = JSON.parse(text.slice(i, end));
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as T;
    } catch {
      /*
       * Balanced but not valid JSON — a `{` in prose that happens to close. Keep
       * looking rather than failing, which is the case the greedy match could
       * not survive at all.
       */
    }
  }
  return null;
}
