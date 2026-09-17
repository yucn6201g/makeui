/**
 * Two functions record usage, and only one of them could price it.
 *
 * `makeui-backend` and `makeui-worker` run the same `runJob`, and both call
 * `recordUsage` -> `weighTokens`. `weighTokens` returns `inputTokens +
 * outputTokens` when there is no price table, so a function without
 * `MODEL_PRICING` writes a raw token count into a column the budget reads as
 * millionths of a dollar. Measured on one real run: 594,354 with the table,
 * 200,988 without — a third of the cost, against a limit enforced in dollars.
 *
 * The worker had no `MODEL_PRICING`. It is the fallback, so it runs exactly when
 * the AgentCore Runtime is down, which is exactly when a lot of jobs run at
 * once, and its log group holds nothing because that has not happened lately.
 * The same shape as the `group` field the Runtime dropped: correct on the path
 * that is exercised, wrong on the path that is not.
 *
 * The cause is that `deploy-lambda.sh` deployed CODE and never touched the
 * environment, so every variable stayed as CloudFormation stamped it at stack
 * creation. `deploy-runtime.sh` already had the answer for this — it merges a
 * REQUIRED_ENV and pushes the price table from SSM on every deploy, with a
 * comment saying that a feature needing a new variable would otherwise be
 * deployed switched off, silently. The Lambda script now does the same.
 *
 * This file guards the script, because that is where the property lives: the
 * environment is reconciled on every deploy, and a deploy that leaves a
 * usage-recording function unable to price is refused rather than shipped.
 *
 *   node test/deploy-env-parity.test.mjs      (from backend/)
 */
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const deploy = read('../infrastructure/deploy-lambda.sh');
const runtime = read('../infrastructure/deploy-runtime.sh');
const template = read('../infrastructure/template.yaml').replace(/^\s*#.*$/gm, '');
const pricing = read('src/config/pricing.ts');

// --- why it matters -----------------------------------------------------------
// The claim the whole file rests on: no table means the column silently changes
// meaning. If this ever stops being true, the rest is over-engineering.
check('no price table means a raw token count',
  /if \(!table\) return split\.inputTokens \+ split\.outputTokens;/.test(pricing), true);
check('and the table comes from the environment',
  /process\.env\.MODEL_PRICING/.test(pricing), true);

// --- both functions are deployed by one script --------------------------------
check('the script names both usage-recording functions',
  /FUNCTIONS=\("makeui-backend" "makeui-worker"\)/.test(deploy), true);

// --- and it reconciles their environment --------------------------------------
check('the price table is read from SSM, not written here',
  /aws ssm get-parameter --name \/makeui\/pricing\/models/.test(deploy), true);
check('and pushed to every function in the list',
  /for fn in "\$\{FUNCTIONS\[@\]\}"[\s\S]{0,900}update-function-configuration/.test(deploy), true);
/*
 * An unset parameter must leave what the function already has. Overwriting with
 * an empty value on a transient SSM failure would un-price the account, which is
 * the failure this is meant to prevent, arriving through the fix for it.
 */
check('an unreadable parameter changes nothing',
  /if pricing and pricing != "None":/.test(deploy), true);
check('and a deploy that changes nothing says so rather than writing',
  /environment already correct/.test(deploy), true);

// --- the four that no code reads ----------------------------------------------
const DEAD = ['KNOWLEDGE_BASE_ID', 'GUARDRAIL_ID', 'GUARDRAIL_VERSION', 'MEMORY_ID'];
check('the dead variables are removed on deploy',
  DEAD.filter((k) => !deploy.includes(k)), []);
// And are not put back by the template on the next stack update.
check('and the template no longer stamps them',
  DEAD.filter((k) => new RegExp(`^\\s*${k}:`, 'm').test(template)), []);
// Stated as a fact about the code, so this stops being true the day one is read.
const sources = [];
(function walk(dir) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel);
    else if (e.name.endsWith('.ts')) sources.push(read(rel));
  }
})('src');
const all = sources.join('\n');
check('none of them is read anywhere in the source',
  DEAD.filter((k) => all.includes(`process.env.${k}`)), []);

// --- the deploy refuses rather than ships a function that cannot price ---------
/*
 * The part that makes it a guard rather than a hope. A merge that silently did
 * nothing would leave exactly the state this file exists to catch.
 */
check('the deploy verifies the table landed',
  /Environment\.Variables\.MODEL_PRICING[\s\S]{0,200}exit 1/.test(deploy), true);
check('for every function, not just the first',
  (deploy.match(/for fn in "\$\{FUNCTIONS\[@\]\}"/g) ?? []).length >= 2, true);

// --- the runtime script this was modelled on still does its half --------------
// Named here so the two cannot drift apart quietly: if the Runtime stops being
// priced, the same defect is back on the other host.
check('the runtime deploy also pushes the table',
  /MODEL_PRICING.*=.*PRICING|env\["MODEL_PRICING"\]/.test(runtime), true);
// And refuses without it, for the same reason and in the same words. The guard
// was added to the Lambda script first and not here, which would have left the
// two hosts inconsistent in exactly the way this whole file is about.
check('and refuses to ship a runtime that cannot price',
  /grep -q '"MODEL_PRICING"'[\s\S]{0,220}exit 1/.test(runtime), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
