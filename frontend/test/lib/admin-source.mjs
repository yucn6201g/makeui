// The admin panel's source as one text, for the tests that assert on what it says.
//
// The panel was one 2,900-line file; it is now one file per tab under
// src/components/admin/. A test that looks for a behaviour anywhere in the
// panel reads all of them, so it does not have to know which file a tab lives in.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/components/admin');

/*
 * In the order the single file had them — helpers, editors, the tabs, the
 * panel last — so a test that slices "from ModelsTab to the main panel" still
 * finds them in that order. Any file added later comes before the panel.
 */
const ORDER = ['shared.ts', 'editors.tsx', 'UsageTab.tsx', 'UsersTab.tsx', 'ProjectsTab.tsx', 'GroupsTab.tsx', 'ModelsTab.tsx'];
const rank = (f) => (f === 'AdminPanel.tsx' ? 999 : ORDER.includes(f) ? ORDER.indexOf(f) : 500);

/** Every file of the admin panel, as repo-relative paths. */
export const ADMIN_FILES = fs.readdirSync(dir).filter((f) => /\.(ts|tsx)$/.test(f))
  .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  .map((f) => `src/components/admin/${f}`);

/** One file of the panel from the first occurrence of `from` to its end, line endings normalised. */
export function adminSection(file, from) {
  const s = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n');
  const at = s.indexOf(from);
  return at < 0 ? '' : s.slice(at);
}

/** All of them, concatenated, with line endings normalised. */
export function readAdminPanel() {
  return ADMIN_FILES.map((f) => fs.readFileSync(path.join(dir, path.basename(f)), 'utf8')).join('\n').replace(/\r\n/g, '\n');
}
