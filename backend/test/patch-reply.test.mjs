/**
 * Repair replies that carry only the lines they change.
 *
 * A repair changes a median 8% of the file it rewrites and used to be paid for as
 * the whole file. These pin the two promises the form has to keep to be worth
 * the saving: a block edits exactly the place it names or nothing at all, and a
 * reply that cannot be applied is retried as a whole file rather than dropped.
 *
 *   node test/patch-reply.test.mjs      (from backend/)
 */
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/orchestration/patch-reply.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/patch-reply.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const { applyPatchReply, isPatchReply, PATCH_REPLY_RULES } =
  await import(pathToFileURL(path.join(root, 'dist/patch-reply.test.mjs')).href);
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
};

const block = (search, replace) => `<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;

const FILE = [
  "import { useState } from 'react';",
  '',
  'export function Card({ title }: { title: string }) {',
  '  const [open, setOpen] = useState(false);',
  '  return (',
  '    <div className="card">',
  '      <h2>{title}</h2>',
  '      <button onClick={() => setOpen(!open)}>詳細</button>',
  '    </div>',
  '  );',
  '}',
].join('\n');

// --- the form is recognised -----------------------------------------------------------------
check('a reply of blocks is a patch', isPatchReply(block('a', 'b')), true);
check('a whole file is not', isPatchReply(FILE), false);
check('the prompt shows the markers the parser reads', /<<<<<<< SEARCH\n[\s\S]*=======\n[\s\S]*>>>>>>> REPLACE/.test(PATCH_REPLY_RULES), true);

// --- exact blocks ---------------------------------------------------------------------------
const one = applyPatchReply(FILE, block('      <h2>{title}</h2>', '      <h2 className="card-title">{title}</h2>'));
check('an exact block edits its line', one.ok && one.body.includes('<h2 className="card-title">{title}</h2>'), true);
check('and nothing else', one.ok && one.body.replace(' className="card-title"', ''), FILE);

const two = applyPatchReply(FILE, [
  block("import { useState } from 'react';", "import { useState } from 'react';\nimport { ChevronIcon } from './icons/ChevronIcon';"),
  block('      <button onClick={() => setOpen(!open)}>詳細</button>', '      <button onClick={() => setOpen(!open)}><ChevronIcon />詳細</button>'),
].join('\n\n'));
check('several blocks apply in order', two.ok && two.body.includes("import { ChevronIcon }") && two.body.includes('<ChevronIcon />詳細'), true);
check('and report how many there were', two.blocks, 2);

const del = applyPatchReply(FILE, block('  const [open, setOpen] = useState(false);\n', ''));
check('an empty REPLACE deletes', del.ok && !del.body.includes('useState(false)'), true);

// A model's fences around its blocks are not part of any block.
const fenced = applyPatchReply(FILE, '```tsx\n' + block('      <h2>{title}</h2>', '      <h3>{title}</h3>') + '\n```');
check('blocks inside a fence still apply', fenced.ok && fenced.body.includes('<h3>{title}</h3>'), true);
check('CRLF in the reply is read as LF', applyPatchReply(FILE, block('      <h2>{title}</h2>', '      <h3>{title}</h3>').replace(/\n/g, '\r\n')).ok, true);

// --- indentation is forgiven, place is not --------------------------------------------------
const shallow = applyPatchReply(FILE, block('<h2>{title}</h2>\n<button onClick={() => setOpen(!open)}>詳細</button>', '<h2>{title}</h2>\n<p>説明</p>\n<button onClick={() => setOpen(!open)}>詳細</button>'));
check('a block copied without its indentation still lands', shallow.ok, true);
check('and the replacement takes the file’s indentation', shallow.ok && shallow.body.includes('\n      <p>説明</p>\n'), true);

const twice = 'a\n  x = 1;\nb\n  x = 1;\n';
const ambiguous = applyPatchReply(twice, block('x = 1;', 'x = 2;'));
check('a SEARCH that occurs twice is refused, not guessed', ambiguous.ok, false);
check('and says so', ambiguous.error, 'block 1: SEARCH occurs more than once');

const missing = applyPatchReply(FILE, [
  block('      <h2>{title}</h2>', '      <h3>{title}</h3>'),
  block('<footer>', '<footer class="x">'),
].join('\n'));
check('one block that does not match fails the whole reply', missing.ok, false);
check('naming the block', missing.error, 'block 2: SEARCH does not match the file');
check('an empty SEARCH is refused', applyPatchReply(FILE, block('', 'x')).ok, false);
check('a reply with markers but no readable block is refused', applyPatchReply(FILE, '<<<<<<< SEARCH\nfoo').ok, false);
// And it is a patch — a failed one — rather than a whole file certain not to compile.
check('a malformed patch is still recognised as a patch', isPatchReply('<<<<<<< SEARCH\nfoo'), true);
check('markers followed by spaces still read', applyPatchReply(FILE, '<<<<<<< SEARCH  \n      <h2>{title}</h2>\n======= \n      <h3>{title}</h3>\n>>>>>>> REPLACE  ').ok, true);
check('a marker-like line inside the code is not a marker', applyPatchReply('a\nconst s = "<<<<<<< SEARCH";\nb', block('a', 'A')).ok, true);

// --- wiring ---------------------------------------------------------------------------------
const repair = read('src/orchestration/repair-files.ts');
check('a patch is asked for only where one pays', /const reply = patchWorthy\(plan, leaned\.text\.length\) \? 'patch' : 'whole'/.test(repair), true);
check('and a reply is read as blocks only when blocks were asked for', /if \(reply === 'patch' && isPatchReply\(answer\)\)/.test(repair), true);

// --- which repairs get the patch form -------------------------------------------------------
/*
 * Measured on the first round after the form shipped: stylesheets and the
 * critic's visual findings replied at 2-14% of the file; decomposition, icons
 * and imagery-missing replied at 2-14x it.
 */
execSync(
  `npx esbuild "${path.join(root, 'src/orchestration/repair-files.ts')}" --bundle --platform=node --format=esm ` +
    `--loader:.txt=text --outfile="${path.join(root, 'dist/patch-worthy.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'pipe', cwd: root }
);
const { patchWorthy } = await import(pathToFileURL(path.join(root, 'dist/patch-worthy.test.mjs')).href);
const plan = (p, ids, create = false) => ({ path: p, create, defects: ids.map((id) => ({ id, instruction: '' })) });
/** Big enough to be worth patching, unless a check is asking about the floor. */
const BIG = 8000;
check('a stylesheet is always patched', patchWorthy(plan('src/styles/globals.css', ['decomposition']), BIG), true);
check('a component with only visual findings is patched', patchWorthy(plan('src/components/RoomTable.tsx', ['visual-accent', 'visual-density']), BIG), true);
check('a component being decomposed is rewritten whole', patchWorthy(plan('src/screens/Dashboard.tsx', ['decomposition', 'icons', 'imagery-missing']), BIG), false);
check('one structural defect among visual ones makes it whole', patchWorthy(plan('src/components/Header.tsx', ['visual-accent', 'icons']), BIG), false);
check('a new file is never a patch', patchWorthy(plan('src/styles/extra.css', ['visual-accent'], true), BIG), false);
check('nothing to fix is not a patch', patchWorthy(plan('src/App.tsx', []), BIG), false);

/*
 * The seven ids added 2026-09-18, and the floor that came with them. Both are
 * measurements: the ids change a median 2-10% of the file, and every patched
 * file under 1,100 characters in the 60-day window cost more than sending it
 * whole — the worst a 289-character Header that replied with 3,717.
 */
check('a wiring repair is patched', patchWorthy(plan('src/screens/CartScreen.tsx', ['action-dead-runtime']), BIG), true);
check('so is a routing one', patchWorthy(plan('src/App.tsx', ['nav-dead-runtime', 'screen-hidden']), BIG), true);
check('and a preset drift', patchWorthy(plan('src/components/Card.tsx', ['preset-drift', 'palette-size']), BIG), true);
check('an unmeasured defect is written whole', patchWorthy(plan('src/App.tsx', ['something-new']), BIG), false);
check('icons stay whole — they create components', patchWorthy(plan('src/App.tsx', ['icons']), BIG), false);
check('a small file is never patched', patchWorthy(plan('src/components/Header.tsx', ['visual-accent']), 289), false);
check('nor is a small stylesheet', patchWorthy(plan('src/components/StatusBadge.css', ['palette-size']), 524), false);
check('the floor is 2,000 characters', [patchWorthy(plan('src/App.tsx', ['visual-accent']), 1999), patchWorthy(plan('src/App.tsx', ['visual-accent']), 2000)], [false, true]);
check('the module-writing round still asks for whole files', /cleanFile\(await invoke\(fileSystem\(kind\), user\), path\)/.test(repair), true);
check('a patch is applied to the lean body the model was shown', /applyPatchReply\(leaned\.text, answer\)/.test(repair), true);
check('a patch that does not apply is retried once as a whole file', /File repair patch did not apply[\s\S]{0,600}fileSystem\(kind, 'whole'\)/.test(repair), true);
check('an applied patch passes the same gates as a whole file', /raw = applied\.body[\s\S]*const back = restore\(raw, leaned\.images\)[\s\S]*after < before \* 0\.6[\s\S]*parses\(plan\.path, body\)/.test(repair), true);
check('the log says which form the reply took and what it cost', /format,\s*replyChars:/.test(repair), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
