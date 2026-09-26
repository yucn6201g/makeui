/**
 * The name to show before the server has said what it is.
 *
 * The real answer comes from `/usage`, which resolves it from the directory —
 * see backend/src/services/display-name.ts. This exists only for the moment
 * before that lands, because the alternative is a blank space where the account
 * name goes on every page load.
 *
 * It is a second copy of half a rule, which is the arrangement this repository
 * has been burned by. Two things keep it honest:
 *
 *   - it is only the FALLBACK half. A stored name is never guessed here; when
 *     the server has one, its answer replaces this. So the two can only disagree
 *     about an account with no stored name, where both say the same thing.
 *   - `backend/test/display-name.test.mjs` reads both files and checks the local
 *     part is derived the same way.
 */
export function localPartOf(email: string | null | undefined): string {
  const address = (email ?? '').trim();
  if (!address) return '';
  return address.split('@')[0].trim() || address;
}
