// The router and its callers disagreeing about what a route is.
//
// Two measured failures, opposite directions, one cause. Both reached a user.
//
//   THROWS ON CLICK (reported from a generated storefront)
//     navigate(next?: Route) — and a handler called navigate('product').
//     toHash() then read `r.params` off a string's undefined property:
//       TypeError: Cannot read properties of undefined (reading 'params')
//         at hash (…)  at onClick (…)
//     The page rendered perfectly and died the moment anything was pressed.
//
//   UNREACHABLE SCREEN, NO ERROR (found in a later three-framework run)
//     navigate(screen: ScreenId) — and one handler called navigate({screen:'home'}).
//     `#/${screen}` stringifies an object rather than throwing, so the hash
//     became '#/[object Object]'. The browser walk recorded the screen id as
//     `[object%20Object]`: a route nobody can parse, a screen nobody reaches,
//     and not one console error to show for it.
//
// TypeScript catches both. It does not run here — the preview compiles with
// Sucrase, which strips types without checking them — so the check lives in the
// audit instead.
//
//   node test/navigate-shape.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/orchestration/interaction-audit.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/ns.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'inherit', cwd: root }
);
const { auditInteractivity } = await import(pathToFileURL(path.join(root, 'dist/ns.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${got}\n      want ${want}`);
  ok ? pass++ : fail++;
};

const fence = (p, body) => `@@@makeui:file ${p}\n${body}\n@@@makeui:endfile\n`;
// The first fence must start its own line — a fence is a whole line, so
// `<body>@@@makeui:file …` is not one and the reader drops that file silently.
const project = (...blocks) => `<!DOCTYPE html><html><body>\n${blocks.join('')}</body></html>`;

// Does the audit report a router disagreement, and nothing else about it?
const flagged = (...blocks) =>
  auditInteractivity(project(...blocks), 'react').filter((d) => d.id === 'navigate-shape').length;

const ENTRY = `import { createRoot } from 'react-dom/client'
import App from './App'
createRoot(document.getElementById('root')).render(<App />)`;

const SCREEN = (n) => `export default function ${n}Screen() { return <main className="screen" /> }`;

const screens = [
  fence('src/main.tsx', ENTRY),
  fence('src/screens/HomeScreen.tsx', SCREEN('Home')),
  fence('src/screens/ListScreen.tsx', SCREEN('List')),
  fence('src/screens/DetailScreen.tsx', SCREEN('Detail')),
];

// ── The declaration takes a string ───────────────────────────────────────────
const TAKES_STRING = `export type ScreenId = 'home' | 'list' | 'detail'
export function navigate(screen: ScreenId): void {
  window.location.hash = \`#/\${screen}\`
}`;

check(
  'string router, string callers — clean',
  flagged(...screens, fence('src/lib/router.ts', TAKES_STRING),
    fence('src/App.tsx', `import { navigate } from './lib/router'
export default function App() { return <button onClick={() => navigate('list')}>一覧</button> }`)),
  0
);

check(
  'string router, object caller — the [object Object] hash',
  flagged(...screens, fence('src/lib/router.ts', TAKES_STRING),
    fence('src/App.tsx', `import { navigate } from './lib/router'
export default function App() { return <button onClick={() => navigate({ screen: 'home' })}>ホーム</button> }`)),
  1
);

// ── The declaration takes an object ──────────────────────────────────────────
const TAKES_ROUTE = `export interface Route { screen: string; params?: Record<string, string> }
const DEFAULT_ROUTE: Route = { screen: 'home' }
export function toHash(route?: Route): string {
  const r = route ?? DEFAULT_ROUTE
  const id = r.params?.id
  return id ? \`#/\${r.screen}/\${id}\` : \`#/\${r.screen}\`
}
export function navigate(next?: Route): void { window.location.hash = toHash(next) }`;

check(
  'route router, route callers — clean',
  flagged(...screens, fence('src/lib/router.ts', TAKES_ROUTE),
    fence('src/App.tsx', `import { navigate } from './lib/router'
export default function App() { return <button onClick={() => navigate({ screen: 'list' })}>一覧</button> }`)),
  0
);

check(
  'route router, string caller — the reported params crash',
  flagged(...screens, fence('src/lib/router.ts', TAKES_ROUTE),
    fence('src/App.tsx', `import { navigate } from './lib/router'
export default function App() { return <button onClick={() => navigate('product')}>商品</button> }`)),
  1
);

// ── Not every mismatch is one ────────────────────────────────────────────────
// A parameter that accepts either shape makes both call sites correct. Flagging
// those would train the repair pass to "fix" working code, which costs a round
// trip and can only make the project worse.
check(
  'union parameter — both call shapes allowed',
  flagged(...screens,
    fence('src/lib/router.ts', `export interface Route { screen: string }
export function navigate(next: Route | string): void {
  const r = typeof next === 'string' ? { screen: next } : next
  window.location.hash = \`#/\${r.screen}\`
}`),
    fence('src/App.tsx', `import { navigate } from './lib/router'
export default function App() { return <><button onClick={() => navigate('list')} /><button onClick={() => navigate({ screen: 'home' })} /></> }`)),
  0
);

// A call that forwards a variable says nothing about its shape, and the audit
// must not guess: `navigate(target)` is the commonest call there is.
check(
  'variable argument — unknowable, not reported',
  flagged(...screens, fence('src/lib/router.ts', TAKES_STRING),
    fence('src/App.tsx', `import { navigate } from './lib/router'
export default function App() { return <button onClick={() => navigate(target)}>次へ</button> }`)),
  0
);

// A project with no router at all must not trip anything.
check(
  'no navigate() anywhere — nothing to check',
  flagged(...screens, fence('src/App.tsx', `export default function App() { return <main /> }`)),
  0
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
