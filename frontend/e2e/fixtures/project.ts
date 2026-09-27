/**
 * A generated project small enough to read, in the transport a real job returns
 * (line-fenced files inside one HTML document). Two screens behind hash links,
 * as generated projects are, so a test can check what the preview shows, that it
 * runs, and that a link moves between screens inside the frame.
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
import { useEffect, useState } from 'react';

const ITEMS = ${JSON.stringify(items)};

// Hash routes and plain links, the way generated projects navigate.
const current = () => (location.hash === '#/settings' ? 'settings' : 'list');

export default function App() {
  const [screen, setScreen] = useState(current);
  useEffect(() => {
    const follow = () => setScreen(current());
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);
  return (
    <div>
      <nav className="app-nav" aria-label="メインナビゲーション">
        <a href="#/" aria-current={screen === 'list' ? 'page' : undefined}>一覧</a>
        <a href="#/settings" aria-current={screen === 'settings' ? 'page' : undefined}>設定</a>
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
