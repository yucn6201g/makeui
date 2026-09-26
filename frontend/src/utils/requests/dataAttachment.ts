export interface AttachedData {
  name: string;
  content: string;
  /**
   * Pages, when the content was read out of a PDF.
   *
   * Carried only so the chip can say `2ページ · 295文字`. That pairing is the
   * whole guard against a PDF made of scanned images: it extracts to almost
   * nothing, and a character count next to a page count makes that obvious
   * before a generation is spent on it.
   */
  pages?: number;
}

/**
 * What may be attached.
 *
 * Text formats, plus PDF — which is read in the browser and sent as the text it
 * yielded, never as bytes. An image has its own field and its own route, and a
 * binary body reaching the build would be read as text and distilled into
 * nonsense that looks like data.
 */
export const ATTACHMENT_ACCEPT = '.csv,.tsv,.json,.md,.markdown,.txt,.pdf';

/** Reference images: looked at, not read. */
const IMAGE_ACCEPT = '.png,.jpg,.jpeg,.gif,.webp';

/**
 * Everything the composer's one paperclip takes.
 *
 * There used to be two buttons, because the two attachments mean different
 * things downstream and still do: an image is a reference the design phase
 * looks at, a data file is what the screens are populated from. But that is a
 * distinction the pipeline needs, not one the person attaching a file should
 * have to make — and getting it wrong meant a silently ignored file next to a
 * button that would have accepted it.
 *
 * One control, and the extension decides the route.
 */
export const ANY_ATTACHMENT_ACCEPT = `${IMAGE_ACCEPT},${ATTACHMENT_ACCEPT}`;

/** Whether this file belongs in the image slot rather than the data one. */
export function isImageAttachment(name: string): boolean {
  return /\.(png|jpe?g|gif|webp)$/i.test(name);
}

/**
 * The largest file to send. Mirrors `MAX_ATTACHMENT_CHARS` in
 * backend/src/utils/data-attachment.ts, which is the authority — this copy
 * exists so the user is told before the upload rather than by a 400 after it.
 *
 * It is a limit on what travels, not on what the model reads: the job distils
 * the file to a few thousand characters before any prompt sees it. So a large
 * CSV costs nothing extra, and this bound is about the request payload alone.
 */
export const MAX_ATTACHMENT_CHARS = 512_000;

/**
 * A PDF is bytes, and only its text is sent — so the file itself may be larger
 * than what the payload will carry. Measured: a two-page Japanese guideline is
 * 40KB of PDF and 295 characters of text.
 */
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

export function isPdf(name: string): boolean {
  return /\.pdf$/i.test(name);
}

/** Returns the reason the file cannot be attached, or null when it can. */
export function attachmentProblem(name: string, size: number): string | null {
  if (!/\.(csv|tsv|json|md|markdown|txt|pdf)$/i.test(name)) {
    return 'CSV・JSON・Markdown・テキスト・PDF ファイルを添付してください。';
  }
  if (isPdf(name)) {
    // Bounded by bytes because a PDF is never sent as bytes: what travels is
    // the text it yields, which is a different and much smaller quantity.
    if (size > MAX_PDF_BYTES) {
      return `PDF が大きすぎます（${Math.round(MAX_PDF_BYTES / 1024 / 1024)}MB まで）。`;
    }
    return null;
  }
  // Bytes, not characters — the real count needs the decoded text, and a
  // multi-byte file that passes here is caught by the check after reading.
  if (size > MAX_ATTACHMENT_CHARS) {
    return `ファイルが大きすぎます（${Math.round(MAX_ATTACHMENT_CHARS / 1000)}KB まで）。`;
  }
  return null;
}

interface PdfExtract {
  pages: number;
  text: string;
  /** Why the result is unusable, or null. */
  problem: string | null;
}

/**
 * Text out of a PDF, in the browser.
 *
 * Client-side deliberately: the extracted text then rides the attachment path
 * that already exists, so the API, the payload and the distillation are byte
 * for byte what they were — and the backend never has to grow a PDF parser or
 * decide what a corrupt one means.
 *
 * The library is a dynamic import, so the 2.3MB it costs is paid only by
 * someone who actually attaches a PDF.
 *
 * A PDF made of scanned pages or exported artboards has no text layer and comes
 * back empty. That is refused rather than attached, because an empty attachment
 * is indistinguishable from no attachment right up until the generation comes
 * back having ignored it.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<PdfExtract> {
  let pages = 0;
  let text = '';
  try {
    const { getDocumentProxy, extractText } = await import('unpdf');
    const doc = await getDocumentProxy(bytes);
    const out = await extractText(doc, { mergePages: true });
    pages = out.totalPages ?? 0;
    text = String(out.text ?? '').trim();
  } catch (e) {
    return { pages: 0, text: '', problem: `PDF を読み取れませんでした（${String(e).slice(0, 80)}）` };
  }

  if (text.length < 20) {
    return {
      pages,
      text,
      problem:
        'この PDF からテキストを取り出せませんでした。画像として書き出された PDF の可能性があります。' +
        'テキストをコピーして .txt か .md で添付してください。',
    };
  }
  if (text.length > MAX_ATTACHMENT_CHARS) {
    text = text.slice(0, MAX_ATTACHMENT_CHARS);
  }
  return { pages, text, problem: null };
}

/**
 * What the chip says about a file that is already attached.
 *
 * The record count is the point of showing anything at all. It is what the
 * design phase is told, and it is the number that decides whether the screen
 * gets pagination and search — so a user who attached the wrong export can see
 * that before spending a generation on it, rather than afterwards.
 */
export function describeAttachment(file: AttachedData): string {
  const ext = file.name.toLowerCase().replace(/^.*\./, '');
  const content = file.content.replace(/^﻿/, '').trim();

  // Pages beside characters, because that pairing is what tells a scanned PDF
  // from a real one at a glance: 40 pages and 60 characters is a picture book.
  if (ext === 'pdf') {
    const chars = `${content.length.toLocaleString()}文字`;
    return file.pages ? `${file.pages}ページ · ${chars}` : chars;
  }

  if (ext === 'csv' || ext === 'tsv') {
    // Rows, not lines: a quoted field can contain newlines, and counting those
    // as records is how a 300-row export is announced as 900.
    let rows = 0, quoted = false, seen = false;
    for (let i = 0; i < content.length; i++) {
      const c = content[i];
      if (c === '"') { if (quoted && content[i + 1] === '"') { i++; continue; } quoted = !quoted; continue; }
      if (!quoted && (c === '\n' || c === '\r')) {
        if (c === '\r' && content[i + 1] === '\n') i++;
        if (seen) rows++;
        seen = false;
        continue;
      }
      if (c.trim()) seen = true;
    }
    if (seen) rows++;
    // The header is not a record.
    return `${Math.max(0, rows - 1).toLocaleString()}行`;
  }

  if (ext === 'json') {
    try {
      const parsed = JSON.parse(content);
      const array = Array.isArray(parsed)
        ? parsed
        : (Object.values(parsed as Record<string, unknown>).find(Array.isArray) as unknown[] | undefined);
      if (array) return `${array.length.toLocaleString()}件`;
      return 'JSON';
    } catch {
      // Still sent — the build reads an unparsable .json as text rather than
      // dropping it — so the chip says what will happen, not that it failed.
      // Kept as short as the counts beside it: measured at a 220px chat pane, a
      // longer label took the whole chip and left the filename zero pixels wide.
      return 'テキスト';
    }
  }

  return `${content.length.toLocaleString()}文字`;
}
