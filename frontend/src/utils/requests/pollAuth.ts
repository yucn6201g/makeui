import { getIdToken } from '../../auth/cognito';

/**
 * The bearer for one poll of a running job, and what to do when it is refused.
 *
 * A generation is a server-side job the browser polls every two seconds for up
 * to thirty minutes. The ID token is valid for one hour. Both of those were
 * known; what sat between them was not:
 *
 *  - the token the poll sent was a ref, updated by an effect when the auth
 *    context changed, and the context changed on a 15-minute `setInterval` or
 *    on window focus. A background tab has its timers throttled — and a laptop
 *    that sleeps has them stopped — so "15 minutes" is a promise the browser
 *    does not make. The refresh is the one thing that must not depend on the
 *    tab being awake.
 *  - and when the poll was refused, ANY 4xx except 429 was treated as final:
 *    the message said to log in again and `isGenerating` went false. The job
 *    kept running on the server and finished; the browser had stopped looking.
 *
 * So the token is read at request time rather than captured — `getSession()`
 * exchanges the 7-day refresh token whenever the ID token has expired, which is
 * exactly the case a stale ref cannot notice — and a refusal is retried a few
 * times before it is believed.
 */

/**
 * How many consecutive refusals a run survives.
 *
 * Three, at the doubled poll interval, is about twelve seconds of grace. The
 * case it has to cover is a machine waking up: the refresh needs one round trip
 * to Cognito, and the poll that fires first will be refused while it is in
 * flight. It is deliberately not large — a session that is genuinely gone should
 * say so rather than spin.
 */
export const AUTH_RETRY_BUDGET = 3;

/**
 * A fresh token, or the one we already had.
 *
 * Never throws. A `getSession()` that fails is usually the network rather than
 * the session, and the captured token may well still be valid — refusing to
 * poll at that moment would abandon a running job over a blip. If the token
 * really is dead the request comes back 401 and the retry budget decides.
 */
export async function pollAuthToken(fallback: string | null): Promise<string> {
  try {
    return await getIdToken();
  } catch {
    return fallback ?? '';
  }
}

/**
 * Whether a refused poll is worth another try.
 *
 * 401 and 403 are the ones a refresh can fix. Every other 4xx is a statement
 * about the request rather than the caller — a job id that does not exist does
 * not start existing — and 429 was already retried as transient.
 */
export const isAuthRefusal = (status?: number): boolean => status === 401 || status === 403;
