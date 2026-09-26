/**
 * The API's request limits, restated so the composer can say no before sending.
 *
 * `backend/src/handlers/lambda-handler.ts` is the authority — `MAX_PROMPT_LENGTH`
 * and `MAX_IMAGE_SIZE` — and `backend/test/client-limits.test.mjs` holds these
 * equal to it. Without them a 2,001-character brief or a 6MB photo was sent,
 * refused with an English 400 (`prompt must be 2000 characters or fewer`), and
 * the user met the limit only after waiting for the upload.
 */
export const MAX_PROMPT_CHARS = 2000;

/** One picture, decoded. The API estimates this from the base64 length, which is the file's size. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Why this brief cannot be sent, or null. */
export function promptProblem(text: string): string | null {
  if (text.length <= MAX_PROMPT_CHARS) return null;
  return `依頼文は${MAX_PROMPT_CHARS.toLocaleString()}文字までです（現在${text.length.toLocaleString()}文字）。`;
}

/** The pictures in a selection that are too large to send. */
export function oversizedImages<T extends { size: number }>(files: T[]): T[] {
  return files.filter((f) => f.size > MAX_IMAGE_BYTES);
}
