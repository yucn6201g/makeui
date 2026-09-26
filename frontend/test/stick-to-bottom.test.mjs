// The chat thread follows the run while the reader is at the bottom.
//
// It scrolled only when a message was added or the phase label changed. A step's
// text arrives on the poll after its label and opens a tall body, so the card grew
// after the scroll and the newest output sat below the fold — "sometimes", because
// it depended on whether the text and the label landed on the same poll.
//
//   node test/stick-to-bottom.test.mjs      (from frontend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { APP_FILES, readApp } from './lib/app-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/utils/chat/stickToBottom.ts')}" --bundle --platform=node ` +
    `--format=esm --outfile="${path.join(root, 'dist-test/stb.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const { createStickToBottom, STICK_PX, PROGRAMMATIC_MS } = await import(
  pathToFileURL(path.join(root, 'dist-test/stb.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/** A scroll container. A smooth scroll records its target; `animate` moves toward it. */
function fakeThread(contentHeight = 2000, clientHeight = 600) {
  const el = {
    scrollHeight: contentHeight, clientHeight, scrollTop: 0, target: null, calls: [],
    scrollTo({ top, behavior }) {
      this.calls.push(behavior);
      const max = this.scrollHeight - this.clientHeight;
      if (behavior === 'instant') { this.scrollTop = Math.min(top, max); this.target = null; }
      else this.target = Math.min(top, max);
    },
  };
  return el;
}
let t = 0;
const now = () => t;

// --- following while at the bottom ------------------------------------------
{
  const el = fakeThread(); const s = createStickToBottom(el, now);
  s.scrollToEnd(false);
  check('starts at the end', el.scrollTop, 1400);
  el.scrollHeight += 240; // a step's body opens a poll after its label
  s.contentChanged();
  check('grown content is followed when the reader was at the end', el.scrollTop, 1640);
  el.scrollHeight += 30; s.contentChanged();
  check('every growth, not only a phase change', el.scrollTop, 1670);
}

// --- a reader who scrolled up is left alone -----------------------------------
{
  const el = fakeThread(); const s = createStickToBottom(el, now);
  s.scrollToEnd(false);
  s.onUserIntent(); el.scrollTop = 900; s.onScroll();
  check('scrolling up releases', s.stuck, false);
  el.scrollHeight += 500; s.contentChanged();
  check('and growth does not pull the reader back', el.scrollTop, 900);
  el.scrollTop = el.scrollHeight - el.clientHeight - (STICK_PX - 10); s.onScroll();
  check('scrolling back near the end sticks again', s.stuck, true);
}

// --- our own smooth scroll ---------------------------------------------------
{
  t = 0;
  const el = fakeThread(); const s = createStickToBottom(el, now);
  el.scrollTop = 0; s.onScroll(); // opened scrolled to the top
  check('a thread opened away from the end is not stuck', s.stuck, false);
  s.scrollToEnd(true);
  t = 100; el.scrollTop = 500; s.onScroll();
  check('the animation\'s own intermediate events do not read as scrolling up', s.stuck, true);
  el.scrollHeight += 300; t = 200; s.contentChanged();
  check('content that grows mid-animation is still reached', [el.scrollTop, el.calls.at(-1)], [1700, 'instant']);
  check('and the reader is still following', s.stuck, true);
}
{
  t = 0;
  const el = fakeThread(); const s = createStickToBottom(el, now);
  s.scrollToEnd(true); t = 100; el.scrollTop = 700; s.onScroll();
  s.onUserIntent(); el.scrollTop = 300; s.onScroll();
  check('taking the wheel during our animation hands control back at once', s.stuck, false);
}
{
  t = 0;
  const el = fakeThread(); const s = createStickToBottom(el, now);
  s.scrollToEnd(true); t = PROGRAMMATIC_MS + 1; el.scrollTop = 200; s.onScroll();
  check('an animation that never arrives stops holding intent after the bound', s.stuck, false);
}
{
  t = 0;
  const el = fakeThread(); const s = createStickToBottom(el, now);
  s.scrollToEnd(true); el.scrollTop = 1400; s.onScrollEnd();
  el.scrollTop = 1000; s.onScroll();
  check('after scrollend, the next scroll is the reader\'s', s.stuck, false);
}

// --- App wires it to the content, not to a list of state -----------------------
{
  const app = readApp().replace(/\r\n/g, '\n');
  check('App creates the follower for the chat thread', /createStickToBottom\(/.test(app), true);
  check('App watches the thread\'s content size', /new ResizeObserver\(/.test(app), true);
  check('App forwards scroll, scrollend and reader intent',
    ['\'scroll\'', '\'scrollend\'', '\'wheel\'', '\'touchstart\'', '\'keydown\''].every((e) => app.includes(e)), true);
  // The observers are suspended while the tab is in the background — measured:
  // ResizeObserver does not fire at all there, not even its first callback — and
  // a run keeps writing the whole time. A heartbeat carries the follow through,
  // so a run that grew off-screen is at its end when the reader comes back.
  check('App keeps following even when the observers are asleep',
    /setInterval\([\s\S]{0,60}?contentChanged/.test(app) && app.includes("'visibilitychange'"), true);
  // A follower holding a node React has replaced scrolls something nobody sees.
  check('App re-attaches when the thread element itself changes',
    /ref=\{setChatThread\}/.test(app) && /\[threadEl, threadFollower\]/.test(app), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
