import {
  parseImageInput,
  MAX_EMBEDDED_IMAGE_CHARS,
  type ImageInput,
} from './image-input.js';

/**
 * Pictures the user wants to appear IN the generated UI, as opposed to the one
 * they attach as a design reference.
 *
 * The two are different jobs and this file exists because only one of them needs
 * a model to look at anything.
 *
 * `image-input.ts` handles the reference: a single attachment the design phase
 * and the assembler both SEE, because "read the layout, palette and type off
 * this" cannot be done from a description. Its bytes go into vision calls, and
 * that is the right trade for one image.
 *
 * A content image is the opposite. To place a product photo the model needs to
 * know what the picture is and where it belongs — not what it looks like pixel
 * by pixel. So the bytes never enter a model call at all: each image is captioned
 * ONCE (see `image-captions.ts`), the captions travel as text, and the real data
 * URI is substituted after the document is built.
 *
 * That is the whole reason for the split, and it is a cost argument with numbers
 * behind it. An image costs roughly `width * height / 750` tokens to look at —
 * about 1,300 for a 1000x1000 photo. The design phase is five model calls and the
 * build is another, so showing five images to each of them is about 39,000 tokens
 * on a run whose measured median is 154,000. Captioning them once is one call,
 * flat, no matter how long the pipeline gets.
 *
 * ## Why a marker rather than the image
 *
 * The same reason the single image uses one: a data URI is base64, a model
 * copying one out is ruinously expensive, and one mistyped character is a
 * silently broken image. The model writes `{{USER_IMAGE_1}}` and the
 * substitution happens in code, where it cannot go wrong.
 */

/**
 * How many content images one request may carry.
 *
 * Eight is a screen's worth — a product grid, a gallery, a set of avatars — and
 * past it the brief is better served by the stock library, which is already
 * offered to the design phase and costs nothing to place.
 */
export const MAX_CONTENT_IMAGES = 8;

/**
 * How long a description may be, whoever wrote it.
 *
 * It becomes alt text and it is concatenated into every later prompt, so the
 * bound is the same for a user's sentence as for a model's.
 */
export const MAX_CAPTION_CHARS = 120;

/**
 * The token for image `i` (1-based), written by the model and replaced here.
 *
 * Numbered from one because the model reads them: "image 1" in the caption list
 * and `{{USER_IMAGE_1}}` in the markup are the same thing, and an off-by-one
 * between a description and a marker is a picture in the wrong place.
 *
 * The bare `{{USER_IMAGE}}` of the reference path is deliberately NOT part of
 * this series. They are substituted by different functions from different
 * sources, and a numbered token that could also match the unnumbered one is a
 * way for the reference image to land in a content slot.
 */
export const contentImageToken = (i: number): string => `{{USER_IMAGE_${i}}}`;

/** Matches any numbered token, including ones no image was supplied for. */
const CONTENT_TOKEN_RE = /\{\{USER_IMAGE_(\d+)\}\}/g;

export interface ContentImage extends ImageInput {
  /** 1-based, and the number in this image's token. */
  index: number;
  /**
   * What the picture shows, in the user's language.
   *
   * Empty until `captionImages` fills it. Everything downstream treats an empty
   * caption as "describe it as a photograph" rather than as an error: a caption
   * call that failed must not cost the user their image.
   */
  caption: string;
  /**
   * What the user meant by attaching it, decided from their own words.
   *
   * `content` — put this picture on the screen. Never shown to a model; the
   * caption stands in for it everywhere.
   * `reference` — copy its look. Has to be SHOWN, because a palette and a
   * layout cannot be read off a description, and that is what makes it the
   * expensive kind: it is the one image every design stage looks at.
   *
   * Defaults to `content` and stays there unless the prompt asked for a
   * reference in so many words — see the captioner's system prompt. The two
   * mistakes are not symmetrical: a reference read as content is a picture on a
   * screen, which the user can see and correct; content read as a reference is
   * a product photo deciding the palette of the whole build.
   */
  role: 'content' | 'reference';
  /**
   * True when the caption came from the person who attached the picture.
   *
   * They know what it is; a vision call can only guess, and guessing costs
   * tokens. So a described image is never sent to the captioner — and when
   * every image is described, there is no captioning call at all.
   */
  fromUser: boolean;
}

/**
 * Parse and bound what arrived.
 *
 * Two bounds, and they are different questions. The COUNT is about the prompt —
 * a caption list is text the build reads. The total SIZE is about the finished
 * document: every accepted image is embedded into it as a data URI, and the edit
 * path carries that document in a 6MB request body. `MAX_EMBEDDED_IMAGE_CHARS`
 * is the ceiling the single-image path already reasoned its way to, so it is
 * reused here as a budget across all of them rather than a second number that
 * has to be kept in step with the first.
 *
 * Images past either bound are DROPPED and reported, never truncated. Half a
 * base64 payload is a broken picture that looks like a delivered one.
 */
export function parseContentImages(raw: unknown, captions?: unknown): {
  images: ContentImage[];
  dropped: { reason: 'unusable' | 'count' | 'budget'; at: number }[];
} {
  const dropped: { reason: 'unusable' | 'count' | 'budget'; at: number }[] = [];
  if (!Array.isArray(raw)) return { images: [], dropped };

  const images: ContentImage[] = [];
  let budget = MAX_EMBEDDED_IMAGE_CHARS;
  for (let i = 0; i < raw.length; i += 1) {
    if (images.length >= MAX_CONTENT_IMAGES) {
      dropped.push({ reason: 'count', at: i });
      continue;
    }
    const parsed = parseImageInput(typeof raw[i] === 'string' ? (raw[i] as string) : null);
    if (!parsed) {
      dropped.push({ reason: 'unusable', at: i });
      continue;
    }
    // +30 for the `data:image/png;base64,` preamble each one carries in the document.
    const cost = parsed.base64.length + 30;
    if (cost > budget) {
      dropped.push({ reason: 'budget', at: i });
      continue;
    }
    budget -= cost;
    /*
     * The user's own description, when they wrote one.
     *
     * Taken by the ORIGINAL index, not the accepted one: the two diverge the
     * moment an image is dropped, and a caption that slid up a place would be
     * a true sentence about the wrong picture — which then becomes its alt
     * text. A false description is worse than none.
     */
    const given = Array.isArray(captions) && typeof captions[i] === 'string'
      ? (captions[i] as string).trim().slice(0, MAX_CAPTION_CHARS)
      : '';
    images.push({
      ...parsed,
      index: images.length + 1,
      caption: given,
      fromUser: Boolean(given),
      role: 'content',
    });
  }
  return { images, dropped };
}

/**
 * What the model is told it has, and what it must do with it.
 *
 * Deliberately blunt about the obligation. The single-image path learned this
 * the expensive way — its own comment records a request to *display* a photo
 * producing a specification that only described a visual style, because the
 * design phase and the assembler were told different things. Here the design
 * phase and the build read the same block, and it says the image must be placed.
 *
 * Returns '' for no images, so a caller can concatenate it unconditionally and a
 * request without images sends exactly the bytes it sent before.
 */
export function contentImageDirective(images: ContentImage[]): string {
  if (images.length === 0) return '';
  const list = images
    .map((im) => `  ${contentImageToken(im.index)} — ${im.caption || '写真（内容の説明は取得できませんでした）'}`)
    .join('\n');
  return (
    `\n\nTHE USER SUPPLIED ${images.length} IMAGE${images.length > 1 ? 'S' : ''} TO PUT IN THIS UI.\n` +
    'You cannot see them; each is described below. Write its marker as the src and the real\n' +
    'picture is substituted after the build:\n' +
    `  <img src="${contentImageToken(1)}" alt="…"> in HTML, src={"${contentImageToken(1)}"} in JSX.\n\n` +
    `${list}\n\n` +
    'Rules:\n' +
    '- EVERY image above must appear at least once. An image the user supplied and the UI does\n' +
    '  not show is the one thing they will notice immediately.\n' +
    '- Put each where its description says it belongs — a product photo in the product card, a\n' +
    '  logo in the header. Do not open a gallery screen to hold pictures that belong elsewhere.\n' +
    '- Style them as real photographs: object-fit: cover inside a sized, aspect-ratio box.\n' +
    '- The alt text is the description above, in the user’s language. Do not write "image".\n' +
    '- Do NOT draw a placeholder for a slot one of these fills, and do not use a stock photo\n' +
    '  where a supplied image belongs.\n' +
    '- A marker may be used more than once if the design genuinely repeats the picture.'
  );
}

/**
 * Put the real pictures in, wherever the model asked for them.
 *
 * Returns a placement count per image so the caller can log the one thing worth
 * knowing here: which supplied images never made it onto a screen. That is a
 * silent failure otherwise — the document builds, renders, and is missing the
 * picture the user chose it for.
 */
export function embedContentImages(
  html: string,
  images: ContentImage[]
): { html: string; placements: number[] } {
  let out = html;
  const placements: number[] = [];
  for (const im of images) {
    const token = contentImageToken(im.index);
    const parts = out.split(token);
    placements.push(parts.length - 1);
    out = parts.join(`data:${im.mediaType};base64,${im.base64}`);
  }
  return { html: out, placements };
}

/**
 * Remove any numbered marker still standing.
 *
 * A token that survives ships as `src="{{USER_IMAGE_3}}"` — a visibly broken
 * image. It should be impossible, since markers are only described for images
 * that were accepted, but the model can invent `{{USER_IMAGE_9}}` from the
 * pattern of the others and that is exactly the shape this catches. The single
 * image path keeps the same guard for the same reason.
 */
export function stripContentImageTokens(html: string): { html: string; stripped: number[] } {
  const stripped: number[] = [];
  const out = html.replace(CONTENT_TOKEN_RE, (_m, n: string) => {
    stripped.push(Number(n));
    return '';
  });
  return { html: out, stripped };
}

/**
 * Separate the one image to be looked at from the ones to be placed.
 *
 * At most ONE reference, and the cap is a fact about the pipeline rather than a
 * preference: `runDesignSwarm`, `invokeModel` and `invokeModelStreaming` each
 * take a single `ImageInput`, so "shown to the model" is one slot from end to
 * end. Widening it to N would mean every stage that looks at an image looks at
 * all of them — about 1,300 tokens per photo per call, across five specialists
 * and the build — which is the cost this whole file is arranged to avoid.
 *
 * So when the captioner marks several, the FIRST is kept and the rest are
 * demoted back to content. First rather than best because there is no measure of
 * best here, and a demoted image is not lost: it is still placed on the screen,
 * which is the more useful of the two jobs to get right by default.
 */
export function splitByRole(images: ContentImage[]): {
  reference: ContentImage | null;
  content: ContentImage[];
  demoted: number[];
} {
  let reference: ContentImage | null = null;
  const content: ContentImage[] = [];
  const demoted: number[] = [];
  for (const im of images) {
    if (im.role === 'reference' && !reference) {
      reference = im;
      continue;
    }
    if (im.role === 'reference') {
      demoted.push(im.index);
      content.push({ ...im, role: 'content' });
      continue;
    }
    content.push(im);
  }
  return { reference, content, demoted };
}
