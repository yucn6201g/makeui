// The project list's source as one text, for the tests that assert on what it says.
//
// The list was one file; its card is ProjectCard.tsx since 2026-09-27 (memoised,
// so a tab change does not redraw every card). A test that looks for a behaviour
// of the list or its cards reads both, and does not have to know which holds it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The list, then its card. */
export const PROJECT_LIST_FILES = [
  'src/components/project-list/ProjectList.tsx',
  'src/components/project-list/ProjectCard.tsx',
];

/** All of them, concatenated, with line endings normalised. */
export function readProjectList() {
  return PROJECT_LIST_FILES.map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n').replace(/\r\n/g, '\n');
}
