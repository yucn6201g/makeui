// The design phase's live text is one specialist's own text, never several
// interleaved.
//
// Layout, visual language and content run at the same time. Their deltas were
// appended to one string in arrival order, and the progress transcript showed
// 「severity: 15 + 12 = 39px → 44px に統一 ### カラーコントラスト検 'warning',」
// under 「コンテンツを作成中」 — two outputs cut into each other token by token.
//
//   node test/focused-stream.test.mjs      (from backend/)
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist/focused-stream.test.mjs');
await esbuild.build({
  entryPoints: [path.join(root, 'src/orchestration/strands-design.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile: out,
  external: ['@aws-sdk/*', '@smithy/*', '@strands-agents/*'],
  logLevel: 'error',
});
const { focusedStream } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// Three specialists started together, tokens arriving interleaved.
{
  const byNode = new Map();
  const shown = [];
  const focus = [];
  const s = focusedStream(byNode, (t) => shown.push(t), (id) => focus.push(id));
  s.started('layout'); s.started('style'); s.started('content');
  s.delta('layout', 'L1 '); s.delta('content', 'C1 '); s.delta('style', 'S1 ');
  s.delta('content', 'C2 '); s.delta('layout', 'L2 '); s.delta('content', 'C3');
  check('only the focused (latest started) node is forwarded', shown, ['C1 ', 'C1 C2 ', 'C1 C2 C3']);
  check('every node keeps its own complete text', [...byNode].sort(), [['content', 'C1 C2 C3'], ['layout', 'L1 L2 '], ['style', 'S1 ']]);
  check('nothing forwarded mixes two nodes', shown.every((t) => !/[LS]\d/.test(t)), true);

  shown.length = 0;
  s.completed('content');
  check('when the focused node finishes, focus moves to the latest still running', focus, ['style']);
  check('and its text so far is shown at once', shown, ['S1 ']);
  s.delta('layout', 'L3 '); s.delta('style', 'S2 ');
  check('then only that node is forwarded', shown, ['S1 ', 'S1 S2 ']);

  s.completed('layout');
  check('a node finishing out of focus changes nothing', focus, ['style']);
  s.completed('style');
  check('the last one finishing leaves no focus and no relabel', focus, ['style']);
  shown.length = 0;
  s.delta('critic', 'R1');
  check('a node streaming without a start event is taken as the focus', [focus.at(-1), shown], ['critic', ['R1']]);
}

// The sequential chain (one at a time) streams exactly as before.
{
  const shown = [];
  const focus = [];
  const s = focusedStream(new Map(), (t) => shown.push(t), (id) => focus.push(id));
  s.started('a'); s.delta('a', 'x'); s.delta('a', 'y'); s.completed('a');
  s.started('b'); s.delta('b', 'z'); s.completed('b');
  check('a chain forwards each node in turn', shown, ['x', 'xy', 'z']);
  check('and never relabels on its own', focus, []);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
