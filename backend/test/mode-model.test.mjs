// A mode must not choose a model. This is the file that used to check it did.
//
// There were two copies of a table saying which model each mode forced — one in
// config/effort.ts as `fixedModel`, one in App.tsx as `MODE_MODEL` to lock the
// picker — and this test kept them equal. Two copies of a fact is the
// arrangement this repository has been burned by before, so guarding them was
// right; what was wrong was having them.
//
// Measured over 30 days on the deployed system:
//
//   economy (Haiku)  67% failed to compile first time, 4 calls, 85k out, 440s
//   fast    (Sonnet) 25% failed to compile first time, 2 calls, 50k out, 278s
//
// 「高速」 came out faster than 「節約」 while doing strictly more work, because
// the weaker model broke the build twice as often and every break bought an
// emergency repair pass. One control was deciding two independent things, and
// two independent things do not fit on one dial in an order.
//
// So the table is gone from both sides and this file asserts its absence. The
// same drift it used to catch is now caught by there being nothing to drift:
// the menu cannot show one model while the run uses another, because the menu
// no longer has an opinion about the model.
//
// Textual, like api-routes.test.mjs and for the same reason: the question is
// what each side spells, and bundling either would answer something harder
// while depending on more.
//
//   node test/mode-model.test.mjs      (from backend/)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = fs.readFileSync(path.join(root, 'src/config/effort.ts'), 'utf8');
const composer = fs.readFileSync(path.resolve(root, '..', 'frontend', 'src', 'components', 'workspace', 'Workspace.tsx'), 'utf8');
/*
 * Both files EXPLAIN the table that went, by name, which is deliberate and is
 * asserted below — so a search for the name over the whole file finds the
 * explanation and reports the thing as still present. The code is what is being
 * asked about, so the code is what is searched.
 */
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const serverCode = strip(server);
const composerCode = strip(composer);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- neither side holds a mode-to-model table ------------------------------------
{
  check('no profile fixes a model', /fixedModel/.test(serverCode), false);
  check('and nothing resolves one from a mode', /modelForRun/.test(serverCode), false);
  check('the composer holds no such table', /MODE_MODEL/.test(composerCode), false);

  /*
   * And the reason survives in both files. These are the two places somebody
   * would go to re-add it, and a removal with no explanation beside it is an
   * invitation to undo — this repository has re-derived and re-removed the same
   * thing before for exactly that reason.
   */
  check('the server says why it went', /A mode used to be able to override the model picker/.test(server), true);
  check('and so does the composer', /stood here: a table locking/.test(composer), true);
}

// --- the picker is never disabled by a mode ---------------------------------------
{
  /*
   * The lock is what the table was FOR. `disabled={isProcessing}` and nothing
   * else: a run in flight still freezes the control, because changing the model
   * mid-request would describe the wrong run.
   */
  const at = composer.indexOf('label="モデル"');
  check('the model dropdown exists', at > 0, true);
  const dropdown = composer.slice(at, at + 900);
  check('and is disabled only while a run is in flight',
    /disabled=\{isProcessing\}/.test(dropdown), true);
  check('never by a locked model', /lockedModel/.test(composerCode), false);
  check('and offers the whole permitted set',
    /options=\{allowedModels\.map/.test(dropdown), true);
}

// --- the two menus agree about which modes exist -----------------------------------
{
  /*
   * The drift this file still has to catch. The server decides what a mode
   * means and refuses what it does not recognise; the composer decides what can
   * be picked. A mode in one and not the other is a request the user can make
   * and the server will not honour — or a mode nobody can reach.
   */
  const efforts = /^const EFFORTS: Effort\[\] = \[([^\]]+)\]/m.exec(server);
  const serverModes = efforts
    ? [...efforts[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort()
    : [];
  const menuAt = composer.indexOf('const CHAT_MODES: DropdownOption[] = [');
  const menu = composer.slice(menuAt, composer.indexOf('];', menuAt));
  const menuModes = [...menu.matchAll(/id: '([a-z]+)'/g)].map((m) => m[1])
    // `plan` is a workflow rather than an effort: it runs the design phase and
    // stops, and the server has no profile for it.
    .filter((id) => id !== 'plan').sort();
  check('the server knows two modes', serverModes, ['checked', 'draft']);
  check('and the menu offers exactly those', menuModes, serverModes);
}

// --- the old names still resolve, on both sides -------------------------------------
{
  /*
   * A version row written in August carries `standard`; a job resumed from
   * storage carries `economy`. The server maps them by meaning, and the
   * composer has to be able to label them or a historical reply loses its chip
   * — which would make every past 節約 build look like a checked one.
   */
  const legacy = ['economy', 'fast', 'standard', 'thinking'];
  const serverLegacy = [...server.matchAll(/^\s{2}(economy|fast|standard|thinking): '(draft|checked)',/gm)]
    .map((m) => m[1]).sort();
  check('the server maps all four old names', serverLegacy, [...legacy].sort());
  const composerLegacy = [...composer.matchAll(/^\s{2}(economy|fast|standard|thinking): '/gm)]
    .map((m) => m[1]).sort();
  check('and the composer labels all four', composerLegacy, [...legacy].sort());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
