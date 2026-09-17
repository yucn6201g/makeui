/**
 * The account name in the header, and the guess it used to make first.
 *
 * The header drew `usage?.displayName || localPartOf(userEmail)`, so from the
 * first frame it showed the local part of the sign-in address and replaced it
 * the moment `/usage` answered. For any account whose stored name is not its
 * address — which is the reason a stored name exists — that is a different name
 * flashing on every page load.
 *
 * The fallback is not wrong; it is answering the wrong question. It exists for an
 * account with NO stored name, and whether an account has one is a fact only the
 * server holds. Until it has answered there is no name to show, so the space is
 * held instead of filled with a guess.
 *
 * `!loading` cannot express that: it starts false, before anything has been
 * asked, so a caller cannot tell "nobody has asked yet" from "asked and got
 * nothing". Hence `answered`, set when the first request settles either way — a
 * failure is an answer here, because the header has waited long enough.
 *
 *   node test/account-name-flash.test.mjs      (from frontend/)
 */
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8');
const hook = fs.readFileSync(path.join(root, 'src/hooks/useUsage.ts'), 'utf8');
const menu = fs.readFileSync(path.join(root, 'src/components/UsageMenu.tsx'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/index.css'), 'utf8');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- the hook says when it has been answered --------------------------------
check('the hook reports it', /const \[answered, setAnswered\] = useState\(false\)/.test(hook), true);
check('and returns it', /return \{ usage, answered, loading, error, refresh \}/.test(hook), true);
check('set when the answer arrives', /setAnswered\(true\);\s*\n\s*\}\)/.test(hook), true);
// A failure is an answer for this purpose: the header has waited long enough and
// should fall back rather than hold a placeholder for ever.
const failure = hook.slice(hook.indexOf('.catch((err)'), hook.indexOf('.finally('));
check('and when it fails', /setAnswered\(true\)/.test(failure), true);
// It starts false, which is the whole reason `loading` could not do this job.
check('it starts unanswered', /useState\(false\)/.test(hook), true);

// --- the header no longer guesses first --------------------------------------
check('the fallback waits for the server',
  /name=\{usage\?\.displayName \|\| \(usageAnswered \? localPartOf\(userEmail\) : ''\)\}/.test(app), true);
// The defect itself, written out: the guess from the first frame.
check('and does not stand in unconditionally',
  /name=\{usage\?\.displayName \|\| localPartOf\(userEmail\)\}/.test(app), false);
check('the flag is taken from the hook', /answered: usageAnswered/.test(app), true);
// The fallback is still there — an account with no stored name is a real state
// and the server is the only thing that can report it.
check('the fallback itself survives', /localPartOf\(userEmail\)/.test(app), true);

// --- and the space is held rather than collapsed -----------------------------
// An empty string would shrink the button and shift the header beside it, which
// is a second flash in place of the first.
check('the trigger holds the space', /\{name \|\| <span className="usage-menu__name-wait"/.test(menu), true);
check('and so does the panel', (menu.match(/usage-menu__name-wait/g) ?? []).length, 2);
check('it is announced rather than silent', /aria-label="読み込み中"/.test(menu), true);
const wait = css.slice(css.indexOf('\n.usage-menu__name-wait {'), css.indexOf('}', css.indexOf('\n.usage-menu__name-wait {')));
check('the placeholder has a width to hold', /width:\s*\d+px/.test(wait), true);
check('and a height', /height:/.test(wait), true);
// Not a spinner: it is one word arriving in a few hundred milliseconds, and a
// spinner on it would be louder than the thing it stands for.
check('but no animation', /animation/.test(wait), false);

// --- the two halves of the rule still agree ----------------------------------
// `localPartOf` is a second copy of half a rule the server owns; the backend test
// holds them together and this only checks the copy is still the fallback half.
check('the client never derives a name the server has',
  /usage\?\.displayName \|\|/.test(app), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
