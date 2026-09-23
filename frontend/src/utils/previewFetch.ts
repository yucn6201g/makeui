/**
 * Asking for the project cards' documents without tripping over each other.
 *
 * The project list draws a card per project and each card fetches its own
 * document; cards below the fold start after 1.5s whatever happens, so a long
 * list asks for all of them at once. The API runs on a Lambda account limited
 * to ten concurrent executions, and a week of metrics shows every 5xx it
 * returned was a throttle. A throttled card showed 「プレビューを生成できません
 * でした」 until the page was reloaded — when a smaller burst got through.
 *
 * So the requests queue, a few at a time, and a failure that asking again can
 * fix is asked again, with a pause. A definite answer — no document — is not.
 */

/** A failure worth retrying: a throttle, a server error, the network. */
export class TransientPreviewError extends Error {
  constructor(public readonly reason: string) {
    super(`preview fetch failed: ${reason}`);
    this.name = 'TransientPreviewError';
  }
}

/** Requests in flight at once. Below the account's ten, with room for everything else the page asks. */
export const PREVIEW_CONCURRENCY = 3;
/** Pauses before the second and third attempts. */
export const PREVIEW_RETRY_DELAYS_MS = [1200, 3500];

type Task<T> = () => Promise<T>;

/** A first-in-first-out gate letting `limit` tasks run at once. */
export function createLimiter(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  const next = () => {
    if (active >= limit) return;
    const go = waiting.shift();
    if (go) {
      active += 1;
      go();
    }
  };
  return <T>(task: Task<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      waiting.push(() => {
        task()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            next();
          });
      });
      next();
    });
}

const limit = createLimiter(PREVIEW_CONCURRENCY);

/**
 * `fetch`, queued and retried on transient failures.
 *
 * Each attempt takes its own place in the queue, so a card waiting out a
 * throttle is not holding a slot while it sleeps.
 */
export async function fetchPreviewPolitely<T>(
  fetch: () => Promise<T>,
  delays: readonly number[] = PREVIEW_RETRY_DELAYS_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  run: <R>(task: Task<R>) => Promise<R> = limit,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run(fetch);
    } catch (e) {
      if (!(e instanceof TransientPreviewError) || attempt >= delays.length) throw e;
      await sleep(delays[attempt]);
    }
  }
}
