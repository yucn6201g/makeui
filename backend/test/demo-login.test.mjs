// `demo-login` asks for demo credentials on a login screen, because a reviewer
// who cannot get past the gate cannot see any of the other screens.
//
// The gate test read the document for `type="password"` anywhere, and in all 75
// of the corpus documents that raised the finding the match was a selector:
//
//     input[type="text"], input[type="email"], input[type="password"],
//     select, textarea { font-family: inherit; … }
//
// Every generated project writes that rule. Not one of the 75 had a login,
// signin or auth screen file at all — so a sales dashboard was told to put demo
// credentials on a login screen that does not exist, and a repair pass went
// after it. Eight corpus documents have a real password input; all eight
// already carry the credentials.
//
//   node test/demo-login.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { completeProject, documentOf } from './fixtures/complete-project.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/orchestration/audit/interaction-audit.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/dl.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'pipe', cwd: root }
);
const { auditInteractivity } = await import(pathToFileURL(path.join(root, 'dist/dl.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${got}\n      want ${want}`);
  ok ? pass++ : fail++;
};

const fence = (p, body) => `@@@makeui:file ${p}\n${body}\n@@@makeui:endfile\n`;
const doc = (...blocks) => `<!DOCTYPE html><html><body><div id="root"></div>\n${blocks.join('')}</body></html>`;
const raised = (...blocks) =>
  auditInteractivity(doc(...blocks), 'react').some((d) => d.id === 'demo-login');

// The rule every generated project writes. It is not a gate.
const FORM_CSS = fence('src/styles/globals.css',
  'input[type="text"], input[type="email"], input[type="password"], select, textarea {\n' +
  '  font-family: inherit;\n  min-height: 44px;\n}');
const DASHBOARD = fence('src/screens/DashboardScreen.tsx',
  'export default function DashboardScreen() { return <main><h1>売上分析</h1></main>; }');

check('a stylesheet selector is not a login gate', raised(FORM_CSS, DASHBOARD), false);

// The element is. Without credentials on screen the reviewer is locked out.
const LOGIN = fence('src/screens/LoginScreen.tsx',
  'export default function LoginScreen() {\n' +
  '  return <form><input type="email" /><input type="password" /><button>ログイン</button></form>;\n}');
check('a password input with no credentials is reported', raised(FORM_CSS, LOGIN), true);

// A constant alone is not enough — it satisfies the mock's own auth check and
// still leaves the reviewer locked out. Both halves have to be on screen.
const CREDS = fence('src/data/demoAccount.ts',
  "export const DEMO_ACCOUNT = { email: 'demo@example.com', password: 'demo1234' };");
check('the constant alone does not clear it', raised(FORM_CSS, LOGIN, CREDS), true);
const VISIBLE = fence('src/screens/LoginScreen.tsx',
  'import { DEMO_ACCOUNT } from "../data/demoAccount";\n' +
  'export default function LoginScreen() {\n' +
  '  return <form><input type="password" />\n' +
  '    <aside><h2>デモアカウント</h2><p>{DEMO_ACCOUNT.email}</p></aside></form>;\n}');
check('shown on screen, it clears', raised(FORM_CSS, VISIBLE, CREDS), false);

// A framework binding for the show/hide toggle is still a password field.
const TOGGLE = fence('src/screens/LoginScreen.tsx',
  'export default function LoginScreen() {\n' +
  '  return <input type={show ? "text" : "password"} />;\n}');
check('a toggled password field counts', raised(FORM_CSS, TOGGLE), true);

// The scorer kept its own copy of the same rule, and the copy was the version
// the audit was fixed for: 35 corpus documents were losing 12 points for a
// stylesheet, none of them with a password input anywhere. Two copies of one
// rule is how the audit came to be right and the score wrong about the same
// document, so they share the predicate now — this asserts they still do.
execSync(
  `npx esbuild "${path.join(root, 'src/orchestration/audit/scoring.ts')}" --bundle --platform=node --format=esm ` +
    `--loader:.txt=text --outfile="${path.join(root, 'dist/gl.test.mjs')}" ` +
    `--external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'pipe', cwd: root }
);
const { scoreHtml } = await import(pathToFileURL(path.join(root, 'dist/gl.test.mjs')).href);
/*
 * The shared project fixture, plus the stylesheet whose selector is the point.
 *
 * This was a hand-written list with the note 「Rich enough to sit above the
 * floor」 above it, and when the rubric changed it stopped being rich enough:
 * both sides of the comparison below became 30 and the assertion could no
 * longer fail. One fixture, kept in one place.
 */
const RICH = documentOf(completeProject(), FORM_CSS);

check('the scorer does not penalise a stylesheet selector',
  scoreHtml(RICH, undefined, 'react') >
    scoreHtml(documentOf(completeProject(), FORM_CSS + LOGIN), undefined, 'react'),
  true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
