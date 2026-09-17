/**
 * scripts/replay-walk.mjs builds a runnable replay of stored outputs.
 *
 * The browser half cannot run here, so this holds the half that can: from a
 * project document it writes the runnable page, a walk expression that parses
 * and names the declared screens, the index the harness reads, and the harness
 * itself — and it skips what is not a project rather than failing on it.
 *
 *   node test/replay-walk.test.mjs      (from backend/)
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-walk-test-'));
const fence = (files) => Object.entries(files).map(([p, b]) => `@@@makeui:file ${p}\n${b}\n@@@makeui:endfile`).join('\n');
const project = path.join(dir, 'app.html');
fs.writeFileSync(project, fence({
  'src/main.tsx': "import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App';\ncreateRoot(document.getElementById('root')!).render(<App />);",
  'src/routes.ts': "export type ScreenId = 'home' | 'list';\nexport const NAV_ITEMS = [{ id: 'home', label: 'ホーム' }, { id: 'list', label: '一覧' }];",
  'src/App.tsx': 'export default function App() { return <main><h1>ホーム</h1></main> }',
  'src/styles/globals.css': 'main { padding: 16px; }',
}));
const notProject = path.join(dir, 'plain.html');
fs.writeFileSync(notProject, '<!DOCTYPE html><html><body>plain</body></html>');

const out = path.join(dir, 'out');
const log = execFileSync('node', [path.join(root, 'scripts/replay-walk.mjs'), '--out', out, project, notProject], { cwd: root }).toString();

const index = JSON.parse(fs.readFileSync(path.join(out, 'index.json'), 'utf8'));
check('one page for the project', index.map((p) => [p.slug, p.kind]), [['01-app', 'react']]);
check('the document that is not a project is skipped, and said so', /plain: not a project document, skipped/.test(log), true);
check('the runnable page is written', fs.readFileSync(path.join(out, '01-app.html'), 'utf8').includes('<div id="root">'), true);
const walk = fs.readFileSync(path.join(out, '01-app.walk.txt'), 'utf8');
check('the walk expression parses', (() => { try { new Function(`return ${walk}`); return true; } catch { return false; } })(), true);
check('and walks the declared screens', /const DECLARED = \["home","list"\]/.test(walk), true);
const harness = fs.readFileSync(path.join(out, 'replay.html'), 'utf8');
check('the harness walks every page in a desktop-sized frame and keeps the results', /f\.style\.width = '1440px'/.test(harness) && /window\.__replay = results/.test(harness), true);
check('its inline script parses', (() => { try { new Function(harness.split('<script>')[1].split('</script>')[0]); return true; } catch { return false; } })(), true);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
