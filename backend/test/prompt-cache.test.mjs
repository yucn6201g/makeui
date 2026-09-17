// A cache breakpoint pays only when the same bytes are sent again.
//
// Bedrock bills a cached prefix at about a tenth and writing one at about 1.25×,
// so a breakpoint after a prompt that varies every call is not a smaller bill —
// it is a larger one. And a prefix under the model's minimum is IGNORED: no
// error, no warning, `cacheReadTokens` zero forever, and the writes still
// billed. Both of those failures are silent, which is why the rules are here
// rather than in a comment at each call site.
//
// The floor is Haiku's, applied to every model. A breakpoint that works on
// Sonnet and silently does nothing on Haiku is the worst of the three outcomes,
// because most MakeUI runs are Haiku and the measurement it produces reads as
// "caching does not help here".
//
//   node test/prompt-cache.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/orchestration/prompt-cache.ts')}" --bundle --platform=node ` +
    `--format=esm --outfile="${path.join(root, 'dist/pc.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const { systemField, worthCaching, fullText, MIN_CACHEABLE_CHARS } = await import(
  pathToFileURL(path.join(root, 'dist/pc.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const long = 'x'.repeat(MIN_CACHEABLE_CHARS);
const short = 'x'.repeat(MIN_CACHEABLE_CHARS - 1);

// --- an unsplit prompt behaves exactly as it did ------------------------------
check('a plain string is sent as a plain string', systemField('hello'), 'hello');

// --- the split, when it is worth making ---------------------------------------
check('a long prefix gets a breakpoint',
  systemField({ cached: long, tail: 'run-specific' }),
  [{ type: 'text', text: long, cache_control: { type: 'ephemeral' } },
   { type: 'text', text: 'run-specific' }]);

check('and with no tail there is only the cached block',
  systemField({ cached: long }),
  [{ type: 'text', text: long, cache_control: { type: 'ephemeral' } }]);

// --- and when it is not --------------------------------------------------------
//
// The whole prompt, as one string. Not "a breakpoint that does nothing": the
// write is billed either way, so the cheaper of two identical outcomes is the
// one that does not ask for the write.
check('a short prefix is sent whole, with no breakpoint',
  systemField({ cached: short, tail: 'run-specific' }), short + 'run-specific');

check('exactly at the floor is cached', Array.isArray(systemField({ cached: long })), true);
check('one character under it is not', typeof systemField({ cached: short }), 'string');

check('worthCaching agrees with both', [worthCaching(long), worthCaching(short)], [true, false]);

// --- splitting must not change what the model reads ---------------------------
//
// The point of the split is billing. If it also changed the prompt, every
// measurement after it would be measuring two things at once.
check('the concatenation is the prompt',
  fullText({ cached: 'AAA', tail: 'BBB' }), 'AAABBB');
check('and a missing tail adds nothing', fullText({ cached: 'AAA' }), 'AAA');
check('a plain string is its own text', fullText('AAA'), 'AAA');

// --- the assembler is actually split at a boundary that holds -----------------
//
// Textual, because the question is which side of the split each piece is on and
// bundling `graph.ts` to ask it would drag the whole pipeline in. Two things
// matter and neither is visible to the compiler: the cached half must hold the
// contract (or there is nothing worth caching), and it must NOT hold anything
// chosen per run (or it never matches twice).
const graph = fs.readFileSync(path.join(root, 'src/orchestration/graph.ts'), 'utf8');
const contract = graph.slice(graph.indexOf('const assemblerContract = `'), graph.indexOf('const assemblerRun = `'));
const run = graph.slice(graph.indexOf('const assemblerRun = `'), graph.indexOf('const codeAssemblerSystem'));

check('the assembler prompt is split in two',
  [contract.length > 0, run.length > 0], [true, true]);
check('the cached half carries the project contract',
  /\$\{projectContract\(outputKind\)\}/.test(contract), true);
check('and the stylesheet contract',
  /\$\{stylesheetContract\(outputKind\)\}/.test(contract), true);
check('the per-run photographs are NOT in the cached half',
  /stockImageInstructions/.test(contract), false);
check('they are in the tail', /stockImageInstructions/.test(run), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
