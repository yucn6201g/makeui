// Does a file survive being written into the document and read back out?
//
// Asked because of a failure that should be impossible: a ContactScreen.tsx
// passed the parse check on the way in and failed it on the way out, at line
// 245. Those two checks call the same function on what is supposed to be the
// same string, so either the splice or the extraction is lossy — and if it is,
// every per-file write in the pipeline is at risk, not just this one.
//
//   node test/splice-roundtrip.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/orchestration/repair/repair-files.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/sr.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'inherit', cwd: root }
);
execSync(
  `npx esbuild "${path.join(root, 'src/orchestration/audit/interaction-audit.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/ia.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'inherit', cwd: root }
);
const { writeFile, parses, cleanFile } = await import(pathToFileURL(path.join(root, 'dist/sr.test.mjs')).href);
const { reactFiles } = await import(pathToFileURL(path.join(root, 'dist/ia.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const DOC = `<!DOCTYPE html><html><body><div id="root"></div>
<script type="text/jsx" data-file="src/main.tsx">import App from './App';\nApp;</script>
<script type="text/jsx" data-file="src/App.tsx">export default function App(){ return <b/>; }</script>
</body></html>`;

/** Write a file in, read it back out, and say whether it is the same string. */
const roundTrip = (body, p = 'src/screens/ContactScreen.tsx') => {
  const out = writeFile(DOC, p, body);
  if (!out) return { spliced: false };
  const back = reactFiles(out).get(p);
  return { spliced: true, same: back?.trim() === body.trim(), back, out };
};

// --- the ordinary case ----------------------------------------------------
const PLAIN = `import { useState } from 'react';
export default function ContactScreen(): JSX.Element {
  const [email, setEmail] = useState<string>('');
  return <form onSubmit={(e) => e.preventDefault()}><input value={email} onChange={(e) => setEmail(e.target.value)} /></form>;
}`;
let r = roundTrip(PLAIN);
check('a plain component survives the round trip', r.same, true);
check('and still parses afterwards', parses('src/screens/ContactScreen.tsx', r.back), null);

// --- the shape that can still truncate it ---------------------------------
// A block ends at the closing tag matching the one that opened it, so a file
// body holding its own transport's closing tag cuts the file in half.
const WITH_CLOSING_SCRIPT = `export default function ContactScreen(): JSX.Element {
  const help = 'HTMLを貼るときは </script> を含めないでください';
  return <p>{help}</p>;
}`;
// Such a body is refused rather than silently halved: the caller reports a
// skipped file, which is recoverable, instead of a corrupted one, which is not.
check('a body that would close the transport is refused',
  writeFile(DOC, 'src/screens/ContactScreen.tsx', WITH_CLOSING_SCRIPT), null);

// --- and the shape that only looked like it could -------------------------
// A closing STYLE tag inside a SCRIPT block was refused too, back when the
// extraction ended at the first closing tag of either name. That reader was
// wrong — the DOM's own parser, which the browser preview uses on the same
// bytes, closes a script only on `</script>` — and refusing here discarded
// correct files for a truncation that could not happen. A screen rendering a
// <style> element in its JSX is ordinary React, and it has to survive.
const WITH_CLOSING_STYLE = `export default function ContactScreen(): JSX.Element {
  return <div><style>{\`.a{color:red}\`}</style><p>hello</p></div>;
}`;
const styled = roundTrip(WITH_CLOSING_STYLE);
check('a closing style tag inside a script block is allowed', styled.spliced, true);
check('and the file is read back whole', styled.same, true);
check('and still parses', parses('src/screens/ContactScreen.tsx', styled.back), null);
// The other direction: a CSS file travels in a <style>, so there it is fatal.
check('a css body holding </style> is refused',
  writeFile(DOC, 'src/styles/globals.css', 'a { color: red } </style>'), null);

// --- where those bodies came from ----------------------------------------
// The model answering with the transport wrapper around the file, or with the
// file followed by a stray closing tag. Measured: this is what put a `</script>`
// at line 245 of a ContactScreen.tsx.
check('a wrapped response is unwrapped',
  cleanFile(`<script type="text/jsx" data-file="src/screens/ContactScreen.tsx">\n${PLAIN}\n</script>`),
  PLAIN);
check('a trailing closing tag is dropped', cleanFile(`${PLAIN}\n</script>`), PLAIN);
check('and everything after it', cleanFile(`${PLAIN}\n</script>\n<script data-file="x.tsx">junk</script>`), PLAIN);
check('a clean response is untouched', cleanFile(PLAIN), PLAIN);
check('a fenced response still works', cleanFile('```tsx\n' + PLAIN + '\n```'), PLAIN);

// The same untied-alternation mistake as the block reader, one layer up: the
// cut has to be the tag that ends THIS file's transport. Without the path it
// severed a screen at its own <style> markup, and the truncated body then
// failed the parse gate — so the repair was silently discarded rather than
// shipped broken, which is why it went unnoticed.
const SCREEN_WITH_STYLE = `export default function S(): JSX.Element {
  return <div><style>{\`.a{color:red}\`}</style><p>tail</p></div>;
}`;
check('a screen keeping its own <style> is not cut', cleanFile(SCREEN_WITH_STYLE, 'src/screens/S.tsx'), SCREEN_WITH_STYLE);
check('and the kept body parses', parses('src/screens/S.tsx', cleanFile(SCREEN_WITH_STYLE, 'src/screens/S.tsx')), null);
check('a css response is still cut at </style>', cleanFile('a { color: red }\n</style>\njunk', 'src/styles/globals.css'), 'a { color: red }');
check('a tsx response is still cut at </script>', cleanFile(`${PLAIN}\n</script>`, 'src/screens/ContactScreen.tsx'), PLAIN);
// No path means no way to know, so the conservative either-tag cut stands.
check('without a path both tags still cut', cleanFile(SCREEN_WITH_STYLE).includes('<p>tail</p>'), false);
// And the cleaned body now round-trips, which is the whole point.
check('the unwrapped body survives the round trip',
  roundTrip(cleanFile(`<script type="text/jsx" data-file="src/screens/ContactScreen.tsx">\n${PLAIN}\n</script>`)).same,
  true);

// A long realistic form, to rule out size alone.
const LONG = `import { useState } from 'react';
export default function ContactScreen(): JSX.Element {
${Array.from({ length: 240 }, (_, i) => `  const v${i} = ${i};`).join('\n')}
  return <form><input name="email" /><button>送信</button></form>;
}`;
r = roundTrip(LONG);
check('a 245-line file survives on length alone', r.same, true);
check('and parses', parses('src/screens/ContactScreen.tsx', r.back), null);

// --- what must not be disturbed ------------------------------------------
r = roundTrip(PLAIN);
check('the neighbouring files are untouched',
  [...reactFiles(r.out).keys()].sort(),
  ['src/App.tsx', 'src/main.tsx', 'src/screens/ContactScreen.tsx']);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
