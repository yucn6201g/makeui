/**
 * Which of the attached pictures is a reference and which go into the UI.
 *
 * The backend reads the two differently and the difference is the whole cost
 * argument for the feature. `image` is the one attachment the design phase and
 * the build actually LOOK at — vision tokens on every stage that sees it — which
 * is what "take the layout and palette from this" requires. `images` are content:
 * each is described once and placed by marker, so five of them cost one call
 * rather than one per stage.
 *
 * The rule below decides which a person meant, and it is here rather than inline
 * in the composer because it is the part that is easy to get subtly wrong and
 * impossible to see afterwards — a request sends one field or the other and the
 * finished UI is the only report.
 */

interface UiImagePayload {
  /** The reference attachment, when exactly one picture was attached. */
  image?: string;
  /**
   * Several pictures, whose roles the backend decides from the prompt: any one
   * of them may become the reference, the rest are placed in the UI.
   */
  images?: string[];
}

/**
 * One picture keeps the behaviour it has always had: it goes in the reference
 * slot and the model decides from the request whether to copy it or show it.
 *
 * Two or more go as a list, and the ROLES ARE STILL DECIDED BY THE PROMPT — the
 * backend's captioner reads the request alongside the pictures and may promote
 * one of them to the reference slot. This is not the composer giving up on the
 * distinction; it is the composer declining to guess it from attachment order.
 *
 * Which is the point: the person who attaches four product photos and one mood
 * board should not have to attach the mood board first. They say which is which
 * in the words they were already writing.
 *
 * Returns the fields to send, with the absent one omitted rather than set to
 * undefined, so a request that attaches nothing is byte-identical to what it was
 * before any of this existed.
 */
export function uiImagesForSend(
  image: string | null,
  extraImages: string[]
): UiImagePayload {
  const extras = extraImages.filter(Boolean);
  if (extras.length === 0) return image ? { image } : {};
  return { images: image ? [image, ...extras] : extras };
}

/**
 * The descriptions to send beside what `uiImagesForSend` chose.
 *
 * Aligned with `images` by index when there is a list. When there is only the
 * single picture, its description is sent alone — the composer shows the box
 * beside a lone picture too, and it used to be typed and then dropped, because
 * only a list carried descriptions. Omitted when nothing was written, so a
 * request without descriptions is byte-identical to what it was.
 */
export function captionsForSend(picked: UiImagePayload, notes: string[]): string[] | undefined {
  if (picked.images) {
    const aligned = picked.images.map((_v, i) => notes[i] ?? '');
    return aligned.some((n) => n.trim()) ? aligned : undefined;
  }
  if (picked.image && (notes[0] ?? '').trim()) return [notes[0]];
  return undefined;
}

/**
 * How many more the composer will take.
 *
 * The backend's `MAX_CONTENT_IMAGES`, restated because the two packages share no
 * code. Refusing here is the difference between "you can attach eight" and a
 * silent loss the user only meets in the finished UI: the backend drops the
 * ninth and records it in a log nobody reads.
 */
export const MAX_UI_IMAGES = 8;

export function roomForImages(image: string | null, extraImages: string[]): number {
  return Math.max(0, MAX_UI_IMAGES - ((image ? 1 : 0) + extraImages.length));
}
