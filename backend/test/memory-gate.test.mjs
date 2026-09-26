/**
 * A gate should refuse what it was built to refuse, and nothing else.
 *
 * The design-memory write required five audits to come back empty. Over 30 days
 * of Runtime logs: 35 written, 244 skipped, 0 failed — one run in eight. The
 * store works and is thinly fed, which is a different problem from a store that
 * is broken, and reads the same from the outside.
 *
 * (It reads the same from `list-actors`, too, which returns an empty array here:
 * these records are written with `BatchCreateMemoryRecords` into a namespace,
 * not as events, so there is no actor to list. `list-memory-records` on the
 * namespace is the probe that answers the question.)
 *
 * The reason it passed so rarely is that four of the five audits had nothing to
 * do with the record being written. `summariseDesignDecisions` stores palette,
 * type, radius, shadow and screen count — visual language, computed off the
 * document's CSS. Whether a nav link is dead, whether the seed data is flat,
 * whether the shell has navigation: real defects, and none of them a reason to
 * distrust a palette. They are also the COMMON ones — imagery-missing 119,
 * action-dead-runtime 92, shell-without-nav 59 over the window — so in practice
 * they decided the outcome, and what they decided had nothing to do with the
 * palette they were deciding about.
 *
 * Measured over the 205 runs in that window that shipped with open defects, 101
 * carried nothing from `design-audit` or `design-system-audit` — the two whose
 * findings bear on what the record holds. So the gate below is one run in two
 * rather than one in eight.
 *
 * What this file holds is that correspondence: the gate consults the audits that
 * read what is stored, and does not consult the ones that do not. Both halves
 * matter — adding a behavioural audit back would close it again, and dropping a
 * visual one would fill the store with palettes worth nobody's time.
 *
 *   node test/memory-gate.test.mjs      (from backend/)
 */
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const out = path.join(root, 'dist/memory-gate.test.mjs');
fs.mkdirSync(path.dirname(out), { recursive: true });
const entry = path.join(root, 'dist/memory-gate-entry.ts');
fs.writeFileSync(entry, "export { summariseDesignDecisions } from '../src/orchestration/generate/plan.js'\n");
await esbuild.build({
  entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out,
  external: ['@aws-sdk/*', '@smithy/*', '@strands-agents/*'],
});
const { summariseDesignDecisions } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/** The defect ids an audit file can produce, read off its own source. */
const idsIn = (file) =>
  [...new Set([...read(`src/orchestration/audit/${file}`).matchAll(/id: '([a-z-]+)'/g)].map((m) => m[1]))].sort();

const VISUAL = [...idsIn('design-audit.ts'), ...idsIn('design-system-audit.ts')];
const BEHAVIOURAL = [...idsIn('interaction-audit.ts'), ...idsIn('seed-data-audit.ts')];

check('the visual audits have findings to make', VISUAL.length > 0, true);
check('and so do the behavioural ones', BEHAVIOURAL.length > 0, true);
// If these overlapped, "gate on the visual ones" would not be a statement about
// anything — the split is the whole argument.
check('the two sets are disjoint', VISUAL.filter((id) => BEHAVIOURAL.includes(id)), []);

// --- what the gate consults ---------------------------------------------------
const graph = read('src/orchestration/generate/graph.ts');
const gate = graph.slice(graph.indexOf('const blockers = ['), graph.indexOf('const clean = blockers.length === 0'));
check('the gate is the three checks that read the record', [
  /toRunnableDocument\(finalHtml, outputKind\)\.error/.test(gate),
  /auditAiTells\(finalHtml, presetName, outputKind\)/.test(gate),
  /auditDesignSystem\(finalHtml\)/.test(gate),
], [true, true, true]);
/*
 * And not the three that do not. This is the assertion that fails if the old
 * gate is restored, which is the direction the bug travelled: each of them is
 * individually reasonable to add, and any one of them closes the store again.
 */
check('and consults none of the behavioural audits', [
  'auditInteractivity', 'auditShellContract', 'auditSeedData',
].filter((fn) => gate.includes(fn)), []);
// A document that cannot render has CSS that was never resolved, so its computed
// palette is not a design decision — it is a parse of something broken.
check('an unrenderable document is still refused', /not-runnable/.test(gate), true);

// A skip that does not say what stopped it cannot be told from a skip that was
// right to happen, and 244 of them said only "skipped".
check('a skip names what blocked it',
  /logger\.info\('Skipped memory write', \{ requestId, blockers \}\)/.test(graph), true);
check('and the blockers are ids, not booleans',
  /auditAiTells\([^)]*\)\.map\(\(d\) => d\.id\)/.test(gate), true);

// --- what is actually stored --------------------------------------------------
/*
 * The gate is only defensible if the record really is visual language. Asserted
 * against a document rather than against the source, because "it stores the
 * palette" is a claim about output.
 */
const doc = `@@@makeui:file src/styles/globals.css
:root { --brand: #2A78D6; --ink: #1B1B1F; --radius-sm: 4px; --radius-lg: 12px;
        --font-base: Inter, sans-serif; }
.button { background: #2A78D6; color: #FFFFFF; border-radius: var(--radius-sm);
          box-shadow: 0 1px 2px rgba(0,0,0,.08); font-family: var(--font-base); }
.card { background: #FFFFFF; border-radius: var(--radius-lg); }
.badge { background: #2A78D6; color: #FFFFFF; }
@@@makeui:endfile
@@@makeui:file src/screens/ListScreen.tsx
export default function ListScreen() { return <div className="card" />; }
@@@makeui:endfile
@@@makeui:file src/screens/DetailScreen.tsx
export default function DetailScreen() { return <div className="card" />; }
@@@makeui:endfile`;

const record = summariseDesignDecisions({
  prompt: '備品貸出を管理する管理画面', presetName: 'digital-agency',
  outputKind: 'react', html: doc, score: 88,
});

check('the record is text', typeof record, 'string');
check('it carries the palette that was committed to', /#2A78D6/i.test(record), true);
// Resolved through the custom properties: reading declarations literally
// records `var(--font-base)`, which tells the next design phase nothing.
check('the typeface, resolved through its token', /Inter/.test(record), true);
check('and the radius scale, likewise', /4-12px/.test(record), true);
check('both screens are counted', /2/.test(record), true);

/*
 * And nothing behavioural. This is the other half of the correspondence: if the
 * record ever starts carrying behaviour, the gate has to start reading the
 * audits that check it, and this test should be the thing that says so.
 */
check('it says nothing about routing, controls or seed data',
  ['route', 'nav', 'onClick', 'dead', 'seed'].filter((w) => record.toLowerCase().includes(w.toLowerCase())), []);

// --- the store's own bounds still apply ---------------------------------------
// Opening the gate is only safe because what is behind it is bounded.
const memory = read('src/tools/agent/memory-tool.ts');
check('the store keeps a bounded number per person', /KEEP_PER_ACTOR = \d+/.test(memory), true);
check('retrieval is bounded too', /RETRIEVE_LIMIT = \d+/.test(memory), true);
check('and a weak match is not a preference', /MIN_SCORE = 0\.\d+/.test(memory), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
