/**
 * Helpers the screens draw with, run as code (2026-09-30): the code editor's
 * highlighter, the admin panel's money, numbers, dates and usage index, and how
 * much of a long list is drawn at once. Each had been exercised only through a
 * screen, where a wrong answer looks like a layout problem.
 *
 *   node test/list-and-format-helpers.test.mjs      (from frontend/)
 */
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'dist-test/list-and-format-helpers.entry.ts');
fs.mkdirSync(path.dirname(entry), { recursive: true });
fs.writeFileSync(entry, [
  "export { highlightLines } from '../src/utils/editing/codeHighlight';",
  "export * from '../src/components/admin/shared';",
  "export { chunkForScreen, ROW_CHUNK } from '../src/hooks/useProgressiveCount';",
].join('\n'));
const out = path.join(root, 'dist-test/list-and-format-helpers.test.mjs');
execSync(`npx esbuild "${entry}" --bundle --platform=node --format=esm --outfile="${out}" --external:react`, { stdio: 'pipe', cwd: root });
const m = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- the code editor's highlighter ----------------------------------------------------------
{
  const { highlightLines } = m;
  const src = "import { useState } from 'react';\n// a comment\nconst n = 42;";
  const lines = highlightLines(src, 'tsx');
  check('one token row per source line', lines.length, 3);
  check('the rows put the text back together exactly', lines.map((l) => l.map((t) => t.t).join('')).join('\n'), src);
  const classOf = (row, text) => row.find((t) => t.t.includes(text))?.c;
  check('a keyword is a keyword', classOf(lines[0], 'import'), 'kw');
  check('a string is a string', classOf(lines[0], "'react'"), 'st');
  check('a comment is a comment', classOf(lines[1], 'a comment'), 'cm');
  check('a number is a number', classOf(lines[2], '42'), 'nu');
  check('an empty line is an empty row, not a missing one', highlightLines('a\n\nb', 'js').length, 3);
  check('markdown is left as text', highlightLines('# 見出し', 'md'), [[{ t: '# 見出し', c: '' }]]);
  const css = highlightLines('.a { color: red; }', 'css');
  check('css reassembles too', css.map((l) => l.map((t) => t.t).join('')).join('\n'), '.a { color: red; }');
  // A long file is the editor's normal case; it has to stay linear.
  const big = Array.from({ length: 5000 }, (_, i) => `const v${i} = "x${i}"; // ${i}`).join('\n');
  const t0 = performance.now();
  const bigLines = highlightLines(big, 'ts');
  const took = performance.now() - t0;
  check('a 5,000-line file is tokenised whole', bigLines.length, 5000);
  check(`and in well under a second (${Math.round(took)} ms)`, took < 1000, true);
}

// --- money, numbers, dates ---------------------------------------------------------------------
{
  const { asMoney, asLimit, usd, formatNumber, formatDate, UNLIMITED, monthKey } = m;
  check('a stored limit is millionths of a dollar', asMoney(25_000_000), 25);
  check('and back, rounded', asLimit(25.5), 25_500_000);
  check('the round trip keeps cents', asMoney(asLimit(0.07)), 0.07);
  check('money carries its unit', usd(1.8), '$1.80 USD');
  check('large counts are shortened', [formatNumber(999), formatNumber(12_345), formatNumber(2_500_000)], ['999', '12K', '2.5M']);
  check('unlimited is the infinity sign', formatNumber(UNLIMITED), '∞');
  check('a missing date is a dash', formatDate(undefined), '-');
  check('a date is year, month, day and time', /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/.test(formatDate('2026-09-30T03:04:00Z')), true);
  check('month keys are YYYY-MM', /^\d{4}-\d{2}$/.test(monthKey(0)) && /^\d{4}-\d{2}$/.test(monthKey(13)), true);
  check('and step back across a year', monthKey(12) < monthKey(0), true);
}

// --- the usage index -----------------------------------------------------------------------------
{
  const { usageByEmail } = m;
  const rows = [
    { userId: 'a', email: 'Taro@Example.com' },
    { userId: 'b', email: '' },
    { userId: 'c', email: 'hanako@example.com' },
  ];
  const index = usageByEmail(rows);
  check('looked up case-blind, as the directory spells it', index.get('taro@example.com')?.userId, 'a');
  check('a row with no email is not indexed', index.size, 2);
  // Built once: 500 rows looked up 500 times is a Map's job, not 250,000 comparisons.
  const many = Array.from({ length: 5000 }, (_, i) => ({ userId: `u${i}`, email: `u${i}@example.com` }));
  const t0 = performance.now();
  const big = usageByEmail(many);
  let found = 0;
  for (let i = 0; i < 5000; i++) if (big.get(`u${i}@example.com`)) found++;
  check('five thousand accounts are all found', found, 5000);
  check('quickly', performance.now() - t0 < 200, true);
}

// --- how much of a long list is drawn at once -----------------------------------------------------
{
  const { chunkForScreen, ROW_CHUNK } = m;
  check('a laptop screen draws a screenful and a row', chunkForScreen(1280, 800), 25);
  check('a phone still draws a dozen', chunkForScreen(390, 844), 12);
  check('a very large screen is capped', chunkForScreen(5000, 3000), 60);
  check('table rows go a few screens at a time', ROW_CHUNK >= 30 && ROW_CHUNK <= 100, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
