// What a share link is allowed to serve.
//
// A generated project is stored as its own source — a fenced list of
// `src/App.tsx`, `src/screens/…`. That is not a web page. Publishing uploaded it
// to S3 as `text/html` anyway, so every share link made since multi-file output
// shipped served the project's source with the HTML parser quietly discarding
// every component tag. The preview never had this problem because the preview
// compiles first; this is that compile, moved in front of the same document.
//
// The build itself needs sucrase and the vendored framework runtimes and is
// measured in a browser. What IS testable here is the decision around it, and
// the decision is where the bug was: there was no call to build at all.
//
//   node test/share-document.test.mjs      (from frontend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/utils/shareDocument.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist-test/sd.test.mjs')}" "--external:virtual:*" ` +
    `"--alias:@vue/compiler-sfc=@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js"`,
  { stdio: 'pipe', cwd: root }
);
const { shareDocument } = await import(pathToFileURL(path.join(root, 'dist-test/sd.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const fence = (p, body) => `@@@makeui:file ${p}\n${body}\n@@@makeui:endfile\n`;
const project = (...files) =>
  `<!DOCTYPE html><html><body>\n${files.map(([p, b]) => fence(p, b)).join('')}</body></html>`;

// A build that records what it was handed, so the assertions can be about the
// call rather than about a compiler this file does not run.
const spy = (result) => {
  const calls = [];
  const fn = async (files) => { calls.push(files.map((f) => f.path)); return result; };
  fn.calls = calls;
  return fn;
};

const REACT = project(
  ['src/main.tsx', "import { createRoot } from 'react-dom/client';\nimport App from './App';\ncreateRoot(document.getElementById('root')).render(<App />);"],
  ['src/App.tsx', 'export default function App() { return <h1>hi</h1> }']
);

// --- the fix ---------------------------------------------------------------
// The one assertion the old code fails: a multi-file project must be compiled,
// and what gets published must be the compiled document, not the source.
{
  const build = spy({ html: '<!DOCTYPE html><html>compiled</html>', error: null });
  const out = await shareDocument(REACT, build);
  check('a project is compiled before it is published', build.calls.length, 1);
  check('and what is published is the compiled document', out, {
    html: '<!DOCTYPE html><html>compiled</html>', error: null,
  });
  check('the source document is not what goes out', out.html.includes('@@@makeui:file'), false);
  check('the compiler is handed the project files', build.calls[0].includes('src/App.tsx'), true);
}

// --- the tab title ---------------------------------------------------------
// A published page IS the page someone opens, so it has a browser tab. The name
// reaches the builder through the scaffold's index.html rather than as a second
// argument, so the tab and the index.html in the downloaded ZIP cannot disagree.
{
  const build = spy({ html: '<html>ok</html>', error: null });
  const seen = [];
  await shareDocument(REACT, async (files) => { seen.push(files); return build.calls.push(0), { html: 'x', error: null }; }, '在庫管理ダッシュボード');
  const index = seen[0].find((f) => f.path === 'index.html');
  check('the project name reaches the scaffold as the title',
    /<title>在庫管理ダッシュボード<\/title>/.test(index.content), true);
}
{
  const seen = [];
  await shareDocument(REACT, async (files) => { seen.push(files); return { html: 'x', error: null }; });
  const index = seen[0].find((f) => f.path === 'index.html');
  check('and an unnamed project still gets a title', /<title>[^<]+<\/title>/.test(index.content), true);
}
{
  // A project whose name is only spaces is an unnamed project, not a blank tab.
  const seen = [];
  await shareDocument(REACT, async (files) => { seen.push(files); return { html: 'x', error: null }; }, '   ');
  const index = seen[0].find((f) => f.path === 'index.html');
  check('a blank name falls back rather than emitting an empty title',
    /<title>\s*<\/title>/.test(index.content), false);
}

// Vue and Svelte are the same path — the gate asks `detectKind`, not for `.tsx`.
for (const [name, files] of [
  ['vue', [['src/main.ts', "import { createApp } from 'vue'"], ['src/App.vue', '<template><h1>hi</h1></template>']]],
  ['svelte', [['src/main.ts', "import App from './App.svelte'"], ['src/App.svelte', '<h1>hi</h1>']]],
]) {
  const build = spy({ html: '<html>ok</html>', error: null });
  const out = await shareDocument(project(...files), build);
  check(`a ${name} project is compiled too`, [build.calls.length, out.html], [1, '<html>ok</html>']);
}

// --- a legacy single page --------------------------------------------------
// Projects predating multi-file output ARE a web page. Compiling is not just
// unnecessary there, there is nothing to compile — and the old behaviour was
// correct for exactly these.
{
  const page = '<!DOCTYPE html><html><body><h1>plain</h1></body></html>';
  const build = spy({ html: 'should not be used', error: null });
  const out = await shareDocument(page, build);
  check('a legacy single-page document is published as it is', out, { html: page, error: null });
  check('and the compiler is not called for it', build.calls.length, 0);
}

// --- refusing to publish ---------------------------------------------------
// The alternative to refusing is a link that renders blank, or one that paints a
// stack trace over a page someone has already sent to a colleague.
{
  const out = await shareDocument(REACT, spy({ html: null, error: 'src/App.tsx: Unexpected token' }));
  check('a project that will not build is not published', out.html, null);
  check('and the compiler error is carried to the user', out.error.includes('src/App.tsx: Unexpected token'), true);
}
{
  const out = await shareDocument(REACT, async () => { throw new Error('runtime chunk missing'); });
  check('a compiler that throws is reported, not swallowed', out.html, null);
  check('with its message', out.error.includes('runtime chunk missing'), true);
}
{
  const out = await shareDocument(REACT, spy({ html: null, error: null }));
  check('a build that returns nothing is a failure, not an empty publish', out.html, null);
  check('and says so', typeof out.error, 'string');
}

// Nothing on the canvas is not something to upload.
{
  const out = await shareDocument(null, spy({ html: 'x', error: null }));
  check('no document is refused before anything is built', out.html, null);
  check('and that is an error, not silence', typeof out.error, 'string');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
