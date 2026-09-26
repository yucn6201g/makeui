// The app shell's source as one text, for the tests that assert on what it says.
//
// App.tsx was 3,000 lines holding the sign-in form, the workspace and the
// routing between them; those are now src/auth/LoginForm.tsx,
// src/components/workspace/Workspace.tsx and a short App.tsx. A test that
// looks for a behaviour of the shell reads all three, in the order the single
// file had them, so slices "from X to Y" still find X before Y.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const APP_FILES = ['src/auth/LoginForm.tsx', 'src/components/workspace/Workspace.tsx', 'src/App.tsx'];

export function readApp() {
  return APP_FILES.map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n').replace(/\r\n/g, '\n');
}
