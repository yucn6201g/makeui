// The reach terms must not charge a document for a walk that ran out of time.
//
//   node test/truncated-reach.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { documentOf } from './fixtures/complete-project.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/orchestration/graph.ts')}" --bundle --platform=node --format=esm ` +
    `--loader:.txt=text --outfile="${path.join(root, 'dist/gr.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'pipe', cwd: root }
);
const { scoreHtml } = await import(pathToFileURL(path.join(root, 'dist/gr.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/*
 * One project document, shared with the other scoring tests.
 *
 * This built its own — 「Rich enough to clear the floor」 — and when 22 checks
 * that every measured document passed became gates, it fell through that floor
 * and both reach assertions started comparing 30 with 30. A fixture that has to
 * keep pace with the rubric belongs in one place.
 */
const DOC = documentOf();

// One screen of four opened. Below half reach that costs up to forty-five
// points plus five a screen — the right charge when the walk finished looking,
// and a charge for the probe's own budget when it did not.
const base = {
  fills: [1], emptyBoxes: 0, consoleErrors: 0, deadNav: 0, deadActions: 0,
  throwingControls: 0, stubbedComponents: 0, smallFields: 0,
  unreachableScreens: 3, declaredScreens: 4, contrastFaults: 0, mobileOverflowPx: 0,
};
const finished = scoreHtml(DOC, undefined, 'react', { ...base, truncated: false });
const cutShort = scoreHtml(DOC, undefined, 'react', { ...base, truncated: true });

/*
 * Relations, not numbers. These read `finished, 30` and `cutShort, 47`, which
 * are facts about the rubric's weights rather than about the reach terms, so
 * every change to the scale broke them without anything being wrong. What this
 * test is for is the gap and its direction.
 */
check('a walk that finished charges for what it could not reach', finished < cutShort, true);
check('and the charge is worth noticing', cutShort - finished >= 5, true);

// Above half reach only the five-a-screen term applies, so the gap is smaller
// and still there.
const three = { ...base, fills: [1, 1, 1], unreachableScreens: 1 };
check('and the same holds above half reach',
  scoreHtml(DOC, undefined, 'react', { ...three, truncated: false }) <
    scoreHtml(DOC, undefined, 'react', { ...three, truncated: true }),
  true);

// The award is deliberately left alone. It is evidence of what was opened, and a
// truncated walk that still reached everything must not lose the points it
// earned — skipping it as well was measured to cost such a document five.
const whole = { ...base, fills: [1, 1, 1, 1], unreachableScreens: 0 };
check('a fully covered walk scores the same either way',
  scoreHtml(DOC, undefined, 'react', { ...whole, truncated: false }),
  scoreHtml(DOC, undefined, 'react', { ...whole, truncated: true }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
