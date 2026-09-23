// A plan-mode message right after a proposal amends that proposal.
//
// It used to be planned as a brief of its own: the proposal was not sent and the
// whole design phase ran again on 「画面をもう1つ増やして」 alone.
//
//   node test/plan-revision.test.mjs      (from frontend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/utils/planRevision.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist-test/plan-revision.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const { proposalBeingAnswered } = await import(pathToFileURL(path.join(root, 'dist-test/plan-revision.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const proposal = { plan: '## 作るもの', spec: 'SPEC', prompt: 'ECサイト' };
check('the proposal just made is the one answered',
  proposalBeingAnswered([{ role: 'user', content: 'ECサイト' }, { role: 'assistant', proposal }]), { spec: 'SPEC', plan: '## 作るもの', prompt: 'ECサイト' });
check('an earlier proposal is not, once the assistant has said something since',
  proposalBeingAnswered([{ role: 'assistant', proposal }, { role: 'user' }, { role: 'assistant' }]), undefined);
check('the user\'s own messages in between do not count as moving on',
  proposalBeingAnswered([{ role: 'assistant', proposal }, { role: 'user' }]).prompt, 'ECサイト');
check('a proposal with no specification cannot be amended',
  proposalBeingAnswered([{ role: 'assistant', proposal: { ...proposal, spec: ' ' } }]), undefined);
check('an empty thread has nothing to answer', proposalBeingAnswered([]), undefined);

// --- wiring ------------------------------------------------------------------------
const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8');
check('the plan branch sends the proposal being answered, for a build only',
  /const revision = forBuild \? proposalBeingAnswered\(messages\) : undefined;/.test(app), true);
const hook = fs.readFileSync(path.join(root, 'src/hooks/usePlan.ts'), 'utf8');
check('the request carries it', /\.\.\.\(revision && !html \? \{ revision \} : \{\}\)/.test(hook), true);
check('and approving the result builds the original request with the change',
  /promptRef\.current = revision \? revisedPrompt\(revision\.prompt, prompt\) : prompt;/.test(hook), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
