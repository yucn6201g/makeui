// Markdown to HTML for the editor's preview.
//
// The only markdown this renders is a file the pipeline wrote — a
// SPECIFICATION.md of headings, tables, lists, bold and inline code. So the
// cases here are that document's constructs, plus the two rules that decide
// whether this is safe to put in the user's DOM: everything is escaped before
// anything is transformed, and no raw HTML is passed through.
//
//   node test/markdown.test.mjs      (from frontend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/utils/markdown.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist-test/md.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const { renderMarkdown, escapeHtml } = await import(
  pathToFileURL(path.join(root, 'dist-test/md.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};
const has = (name, md, needle) => check(name, renderMarkdown(md).includes(needle), true);

// --- the constructs a generated specification actually uses ------------------
has('a heading', '# FABRIC — アパレルEC', '<h1>FABRIC — アパレルEC</h1>');
has('and its level', '### home — 商品一覧', '<h3>');
has('a paragraph', 'ユーザーが衣料品を閲覧。', '<p>ユーザーが衣料品を閲覧。</p>');
has('a bullet list', '- ヘッダー\n- カテゴリタブ', '<ul><li>ヘッダー</li><li>カテゴリタブ</li></ul>');
has('a numbered list', '1. 最初\n2. 次', '<ol><li>最初</li><li>次</li></ol>');
has('bold', '**表示内容**:', '<strong>表示内容</strong>');
has('inline code', '`state.items`：全商品', '<code>state.items</code>');
has('a fenced block', '```ts\nconst a = 1;\n```', '<pre class="md-code md-code--ts"><code>const a = 1;</code></pre>');
has('a rule', '---', '<hr />');
has('a quote', '> 注意', '<blockquote>');

// The table is the construct the specification leans on hardest.
const TABLE = ['| 画面ID | 役割 |', '|--------|------|', '| home | 商品一覧 |', '| cart | カート |'].join('\n');
has('a table head', TABLE, '<th>画面ID</th>');
has('a table body', TABLE, '<td>home</td>');
check('every row is carried', (renderMarkdown(TABLE).match(/<tr>/g) ?? []).length, 3);
// Without the rule it is a line that happens to contain pipes.
check('a pipe row with no rule is not a table',
  renderMarkdown('| not | a table |').includes('<table'), false);

// --- escaped before transformed ---------------------------------------------
check('escapeHtml covers the five', escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
check('a script tag is text, not a tag',
  renderMarkdown('<script>alert(1)</script>').includes('<script>'), false);
has('and it is still readable', '<script>alert(1)</script>', '&lt;script&gt;');
check('an img with an onerror is text too',
  renderMarkdown('<img src=x onerror=alert(1)>').includes('<img src=x'), false);
// A link is the one place a URL becomes an attribute, so the scheme is checked.
has('an http link becomes a link', '[docs](https://example.com)', '<a href="https://example.com"');
check('a javascript: link does not',
  renderMarkdown('[x](javascript:alert(1))').includes('<a href'), false);
check('and is left as its own text',
  renderMarkdown('[x](javascript:alert(1))').includes('[x](javascript:alert(1))'), true);

// --- code spans are literal --------------------------------------------------
// The one part of a specification that had to be quoted exactly is the part a
// naive pass would reformat.
has('markdown inside a code span is not markdown', '`**not bold**`', '<code>**not bold**</code>');
check('and it did not also become bold', renderMarkdown('`**not bold**`').includes('<strong>'), false);

// --- termination -------------------------------------------------------------
// Every branch must consume a line. A block opener that no branch claims used to
// be the one shape that could loop forever.
for (const odd of ['|', '>', '-', '```', '#', '1.', '   ', '|||'])
  check(`${JSON.stringify(odd)} terminates`, typeof renderMarkdown(odd), 'string');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
