/**
 * Data the stories share. The generated project is the E2E suite's own
 * (e2e/fixtures/project.ts): a small React app in the transport a real job
 * returns, with two screens behind hash links.
 */
import type { PhaseEntry } from '../src/utils/chat/phaseTranscript';
export { reactProject } from '../e2e/fixtures/project';

const at = Date.now() - 90_000;

/** A run part way through: the design phase done, the code being written. */
export const PHASES_RUNNING: PhaseEntry[] = [
  { label: 'layout-architect', text: '画面構成: 在庫一覧（表）と設定。ナビゲーションは上部に固定。', chars: 1_240, tokens: 820, startedAt: at, endedAt: at + 18_000 },
  { label: 'style-expert', text: '余白は8の倍数、見出しは24/20/16px、主要色は #0F62FE。', chars: 960, tokens: 1_610, tokensAtStart: 820, startedAt: at + 18_000, endedAt: at + 31_000 },
  { label: 'code-assembler', text: "@@@makeui:file src/App.tsx\nimport { useState } from 'react';\n\nexport default function App() {\n  const [screen, setScreen] = useState('list');", chars: 4_380, tokens: 3_900, tokensAtStart: 1_610, startedAt: at + 31_000 },
];

/** The same run, finished. */
export const PHASES_DONE: PhaseEntry[] = PHASES_RUNNING.map((p, i, all) => ({ ...p, endedAt: p.endedAt ?? at + 88_000 + i - all.length }));
