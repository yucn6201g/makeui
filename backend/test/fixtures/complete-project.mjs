// One project document that clears the contract, shared by every test that needs
// a document good enough to measure something else against.
//
// It was three fixtures, one per test, each with the same comment above it —
// 「Rich enough to clear the floor」 — and when the rubric changed, two of the
// three fell through that floor on the same day. `Rubric.total()` clamps at 30,
// and at the clamp nothing a test varies moves the number, so both of them
// started passing or failing for reasons unrelated to what they assert.
//
// A fixture that has to keep pace with the rubric should exist once.
//
// Written to satisfy the contract rather than to be beautiful: the point is a
// document at the top of the range, so that removing pieces from it, or charging
// it for something, can be seen to cost.

/** One file in the fenced transport. */
export const fence = (p, body) => `@@@makeui:file ${p}\n${body}\n@@@makeui:endfile\n`;

/**
 * The file map. `fw` is the framework table entry when the caller has one —
 * score-sanity passes `FRAMEWORKS.react` so the fixture follows the table rather
 * than a copy of it; callers that only need a rich React document can omit it.
 */
export function completeProject(fw = { entry: 'src/main.tsx', componentExt: '.tsx', routesFile: 'src/routes.ts' }) {
  const files = new Map([
    ['docs/design-guidelines.md', '# Design\nAccent #0017C1, 4px rhythm.'],
    ['SPECIFICATION.md', '# Expenses\nFour screens.'],
    [fw.entry, "import { createRoot } from 'react-dom/client';\nimport App from './App';\ncreateRoot(document.getElementById('root')!).render(<App />);"],
    ['src/App.tsx', "import type { ScreenId } from './routes';\nimport { useNavigation } from './hooks/useNavigation';\nexport default function App() {\n  const { screen, navigate, canGoBack } = useNavigation();\n  return <nav aria-current=\"page\" onChange={() => navigate('list')}>{screen}</nav>;\n}"],
    ['src/routes.ts', "export type ScreenId = 'list' | 'detail';\nexport const NAV_ITEMS: { id: ScreenId; label: string }[] = [];"],
    ['src/hooks/useNavigation.ts', "export function navigate(id: string): void { location.hash = '#/' + id }\nwindow.addEventListener('hashchange', () => {});\nexport const canGoBack = true;\nexport const params: Record<string, string> = {};"],
    ['src/store/AppProvider.tsx', "import { createContext, useReducer } from 'react';\nimport type { Action, State } from './types';\nexport const Ctx = createContext<State | null>(null);\nexport function reducer(s: State, a: Action): State { return s }"],
    ['src/store/types.ts', 'export interface State { items: string[] }\nexport type Action = { type: "add"; id: string }'],
    ['src/lib/format.ts', 'export const yen = (n: number): string => `¥${n}`;'],
    ['src/data/expenses.ts', 'export interface Expense { id: string; amount: number }\nexport const EXPENSES: Expense[] = [{ id: "a", amount: 1 }];'],
    ['src/styles/globals.css', ':root { --accent: #0017C1 }\n.btn:focus-visible { outline: 2px solid var(--accent) }'],
  ]);
  /*
   * Each screen renders one of the illustrations below.
   *
   * The fixture used to ship the artwork and draw none of it, which was a
   * complete project only by the old rubric — that one counted the files. The
   * score now counts the ones a screen actually renders, on the measurement that
   * 47 of 56 shipped projects drew none of theirs, so a fixture that does not
   * render its own would be asserting the behaviour that was wrong.
   */
  const ART = ['EmptyBox', 'NoResults', 'Welcome'];
  ['List', 'Form', 'Pending', 'History', 'Detail'].forEach((n, i) => {
    const art = ART[i % ART.length];
    files.set(`src/screens/${n}Screen.tsx`, `import type { Expense } from '../data/expenses';\nimport { ${art} } from '../components/illustrations/${art}';\ninterface ${n}Props { rows: Expense[] }\nexport default function ${n}Screen({ rows }: ${n}Props) {\n  if (rows.length === 0) return <${art} />;\n  return <form onSubmit={() => {}}>{rows.map((r) => <li key={r.id}>{r.id}</li>)}</form>;\n}`);
  });
  for (const n of ['Badge', 'Card', 'Table', 'Modal', 'EmptyState', 'Toolbar', 'Field']) {
    files.set(`src/components/ui/${n}.tsx`, `interface ${n}Props { label: string }\nexport function ${n}({ label }: ${n}Props) { return <span>{label}</span> }`);
  }
  for (const n of ['Chevron', 'Search', 'Plus', 'Check', 'Close', 'Filter', 'User', 'Bell']) {
    files.set(`src/components/icons/${n}Icon.tsx`, `export function ${n}Icon() { return <svg viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} /> }`);
  }
  for (const n of ['EmptyBox', 'NoResults', 'Welcome']) {
    files.set(`src/components/illustrations/${n}.tsx`, `export function ${n}() { return <svg viewBox="0 0 24 24" stroke="currentColor" /> }`);
  }
  return files;
}

/**
 * The same files as a document, for tests that do not bundle the transport.
 *
 * score-sanity renders this map through `writeProjectDocument` — the real writer
 * — and asserts the two documents score the same, so this shortcut cannot quietly
 * drift into testing a format nothing produces.
 */
export function documentOf(files = completeProject(), extra = '') {
  return '<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8" /></head><body><div id="root"></div>\n' +
    [...files].map(([p, body]) => fence(p, body)).join('') + extra + '</body></html>';
}
