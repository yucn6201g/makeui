// Whether the user's data actually reaches the calls that write the records.
//
// An edit is where "replace the mock data with this CSV" is said, and the way
// this fails is silent: the file travels, the API accepts it, the job parses it,
// and then the one prompt that writes seed data never sees it. The edit comes
// back looking successful with the same invented rows in it.
//
// So these assertions are about the prompt strings themselves, captured from a
// fake `invoke`. Both edit calls take one, which makes the whole path testable
// without a model.
//
//   node test/edit-attachment.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = (src, out) =>
  execSync(
    `npx esbuild "${path.join(root, src)}" --bundle --platform=node --format=esm ` +
      `--outfile="${path.join(root, out)}" --external:@aws-sdk/* --external:@smithy/*`,
    { stdio: 'pipe', cwd: root }
  );
bundle('src/orchestration/edit-files.ts', 'dist/ea-edit.test.mjs');
bundle('src/utils/data-attachment.ts', 'dist/ea-data.test.mjs');
const { planFileEdits, applyFileEdits } = await import(
  pathToFileURL(path.join(root, 'dist/ea-edit.test.mjs')).href
);
const { parseAttachment, attachmentDirective } = await import(
  pathToFileURL(path.join(root, 'dist/ea-data.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const fence = (p, body) => `@@@makeui:file ${p}\n${body}\n@@@makeui:endfile\n`;
const PROJECT =
  '<!DOCTYPE html><html><body>\n' +
  fence('src/main.tsx', "import { createRoot } from 'react-dom/client';\nimport App from './App';\ncreateRoot(document.getElementById('root')).render(<App />);") +
  fence('src/App.tsx', "import Orders from './screens/Orders';\nexport default function App() { return <Orders /> }") +
  fence('src/screens/Orders.tsx', "const ORDERS = [{ id: 'A-1', customer: 'テスト', total: 100 }];\nexport default function Orders() { return <ul>{ORDERS.map((o) => <li key={o.id}>{o.customer}</li>)}</ul> }") +
  '</body></html>';

const CSV = [
  'order_id,customer,item,qty,total,status',
  ...Array.from({ length: 3847 }, (_, i) => `A-${100000 + i},顧客${i},商品${i % 6},${(i % 4) + 1},${i * 13},受付`),
].join('\n');
const DATA = attachmentDirective(parseAttachment({ name: 'orders.csv', content: CSV }));

/** Records every prompt it is handed and answers with a usable plan / file. */
const recorder = (reply) => {
  const seen = [];
  const fn = async (system, user) => { seen.push(user); return reply; };
  fn.seen = seen;
  return fn;
};

// --- the planner -----------------------------------------------------------
// It needs the data as much as the editor does: replacing seed data can mean a
// new file — a fixtures module, a filter the record count now warrants — and a
// planner that has not seen the data cannot know that.
{
  const invoke = recorder('{"files":[{"path":"src/screens/Orders.tsx","reason":"データ差し替え"}]}');
  const plans = await planFileEdits(PROJECT, 'モックデータを添付のCSVに差し替えて', '', invoke, DATA);
  check('the planner is asked at all', invoke.seen.length, 1);
  check('and its prompt carries the sample', invoke.seen[0].includes('A-100000,顧客0'), true);
  check('and the real row count', invoke.seen[0].includes('全 3,847 行'), true);
  check('the plan still parses', plans.map((p) => p.path), ['src/screens/Orders.tsx']);
}

// --- the editor ------------------------------------------------------------
// This is the call that writes the records, so this is the assertion that
// matters most.
{
  const invoke = recorder("const ORDERS = [{ id: 'A-100000', customer: '顧客0', total: 0 }];\nexport default function Orders() { return null }");
  await applyFileEdits(
    PROJECT,
    [{ path: 'src/screens/Orders.tsx', create: false }],
    'モックデータを添付のCSVに差し替えて',
    '',
    invoke,
    DATA
  );
  check('the editor is asked', invoke.seen.length, 1);
  check('and its prompt carries the sample', invoke.seen[0].includes('A-100001,顧客1'), true);
  check('and the column names', invoke.seen[0].includes('order_id,customer,item,qty,total,status'), true);
  check('and the instruction not to invent different ones',
    invoke.seen[0].includes('列名を勝手に変えたり'), true);
}

// --- no attachment ---------------------------------------------------------
// The prompt an edit without a data file sends must be exactly what it sent
// before any of this existed.
{
  const withData = recorder('{"files":[{"path":"src/screens/Orders.tsx"}]}');
  const without = recorder('{"files":[{"path":"src/screens/Orders.tsx"}]}');
  await planFileEdits(PROJECT, 'ボタンを青くして', '', withData, '');
  await planFileEdits(PROJECT, 'ボタンを青くして', '', without);
  check('an empty directive and no directive are the same prompt',
    withData.seen[0], without.seen[0]);
  check('and neither mentions an attachment', /添付データ/.test(without.seen[0]), false);
}

// --- the design pass is not the carrier ------------------------------------
// `changeSpec` is produced only when the router asks for a design pass, and it
// is presented to the rewriter as "an interaction designer specified this
// change". Folding the data into it would both mislabel it and lose it on every
// edit the router judged simple — which is most data replacements.
{
  const invoke = recorder('{"files":[{"path":"src/screens/Orders.tsx"}]}');
  await planFileEdits(PROJECT, 'データを差し替えて', '', invoke, DATA);
  check('the data arrives with no change specification at all',
    invoke.seen[0].includes('全 3,847 行'), true);
  check('and is not presented as a design specification',
    invoke.seen[0].includes('specified in detail'), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
