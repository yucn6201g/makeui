import { parseImageInput, type ImageInput } from '../utils/image-input.js'
import {
  parseContentImages,
  splitByRole,
  contentImageDirective,
  MAX_CAPTION_CHARS,
  type ContentImage,
} from '../utils/content-images.js'
import { captionImages } from './image-captions.js'
import { logger } from '../utils/logger.js'

/**
 * The pictures attached to a request, made ready for a pipeline that is not the
 * build.
 *
 * Generation has done this inline since content images existed: parse the list,
 * caption what the user did not describe, let the prompt promote one to the
 * reference slot, and describe the rest for placement. Planning and editing took
 * the same `images` field and did none of it. Measured on 2026-09-14, reading the
 * code rather than a run: a plan declared `images` and never read it, and an edit
 * was sent only the first picture while the composer cleared the rest — so a
 * second or third photograph attached in either mode vanished without a word.
 *
 * Same steps, same order, same defaults as `runGeneration`, so a picture means
 * the same thing whichever button sent it. The build keeps its inline copy
 * because its tests pin that code; this is the copy the other two read.
 */
export interface SuppliedImages {
  /** The picture every stage looks at: the request's `image`, or the one the prompt promoted. */
  reference: ImageInput | null
  /** What the user said the reference shows, or the caption it was given. Empty when neither. */
  referenceCaption: string
  /** Pictures to place in the UI by marker, never shown to a model. */
  placeable: ContentImage[]
  /** The block that tells the model what it has to place. Empty when nothing. */
  contentContext: string
}

/**
 * The description of a lone attached picture.
 *
 * The composer shows a description box beside the first picture whether or not
 * there are others, and sent the text only with a list. A single picture's
 * description was typed and dropped. When there is no list, the first caption
 * belongs to `image`.
 */
export function singleImageCaption(images: unknown, captions: unknown): string {
  if (Array.isArray(images) && images.length > 0) return ''
  const first = Array.isArray(captions) && typeof captions[0] === 'string' ? captions[0] : ''
  return first.trim().slice(0, MAX_CAPTION_CHARS)
}

export async function prepareSuppliedImages(input: {
  image?: string | null
  images?: unknown
  imageCaptions?: unknown
  /** The request in the user's words, which decides what each picture is for. */
  prompt: string
  /** A vision call: system prompt, content blocks, max tokens. The caller owns model and ledger stage. */
  invoke: (system: string, content: Array<Record<string, unknown>>, maxTokens: number) => Promise<string>
  /** Called before the captioning call, so the caller can show a step. */
  onCaptioning?: () => void
  /** Carried into the log lines. */
  context?: Record<string, unknown>
}): Promise<SuppliedImages> {
  let reference = parseImageInput(input.image ?? null)
  let referenceCaption = reference ? singleImageCaption(input.images, input.imageCaptions) : ''
  const { images, dropped } = parseContentImages(input.images, input.imageCaptions)
  if (dropped.length > 0) {
    logger.info('Some supplied images were not accepted', {
      ...input.context,
      accepted: images.length,
      dropped: dropped.map((d) => `${d.at}:${d.reason}`),
    })
  }
  if (images.length === 0) return { reference, referenceCaption, placeable: [], contentContext: '' }

  input.onCaptioning?.()
  await captionImages(images, input.prompt, input.invoke)
  const split = splitByRole(images)
  let placeable = images
  // An explicit `image` wins over a promotion, exactly as in the build.
  if (split.reference && !reference) {
    reference = split.reference
    referenceCaption = split.reference.caption
    placeable = split.content
    logger.info('An attached image is being used as the design reference', {
      ...input.context,
      index: split.reference.index,
      placing: placeable.length,
    })
  }
  return { reference, referenceCaption, placeable, contentContext: contentImageDirective(placeable) }
}
