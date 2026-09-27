/**
 * A generated project small enough to read, in the transport a real job returns
 * (line-fenced files inside one HTML document). Two screens and a nav between
 * them, so a test can check both what the preview shows and that it runs.
 */
export function reactProject({ title = '在庫一覧', items = ['ボールペン', 'ノート', 'クリップ'] } = {}): string {
  const file = (path: string, body: string) => `@@@makeui:file ${path}\n${body.trim()}\n@@@makeui:endfile\n`;
  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8" /></head>
<body>
<div id="root"></div>

${file('src/styles/globals.css', `
:root { --color-text: #1a1a1a; --color-bg: #ffffff; }
body { margin: 0; font-family: sans-serif; color: var(--color-text); background: var(--color-bg); }
.app-nav { display: flex; gap: 8px; padding: 8px; }
`)}
${file('src/App.tsx', `
import { useState } from 'react';

const ITEMS = ${JSON.stringify(items)};

export default function App() {
  const [screen, setScreen] = useState<'list' | 'settings'>('list');
  return (
    <div>
      <nav className="app-nav" aria-label="メインナビゲーション">
        <button aria-current={screen === 'list' ? 'page' : undefined} onClick={() => setScreen('list')}>一覧</button>
        <button aria-current={screen === 'settings' ? 'page' : undefined} onClick={() => setScreen('settings')}>設定</button>
      </nav>
      <main>
        {screen === 'list' ? (
          <>
            <h1>${title}</h1>
            <ul>{ITEMS.map((item) => <li key={item}>{item}</li>)}</ul>
          </>
        ) : (
          <h1>設定</h1>
        )}
      </main>
    </div>
  );
}
`)}
${file('src/main.tsx', `
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/globals.css';

createRoot(document.getElementById('root')!).render(<App />);
`)}
</body></html>`;
}
