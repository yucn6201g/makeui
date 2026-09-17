/**
 * Taking the pictures back out before a model is asked to rewrite the file.
 *
 * The generate path never shows a model a data URI: it writes `{{USER_IMAGE_1}}`
 * and the bytes are substituted after the build. That protection stopped at the
 * document boundary. Once the pictures are IN the document, every later pass
 * that rewrites a file sends them straight back to a model, because a file body
 * goes into the prompt whole.
 *
 * Measured on a real generated project with two supplied photographs: the model
 * had put both into `src/data/products.ts`, which came to 527,914 characters —
 * about 132,000 tokens. The measured median edit is 14,439 tokens total, so that
 * one file is nine edits' worth, and it is the seed data: the file an edit like
 * 「商品を追加して」 touches first.
 *
 * The cost is only half of it. The model is being asked to reproduce a base64
 * payload character for character, and one wrong character is an image that is
 * silently broken rather than missing. The whole marker design exists to avoid
 * exactly that, and it was doing so in only one direction.
 *
 * There is a third effect that looks unrelated and is not. `repairFiles` and
 * `applyFileEdits` both reject a reply "far shorter than the file it replaces"
 * at 0.6x. Against a body inflated by half a megabyte of base64 that ratio
 * stops meaning anything: a correct rewrite that drops one picture reads as a
 * 90% shrink and is thrown away. Swapping the pictures out restores the guard
 * to comparing code with code.
 *
 * ## The round trip
 *
 * `lean()` replaces every data URI with a short marker and hands back the map.
 * `restore()` puts them back by marker. Between those two calls the text is safe
 * to put in a prompt, and it is the ONLY thing that should be put in one.
 *
 * A marker the model dropped is reported rather than restored. Deleting a
 * picture can be exactly what was asked for — 「この写真を外して」 — so the
 * caller decides; what it must not be is invisible.
 */

/** `data:image/png;base64,AAAA…`, in a source file, an attribute or a string. */
const DATA_URI_RE = /data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+/g;

/**
 * Below this a data URI is cheaper to send than to work around.
 *
 * A tiny inline SVG icon or a 1px spacer is a handful of tokens and may be
 * something the model legitimately needs to read. The point of this module is
 * the photographs, which are five and six figures of base64.
 */
export const MIN_EXTRACTED_CHARS = 512;

/** The marker for image `i` (1-based). */
export const embeddedImageToken = (i: number): string => `{{EMBEDDED_IMAGE_${i}}}`;

const TOKEN_RE = /\{\{EMBEDDED_IMAGE_(\d+)\}\}/g;

/**
 * Told to the model wherever `lean()` has been applied.
 *
 * Short on purpose: it is prepended to prompts that already run long, and the
 * only thing the model has to do is nothing. Without it, a model tidying up
 * what looks like a templating leftover deletes the user's photograph.
 */
export const EMBEDDED_IMAGE_NOTE =
  '\n\nNOTE: {{EMBEDDED_IMAGE_n}} stands for a picture already in this project. '
  + 'It is a placeholder for real image data that was taken out to keep this request small. '
  + 'Copy each one through EXACTLY as it appears — do not expand it, rename it, or remove it '
  + 'unless the request is to remove that picture.';

export interface LeanText {
  /** The text with every extracted picture replaced by its marker. */
  text: string;
  /** Marker -> the data URI it stands for. Empty when nothing was extracted. */
  images: Map<string, string>;
  /** How many characters the extraction removed. For the log, and for deciding. */
  saved: number;
}

/**
 * Replace the embedded pictures with markers.
 *
 * Identical URIs share one marker: a photograph used in a card and again in a
 * detail header is one picture, and giving it two markers would let a model
 * keep one and drop the other without that reading as a loss.
 */
export function lean(text: string): LeanText {
  const images = new Map<string, string>();
  const byUri = new Map<string, string>();
  let saved = 0;
  const out = text.replace(DATA_URI_RE, (uri) => {
    if (uri.length < MIN_EXTRACTED_CHARS) return uri;
    const existing = byUri.get(uri);
    if (existing) {
      saved += uri.length - existing.length;
      return existing;
    }
    const token = embeddedImageToken(byUri.size + 1);
    byUri.set(uri, token);
    images.set(token, uri);
    saved += uri.length - token.length;
    return token;
  });
  return { text: out, images, saved };
}

/**
 * Put them back.
 *
 * `missing` is the markers that did not come back — pictures the model removed.
 * That can be right, so it is returned rather than corrected, and the caller
 * logs it. What is never right is a marker surviving into a shipped document, so
 * any marker with no image behind it is stripped: it would render as a broken
 * `src` otherwise.
 */
export function restore(
  text: string,
  images: Map<string, string>
): { text: string; restored: number; missing: string[] } {
  if (images.size === 0) return { text, restored: 0, missing: [] };
  let restored = 0;
  const seen = new Set<string>();
  const out = text.replace(TOKEN_RE, (token) => {
    const uri = images.get(token);
    if (!uri) return '';
    seen.add(token);
    restored += 1;
    return uri;
  });
  const missing = [...images.keys()].filter((t) => !seen.has(t));
  return { text: out, restored, missing };
}
