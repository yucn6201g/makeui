/**
 * Posting a job request, with the two failures the generate and edit paths share.
 *
 * Both send the same shape of thing — a JSON body that can carry a whole document
 * and a reference image — and both used to surface the same unhelpful string when
 * it went wrong. `Failed to fetch` is what the browser reports for *any* request
 * that never completed: a body too large to upload, a dropped connection, a proxy
 * closing the socket. It names the API, not the problem, and the user cannot act
 * on it.
 *
 * So the size is checked here, where it is known, and a network-level failure is
 * retried once. An HTTP error is not retried: the server saw the request and
 * rejected it, and asking again only doubles the wait before the same message.
 */

/**
 * Largest request body either path will attempt to upload.
 *
 * API Gateway accepts 10MB. The margin is for the request that is *almost* fine:
 * a React project plus a 5MB photo lands near enough to the ceiling that a retry
 * on a slower connection is the thing that finally fails.
 */
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

/** Thrown when the body is refused before any request is made. */
export class PayloadTooLargeError extends Error {
  constructor(public readonly bytes: number, public readonly hasImage: boolean) {
    const mb = (bytes / 1024 / 1024).toFixed(1);
    super(
      `送信サイズが大きすぎます（${mb}MB）。` +
        (hasImage
          ? '添付画像を外すか、より小さい画像でお試しください。'
          : 'ドキュメントが大きいため、変更範囲を絞ってお試しください。')
    );
    this.name = 'PayloadTooLargeError';
  }
}

/**
 * `fetch` rejects with a TypeError for anything that stopped the request from
 * completing. None of those say the request was wrong, and all are worth one
 * more attempt.
 */
export function isTransientNetworkError(err: unknown): boolean {
  return err instanceof TypeError;
}

/**
 * Whether a message was written for a person to read.
 *
 * Everything this product says to a reader is in Japanese; the strings thrown by
 * `fetch`, by the JSON parser, and by the AWS SDKs behind the API are not. The
 * same rule decides this on the server, in `describeFailure` — the two are
 * deliberately the same rule, because the string can arrive from either side and
 * the chat renders it the same way.
 */
const WRITTEN_FOR_A_READER = /[぀-ヿ㐀-鿿]/;

/**
 * The message to show the user for a failed request.
 *
 * The last line used to be `err.message || fallback`, which showed whatever the
 * exception carried. `isTransientNetworkError` catches the common one — a
 * TypeError from `fetch` — but anything else arrived verbatim: a JSON parse
 * error naming a character offset, or an SDK exception that names a service the
 * user has never heard of. Those are now replaced by the caller's fallback,
 * which at least says which action failed.
 */
export function requestErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof PayloadTooLargeError) return err.message;
  if (isTransientNetworkError(err)) {
    return '通信に失敗しました。接続を確認して、もう一度お試しください。';
  }
  const message = err instanceof Error ? err.message.trim() : '';
  return WRITTEN_FOR_A_READER.test(message) ? message : fallback;
}

export interface PostJsonOptions {
  url: string;
  token: string;
  body: Record<string, unknown>;
  signal: AbortSignal;
  /** Whether the body carries an image, so the size message can say so. */
  hasImage?: boolean;
}

/**
 * POST a JSON body, refusing an oversized one up front and retrying once on a
 * network-level failure. Resolves with the parsed JSON, or rejects with an Error
 * whose message is already fit to show.
 */
export async function postJson<T>({ url, token, body, signal, hasImage }: PostJsonOptions): Promise<T> {
  const payload = JSON.stringify(body);
  const bytes = new Blob([payload]).size;
  if (bytes > MAX_REQUEST_BYTES) throw new PayloadTooLargeError(bytes, Boolean(hasImage));

  const send = (attempt: number): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: payload,
      signal,
    }).catch((err) => {
      if (attempt === 0 && isTransientNetworkError(err) && !signal.aborted) {
        return new Promise<Response>((resolve, reject) => {
          setTimeout(() => send(1).then(resolve, reject), 1200);
        });
      }
      throw err;
    });

  const response = await send(0);
  if (!response.ok) {
    const errBody = (await response.json().catch(() => ({}))) as Record<string, string>;
    throw new Error(errBody.error || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}
