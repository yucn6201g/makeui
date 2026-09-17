/**
 * Force credential fields to half-width ASCII.
 *
 * With a Japanese IME active, typing an address or a one-time code produces
 * full-width characters that look almost identical on screen — ａ against a, ７
 * against 7. Cognito compares bytes, so the sign-in simply fails and the user is
 * left rereading a field that looks correct. Converting as they type is better
 * than validating afterwards: there is nothing to explain if it cannot happen.
 *
 * Full-width ASCII occupies U+FF01–U+FF5E, in the same order as U+0021–U+007E, so
 * the conversion is a fixed offset. The ideographic space is a separate codepoint
 * and maps to a normal space, which is then dropped along with everything else
 * outside printable ASCII — no credential field has a legitimate use for it.
 */

const FULLWIDTH_OFFSET = 0xfee0;

export function toHalfWidth(value: string): string {
  return value
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - FULLWIDTH_OFFSET))
    .replace(/　/g, ' ')
    // Anything still outside printable ASCII — kana, kanji, emoji — cannot be part
    // of an email, password or TOTP code here, and silently dropping it is clearer
    // than letting it through to a rejection from the server.
    .replace(/[^\x20-\x7E]/g, '');
}

/** Length of a TOTP code. */
const OTP_LENGTH = 6;

/**
 * Half-width digits only, capped at the code's length.
 *
 * The cap is enforced here rather than left to the input's `maxlength`, which
 * only governs typing and paste — an autofill or a password manager writing the
 * value directly bypasses it, and Cognito rejects an over-long code with a
 * generic failure that gives the user nothing to act on.
 */
export function toDigits(value: string): string {
  return toHalfWidth(value).replace(/\D/g, '').slice(0, OTP_LENGTH);
}
