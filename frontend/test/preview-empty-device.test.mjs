/**
 * An empty preview, dressed as the device it is set to.
 *
 * Switching the preview to タブレット or モバイル with nothing generated yet fell
 * through to the bare placeholder, and the container it landed in is
 * `flex-direction: column` — inherited from the base `.preview__frame-container`
 * rule — while its `align-items: flex-start` was written for a row. In a column
 * container that property is the HORIZONTAL axis, so the message sat hard
 * against the left edge. Measured in a browser against the real stylesheet:
 * 16px of gap on the left, 786px on the right, in a 1005px pane.
 *
 * Two things were wrong and both are fixed here: the container is stated as a
 * row, and the shell is drawn whether or not there is a document — so 「タブレット
 * 表示」 with nothing in it looks like a tablet with nothing in it.
 *
 *   node test/preview-empty-device.test.mjs      (from frontend/)
 */
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const preview = fs.readFileSync(path.join(root, 'src/components/Preview.tsx'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/index.css'), 'utf8');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/** Every declaration block written for exactly this selector, joined.
    The stylesheet states some rules twice — a base pass and a Figma pass — and
    reading only the first says the opposite of what the browser computes. */
const rule = (sel) => {
  const out = [];
  const needle = `\n${sel} {`;
  for (let i = css.indexOf(needle); i !== -1; i = css.indexOf(needle, i + 1)) {
    out.push(css.slice(i + needle.length, css.indexOf('}', i)));
  }
  return out.join('\n');
};

// --- the container was a column pretending to be a row ---------------------
const dev = css.slice(css.indexOf('.preview__frame-container--tablet,'), css.indexOf('.preview__device-stage {'));
check('the device container rule was found', dev.length > 0, true);
check('it states its direction rather than inheriting column',
  /flex-direction:\s*row/.test(dev), true);
// Both of these were written for a row and only make sense in one.
check('and keeps the alignment that was written for one',
  [/align-items:\s*flex-start/.test(dev), /justify-content:\s*center/.test(dev)], [true, true]);
// The base rule is what it inherited from, and it is still a column — the desktop
// preview stacks the error banner above the frame.
check('the base container is still a column', /flex-direction:\s*column/.test(rule('.preview__frame-container')), true);

// --- the shell is drawn with nothing in it ---------------------------------
// One expression choosing the body, then one shell around it, rather than the
// shell living inside the `html ?` branch.
check('the body is chosen before the frame is', /const body = html \? \(/.test(preview), true);
check('and the desktop case returns it bare', /if \(device === 'desktop'\) return body;/.test(preview), true);
check('every other case wraps it in the stage', /return \(\s*\n\s*<div className="preview__device-stage" ref=\{setStage\}>/.test(preview), true);
check('with the body inside the screen', /<StatusBar device=\{device\} \/>[\s\S]{0,220}\{body\}/.test(preview), true);
// The bezel is not decoration: judging a phone layout needs the frame.
check('the phone still has its buttons', /preview__device-btn--power/.test(preview), true);
check('the tablet its camera', /preview__device-camera/.test(preview), true);
check('and the home indicator is still drawn', /preview__device-indicator/.test(preview), true);
// The stage is what the scale effect measures. It now exists from the first
// render on a device, rather than appearing when a document arrives.
check('the stage is no longer conditional on a document',
  preview.indexOf('preview__device-stage') > preview.indexOf('if (device === \'desktop\') return body;'), true);
// One iframe in the file, so the ref cannot be attached to two of them.
check('the iframe is written once', (preview.match(/className="preview__iframe"/g) ?? []).length, 1);
check('and the placeholder once', (preview.match(/className="preview__placeholder"/g) ?? []).length, 1);

// --- inside the screen, the empty state stands where the app will ----------
const insetMobile = rule('.preview__device--mobile .preview__device-screen .preview__iframe,\n.preview__device--mobile .preview__device-screen .preview__placeholder,\n.preview__device--mobile .preview__device-screen .generating');
check('the placeholder takes the same inset as the app',
  /preview__device-screen \.preview__placeholder/.test(css), true);
check('and so does the progress canvas',
  /preview__device-screen \.generating/.test(css), true);
// A message tucked under the clock reads as a layout fault rather than an empty
// screen.
check('the mobile inset clears the status bar', /margin-top:\s*54px/.test(insetMobile || css), true);
// Inside a 393px screen the placeholder has no 400px to claim.
check('the placeholder gives up its minimum height in a screen',
  /min-height:\s*0/.test(rule('.preview__device-screen .preview__placeholder')), true);
check('and is centred rather than left to the container',
  /text-align:\s*center/.test(rule('.preview__device-screen .preview__placeholder')), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
