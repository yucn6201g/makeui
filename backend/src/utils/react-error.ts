/**
 * React's minified errors, turned back into sentences.
 *
 * The vendored React runtime is built with `NODE_ENV=production`, which is right
 * — it is the runtime the preview actually ships — but production React replaces
 * every invariant message with a number and a link. What the browser walk then
 * records, and what the repair pass is handed, is:
 *
 *   Error: Minified React error #130; visit https://reactjs.org/docs/error-decoder.html
 *   ?invariant=130&args[]=undefined for the full message
 *
 * Measured over 21 days of runtime errors: 34 of 197 were that shape, the single
 * largest category, and 31 of the 34 were #130 — a component rendered as
 * `undefined`, which is nearly always a default/named import mismatch or a
 * component that was never imported. That is an actionable fault arriving as a
 * number, in front of a model asked to fix it.
 *
 * Decoding here rather than switching the verification build to development
 * React: the point of the walk is to measure the document that ships, and the
 * development build runs different code — extra invariants, different warnings —
 * so it would be measuring something else.
 *
 * The table is deliberately partial. It holds the codes actually seen, the
 * message text copied from React's own `scripts/error-codes/codes.json`, and an
 * unknown code passes through untouched with its link intact. A wrong sentence
 * would be worse than a number; a missing one is just today's behaviour.
 */

/** Message templates, verbatim from React's codes.json. `%s` takes an argument. */
const MESSAGES: Record<string, string> = {
  '130': 'Element type is invalid: expected a string (for built-in components) or a class/function (for composite components) but got: %s.%s',
  '301': 'Too many re-renders. React limits the number of renders to prevent an infinite loop.',
  '310': 'Rendered more hooks than during the previous render.',
};

/**
 * What #130 means in this pipeline, which is narrower than what it means in
 * general — every document here is assembled from the same transport, so the
 * ways a component can be `undefined` at render are a short list.
 */
const ADVICE: Record<string, string> = {
  '130': ' — a component rendered as undefined. Usual causes: a default export imported'
    + ' by name (or the reverse), a component used in markup that was never imported,'
    + ' or a file whose export name does not match the import.',
};

const MINIFIED = /Minified React error #(\d+)[^\n]*/;

/** The `args[]=` values a minified error carries, in order, already decoded. */
function argsOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/args(?:\[\]|%5B%5D)=([^&\s]*)/gi)) {
    try {
      out.push(decodeURIComponent(m[1]));
    } catch {
      // A malformed escape is not a reason to lose the whole message.
      out.push(m[1]);
    }
  }
  return out;
}

/**
 * One console error, readable where it can be.
 *
 * Anything that is not a minified React error — a TypeError from the document's
 * own code, a Svelte parse failure — is returned exactly as it came in.
 */
export function decodeReactError(text: string): string {
  const hit = MINIFIED.exec(text);
  if (!hit) return text;

  const code = hit[1];
  const template = MESSAGES[code];
  if (!template) return text;

  const args = argsOf(text);
  let i = 0;
  const message = template.replace(/%s/g, () => args[i++] ?? '');

  /*
   * The code is kept in the output. It is how anyone reading a log later gets
   * back to React's own page, and it is what makes a new code visible as a code
   * rather than as a sentence this table happened not to have.
   */
  const rest = text.slice(0, hit.index).trim();
  return `${rest ? `${rest} ` : ''}React #${code}: ${message.trim()}${ADVICE[code] ?? ''}`;
}

/** The same, for the list the browser walk collects. */
export function decodeReactErrors(texts: readonly string[]): string[] {
  return texts.map(decodeReactError);
}
