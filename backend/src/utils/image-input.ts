/**
 * The one place a user-supplied image is turned into something a model can read.
 *
 * Every generation path used to carry the image only as a *claim*: the prompts said
 * "A reference image was provided — extract layout structure, colour palette and
 * component patterns from it" while the bytes were never attached to any Bedrock
 * call. The model was told an image existed, could not see it, and invented one.
 * That is worse than ignoring the attachment, because the output looks like it
 * followed a reference.
 *
 * Two shapes reach us: a `data:image/png;base64,…` URI from the browser, and a bare
 * base64 payload. Both are accepted, because both are already accepted by the
 * endpoints' validation.
 */

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp';

export interface ImageInput {
  format: ImageFormat;
  /** The media type Bedrock's Anthropic API expects. */
  mediaType: `image/${ImageFormat}`;
  /** Base64 payload with any data-URI preamble removed. */
  base64: string;
}

/** Returns null for absent or unusable input, so callers can simply skip attaching. */
export function parseImageInput(image: string | undefined | null): ImageInput | null {
  if (!image || typeof image !== 'string') return null;
  const base64 = image.includes(',') ? image.slice(image.indexOf(',') + 1) : image;
  if (!base64) return null;
  const format: ImageFormat = image.startsWith('data:image/jpeg')
    ? 'jpeg'
    : image.startsWith('data:image/gif')
      ? 'gif'
      : image.startsWith('data:image/webp')
        ? 'webp'
        : 'png';
  return { format, mediaType: `image/${format}`, base64 };
}

/**
 * A user message for the Bedrock Anthropic API, with the image first.
 *
 * Content stays a plain string when there is no image: the request body is
 * identical to what every call sent before, so adding image support cannot change
 * the behaviour of the calls that do not use it.
 */
export function userContentWithImage(
  text: string,
  image: ImageInput | null
): string | Array<Record<string, unknown>> {
  if (!image) return text;
  return [
    { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } },
    { type: 'text', text },
  ];
}

/**
 * The token the model writes where the user's own image should appear, replaced
 * with the real data URI once the document is built.
 *
 * The image is never put into the prompt: a data URI is base64, so asking a model
 * to copy one out costs a fortune in tokens and it only has to mistype one
 * character for the image to be silently corrupt. It writes a marker instead, and
 * the substitution happens here where it cannot go wrong.
 */
export const USER_IMAGE_TOKEN = '{{USER_IMAGE}}';

/**
 * How much data URI may be embedded in a generated document.
 *
 * This used to be 150,000 characters — about a 110KB photo — and the number came
 * from DynamoDB: version history and the project preview held the whole document
 * inline in a 400KB item. That meant the size of a *picture* decided whether a run
 * was recorded in history. Both now write the document to S3 and keep only a key,
 * so DynamoDB no longer constrains anything.
 *
 * What still binds is the edit path. `POST /modify` carries the document in the
 * request body, and an API Gateway → Lambda invocation caps at 6MB. A document that
 * cannot be sent back is a document that cannot be edited, so the ceiling is set so
 * that an embedded image still leaves room: 2,000,000 characters of base64 is a
 * ~1.5MB photo, giving a ~2MB document against a 3MB request limit.
 *
 * Attachments above it are still read as a design reference — they are just not
 * offered as content to embed, and the model draws its usual placeholder instead.
 */
export const MAX_EMBEDDED_IMAGE_CHARS = 2_000_000;

export function isEmbeddable(image: ImageInput | null): boolean {
  if (!image) return false;
  // +~30 for the `data:image/png;base64,` preamble the document will carry.
  return image.base64.length + 30 <= MAX_EMBEDDED_IMAGE_CHARS;
}

function toDataUri(image: ImageInput): string {
  return `data:${image.mediaType};base64,${image.base64}`;
}

/**
 * Puts the user's image into the finished document wherever the model asked for it.
 *
 * Returns the count so the caller can log whether the model actually used the
 * marker — "the user attached an image and it appears nowhere" is worth knowing,
 * and it is invisible otherwise.
 */
export function embedUserImage(html: string, image: ImageInput | null): { html: string; count: number } {
  if (!image || !isEmbeddable(image) || !html.includes(USER_IMAGE_TOKEN)) return { html, count: 0 };
  const uri = toDataUri(image);
  const count = html.split(USER_IMAGE_TOKEN).length - 1;
  return { html: html.split(USER_IMAGE_TOKEN).join(uri), count };
}

/**
 * What an attached image means, stated once for every stage that sees one.
 *
 * The design phase and the code assembler used to be told different things. The
 * assembler was offered the real choice — reference, or content to put on screen —
 * while the design phase was told flatly that "the attached image is the reference
 * for this design". The design phase runs first and writes the specification the
 * assembler is instructed to follow closely, so a request to *display* a photo
 * produced a spec that only described a visual style, and the assembler built that
 * spec. The image was read and then thrown away, which is exactly the report:
 * an uploaded picture that never appears.
 *
 * One statement, both stages. `canEmbed` is false for an attachment too large to
 * inline, and then option (b) is not offered at all — a marker the pipeline cannot
 * substitute would ship as a broken image.
 */
export function imageDirective(image: ImageInput | null, canEmbed: boolean, caption = ''): string {
  if (!image) return '';
  return imageDirectiveBody(canEmbed) + imageCaptionNote(caption);
}

/**
 * What the user said the attached picture is, when they said it.
 *
 * The composer has always offered a description box beside a lone picture and
 * only ever sent the text with a list of several, so a single picture's
 * description was typed and dropped. Stated after the directive, because the
 * directive asks the model to decide what the picture is for and this is the
 * user telling it. Clipped to the caption length every other description has.
 */
export function imageCaptionNote(caption: string): string {
  const text = caption.trim().slice(0, 120);
  if (!text) return '';
  return `\nThe user describes the attached image as: 「${text}」. Where you display it, this is its alt text.`;
}

function imageDirectiveBody(canEmbed: boolean): string {
  const display = canEmbed
    ? `(b) CONTENT TO DISPLAY — the user wants this picture ON the screen (a product photo, ` +
      `a logo, a hero image). Write ${USER_IMAGE_TOKEN} as the src and it will be replaced with ` +
      `the real image: <img src="${USER_IMAGE_TOKEN}" alt="…"> in HTML, ` +
      `src={"${USER_IMAGE_TOKEN}"} in JSX. Use it as many times as the design needs. Style it as ` +
      `you would a real photograph — object-fit: cover inside a sized, aspect-ratio box — and give ` +
      `it a real alt describing what it shows.\n` +
      `It can be both: take the design from it AND display it. When the request says to use, show ` +
      `or place the image, it is at least (b), and the specification must say where it appears.`
    : `(b) The image is too large to embed, so it cannot be displayed — use it as a reference only, ` +
      `and draw the normal photo placeholder wherever the picture itself would have gone.`;

  return (
    '\n\nAn image is attached. Decide from the request which of these it is:\n' +
    '(a) A DESIGN REFERENCE — read its layout structure, colour palette, type treatment and ' +
    'component patterns off the image and carry them into this build. Where the image and your own ' +
    'instincts disagree, the image wins.\n' +
    display +
    '\n\nPRECEDENCE when the image conflicts with something else:\n' +
    '  binding design system (if one is set)  >  THE IMAGE  >  past preferences  >  your instincts\n' +
    'Nothing but a binding design system outranks the image. In particular, do not carry a previous ' +
    'accent colour into a design the user attached a reference for — the attachment IS the ' +
    'instruction to change.'
  );
}
