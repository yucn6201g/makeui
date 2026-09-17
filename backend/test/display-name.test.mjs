// A name for every account, including the ones that never had one.
//
// Sign-in is unchanged: the Cognito username is the email address and the login
// form still sends it. What changed is what the app CALLS people. Existing
// accounts have no stored name and are to be shown by the part of their address
// before the `@`, which is done as a rule on read rather than as a backfill —
// see src/services/display-name.ts for why.
//
// The rule exists in two places: the server, which is authoritative, and the
// composer, which needs something to draw in the moment before /usage answers.
// Two copies of a rule is the arrangement this repository has been burned by, so
// the last section reads both files and checks they derive the local part the
// same way.
//
//   node test/display-name.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/services/display-name.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/dn.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'pipe', cwd: root }
);
const { displayNameFor, isValidDisplayName, DISPLAY_NAME_MAX } = await import(
  pathToFileURL(path.join(root, 'dist/dn.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- the rule -----------------------------------------------------------------
check('a stored name wins', displayNameFor('taro@example.com', '山田 太郎'), '山田 太郎');
check('no stored name falls back to the local part', displayNameFor('taro@example.com'), 'taro');
check('an empty stored name is the same as none', displayNameFor('taro@example.com', ''), 'taro');
/*
 * Whitespace is the case that decides whether this is a rule or a coincidence.
 * `'   '` is truthy, so a plain `name || local` would show a blank name — the
 * account would appear to have no name at all, and nobody would know why.
 */
check('a whitespace-only name is the same as none', displayNameFor('taro@example.com', '   '), 'taro');
check('and a stored name is trimmed', displayNameFor('taro@example.com', '  太郎  '), '太郎');

// A `+` tag is part of the local part and is kept: it is a real distinction
// between two addresses, and dropping it would give two accounts one name.
check('a plus tag stays', displayNameFor('taro+work@example.com'), 'taro+work');
// Only the first `@` separates. The rest is the domain, however odd.
check('only the first @ separates', displayNameFor('a@b@example.com'), 'a');

/*
 * The last resort is the address, not an empty string. A row with no name at all
 * reads as a rendering bug and somebody goes looking for one; an address is at
 * least an answer to "who is this".
 */
check('an address with no local part falls through to itself', displayNameFor('@example.com'), '@example.com');
check('and nothing at all is empty rather than a crash', displayNameFor(''), '');
check('an undefined address does not throw', displayNameFor(undefined), '');

// --- what an administrator may type -------------------------------------------
check('a name is required', isValidDisplayName(''), false);
/*
 * Rejected rather than trimmed-and-accepted. `'   '` and `''` both mean the
 * account falls back to its address, and an admin who typed spaces did not ask
 * for that — a form that quietly did nothing is worse than one that says no.
 */
check('spaces alone are not a name', isValidDisplayName('   '), false);
check('a name is a string', isValidDisplayName(42), false);
check('and undefined is not one', isValidDisplayName(undefined), false);
check('an ordinary name is fine', isValidDisplayName('山田 太郎'), true);
check(`${DISPLAY_NAME_MAX} characters is the ceiling`, isValidDisplayName('あ'.repeat(DISPLAY_NAME_MAX)), true);
check('and one more is not', isValidDisplayName('あ'.repeat(DISPLAY_NAME_MAX + 1)), false);
// Length is measured after trimming, so trailing spaces cannot push a valid
// name over the edge.
check('the ceiling is measured after trimming',
  isValidDisplayName(` ${'あ'.repeat(DISPLAY_NAME_MAX)} `), true);

// --- the composer's copy of the fallback --------------------------------------
//
// It draws something before /usage answers, and the alternative is a blank space
// where the account name goes on every page load. It only ever produces the
// FALLBACK half — a stored name is never guessed there — so the two can disagree
// only about an account that has none, which is exactly the case checked here.
{
  const client = fs.readFileSync(
    path.resolve(root, '..', 'frontend', 'src/utils/displayName.ts'), 'utf8'
  );
  check('the composer helper exists', /export function localPartOf/.test(client), true);

  /*
   * The real function, bundled — not a copy of it written here. Restating the
   * implementation inside the test makes it agree with itself: it would pass
   * with the composer's own helper deleted, which is the one thing it exists to
   * notice.
   */
  execSync(
    `npx esbuild "${path.resolve(root, '..', 'frontend', 'src/utils/displayName.ts')}" ` +
      `--bundle --platform=node --format=esm --outfile="${path.join(root, 'dist/dn-client.test.mjs')}"`,
    { stdio: 'pipe', cwd: root }
  );
  const { localPartOf } = await import(pathToFileURL(path.join(root, 'dist/dn-client.test.mjs')).href);

  // The behaviour, not the text: what matters is that both answer the same for
  // an account with no stored name.
  for (const email of [
    'taro@example.com', 'taro+work@example.com', 'a@b@example.com',
    '@example.com', '  spaced@example.com  ', '',
  ]) {
    check(`both derive the same name for ${JSON.stringify(email)}`,
      localPartOf(email), displayNameFor(email.trim()));
  }

  // And the copy really is only the fallback — if it ever learns about stored
  // names, the two rules can diverge where it matters.
  check('the composer copy takes no stored name', /localPartOf\(email: string \| null \| undefined\)/.test(client), true);
}

// --- and sign-in is untouched --------------------------------------------------
//
// The point of using `name` rather than `preferred_username`: the latter is a
// Cognito alias, so it would have to be unique and could be used to sign in.
// Neither was asked for, and the second changes what a login is.
{
  const handler = fs.readFileSync(path.join(root, 'src/handlers/lambda-handler.ts'), 'utf8');
  const create = handler.slice(handler.indexOf('new AdminCreateUserCommand'), handler.indexOf('MessageAction'));
  check('the account is still created under the email', /Username: input\.email/.test(create), true);
  check('the name is a plain attribute', /\{ Name: 'name', Value: input\.displayName\.trim\(\) \}/.test(create), true);
  check('and preferred_username is not used anywhere',
    /preferred_username/.test(handler), false);
}

// --- the directory listing, and the failure that hid itself --------------------
//
// `AttributesToGet: ['sub','email','name']` is rejected by this pool —
// `InvalidParameterException`, for that list and for `['name']` alone, while
// `['sub','email']` is accepted. It shipped, and nothing said so: the call sits
// in a try/catch that logged a warning and returned an EMPTY map, and an empty
// map was indistinguishable from a directory that is genuinely empty. So the
// usage panel lost every email and rendered 「—」, and the filter that hides rows
// belonging to no live account switched itself off and let three synthetic probe
// users in. One bad parameter, two visible symptoms, warnings nobody was
// reading, and a green deploy.
{
  const usage = fs.readFileSync(path.join(root, 'src/services/token-usage.ts'), 'utf8');
  const listing = usage.slice(
    usage.indexOf('async function getCognitoEmailMap'),
    usage.indexOf('export async function getAllUsersUsage')
  );
  check('the directory listing was found', listing.length > 0, true);

  /*
   * Comments stripped, because the reason this parameter is absent is written
   * inside the function and names it. Matching the prose instead of the code
   * failed this check on the fix that removed the parameter — a test that reads
   * source has to read it the way the compiler does.
   */
  const code = listing
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');

  /*
   * No AttributesToGet at all. Narrowing it is the optimisation that broke this,
   * and /admin/users has always listed the same directory without one.
   */
  check('the listing does not narrow the attributes it asks for',
    code.includes('AttributesToGet'), false);

  // A failure has to be tellable from an empty directory, which is the whole
  // reason the bug was silent.
  const flat = listing.replace(/\s+/g, ' ');
  check('a failed lookup returns null rather than an empty map',
    flat.includes("logger.warn('Failed to fetch Cognito users', { error: String(error) }); return null;"), true);
  check('and the return type says so',
    flat.includes('Promise<Map<string, { email: string; displayName: string }> | null>'), true);

  // And the caller tells them apart: null means do not filter; an empty map
  // means every row is an orphan and all of them are hidden.
  const all = usage.slice(usage.indexOf('export async function getAllUsersUsage')).replace(/\s+/g, ' ');
  check('the filter is skipped only when the lookup failed',
    all.includes('const known = emailMap !== null;'), true);
  /*
   * `owned`, not `rows`: a period can span months, so the filtered items are
   * merged into one row per account afterwards and the two stopped being the
   * same list. The filter itself is unchanged and is what this asserts.
   */
  check('and an empty directory still filters',
    all.includes('const owned = emailMap ? allItems.filter'), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
