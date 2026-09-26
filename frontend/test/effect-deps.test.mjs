/**
 * No effect may depend on state it sets itself.
 *
 * The model tab shipped showing its spinner for ever, on every open, and the
 * cause is a shape rather than a typo:
 *
 *   useEffect(() => {
 *     if (!visible || inventory || inventoryBusy) return;   // guard
 *     let cancelled = false;
 *     setInventoryBusy(true);                               // ...on state it sets
 *     fetch().finally(() => { if (!cancelled) setInventoryBusy(false); });
 *     return () => { cancelled = true; };
 *   }, [visible, inventory, inventoryBusy, fetch]);          // ...and depends on
 *
 * The effect runs and sets busy; the dependency changed, so React tears the
 * effect down — running the cleanup, which sets `cancelled` — and re-runs it;
 * the re-run returns at the guard; and the first fetch resolves into handlers
 * that are all `if (!cancelled)`. Busy is never cleared. Deterministic, every
 * time, and it went out.
 *
 * The test that was supposed to cover it asserted the guard LINE, verbatim. It
 * pinned the defect. So this one is a rule over every effect in these files
 * rather than a fact about one of them.
 *
 * The rule is narrower than "no effect may depend on state it sets" — three
 * effects in App.tsx do that and are correct, for three different reasons; they
 * are the fixtures at the bottom of this file. What cannot stand is the PAIR: a
 * flag set synchronously in the body, a dependency on that flag, and a cleanup
 * that disables the completion which would clear it. The fix is always the same
 * — a ref for identity, and the effect depending only on things outside itself.
 *
 *   node test/effect-deps.test.mjs      (from frontend/)
 */
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN_FILES, readAdminPanel } from './lib/admin-source.mjs';
import { APP_FILES, readApp } from './lib/app-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  ...ADMIN_FILES,
  ...APP_FILES,
  'src/components/workspace/Preview.tsx',
  'src/components/project-list/ProjectList.tsx',
];

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/**
 * Every `useEffect(() => { … }, [deps])` in a file, as body + dependency names.
 *
 * Brace-counted rather than matched with a regex, because an effect body holds
 * every kind of nesting there is and the dependency array is what comes after
 * its closing brace.
 */
function effects(src) {
  const out = [];
  const OPEN = 'useEffect(() => {';
  for (let i = src.indexOf(OPEN); i !== -1; i = src.indexOf(OPEN, i + 1)) {
    let depth = 0;
    let j = i + OPEN.length - 1;
    for (; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) break; }
    }
    if (j >= src.length) continue;
    const body = src.slice(i + OPEN.length, j);
    const tail = src.slice(j + 1, src.indexOf(')', src.indexOf(']', j)) + 1);
    const arr = /\[([^\]]*)\]/.exec(tail);
    // No dependency array at all: runs every render, which is a different
    // question and not this one's.
    if (!arr) continue;
    out.push({
      at: src.slice(0, i).split('\n').length,
      body,
      deps: arr[1].split(',').map((d) => d.trim()).filter(Boolean),
    });
  }
  return out;
}

/** `const [x, setX] = useState…` — the pairs a file declares. */
function statePairs(src) {
  const pairs = new Map();
  for (const m of src.matchAll(/const \[(\w+), (set\w+)\] = useState/g)) pairs.set(m[1], m[2]);
  return pairs;
}

/**
 * Whether `setX(` is called as a STATEMENT of the effect, rather than inside
 * something the effect merely arranges to happen later.
 *
 * The distinction is the whole rule. Three other effects in these files depend
 * on state they set and are correct:
 *
 *   App.tsx  `model` — sets it only when the current one is not permitted, to
 *            one that is, so the next run stops at the guard. A fixpoint, and it
 *            has to depend on the value it is correcting.
 *   App.tsx  `isResizing` — set from a mouseup handler, not while the effect
 *            runs. The re-run tearing the listeners down is the point.
 *   App.tsx  `loadedHtml` — set inside a `.then`, guarded once per project by a
 *            ref, and a superseded run only declines to set a value that is
 *            already set.
 *
 * None of them can strand anything. The one that shipped broken sets its flag
 * synchronously AND has a cleanup that disables the completion which would clear
 * it — that pair is the deadlock, and it is what this looks for.
 */
function setsSynchronously(body, setter) {
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (depth === 0 && body.startsWith(setter + '(', i)) {
      // Not the body of an arrow that was declared on the way here: `const f =
      // () => setX(false)` is a function, not a call.
      const before = body.slice(0, i);
      const lastStatement = Math.max(before.lastIndexOf(';'), before.lastIndexOf('{'), before.lastIndexOf('}'));
      if (!before.slice(lastStatement + 1).includes('=>')) return true;
    }
  }
  return false;
}

/** Whether the effect returns a teardown — the half that can strand the rest. */
const hasCleanup = (body) => /return \(\) =>/.test(body);

const offenders = [];
let effectCount = 0;
for (const rel of FILES) {
  const src = fs.readFileSync(path.join(root, rel), 'utf8');
  const pairs = statePairs(src);
  for (const e of effects(src)) {
    effectCount += 1;
    if (!hasCleanup(e.body)) continue;
    for (const dep of e.deps) {
      const setter = pairs.get(dep);
      if (!setter) continue;
      if (!setsSynchronously(e.body, setter)) continue;
      offenders.push(`${rel}:${e.at} sets \`${setter}\` and depends on \`${dep}\`, with a cleanup`);
    }
  }
}

check('the scan found effects to look at', effectCount > 20, true);
check('and state pairs to check them against',
  statePairs(readAdminPanel()).size > 5, true);
check('no effect strands itself on state it sets', offenders, []);

// --- the scanner itself, against the four shapes it has to tell apart ------
/*
 * A scan that finds nothing proves nothing until it is shown finding something —
 * and a narrowed scan has to be shown NOT finding the things it was narrowed
 * away from. All four fixtures below are the real shapes from these files.
 *
 * Run through the same two predicates the scan above uses, not through a looser
 * copy of them: a self-test that exercises a different rule is how "it finds it"
 * and "it is fixed" come to be two different checks.
 */
const flagged = (src) => {
  const pairs = statePairs(src);
  return effects(src).flatMap((e) => (hasCleanup(e.body)
    ? e.deps.filter((d) => pairs.get(d) && setsSynchronously(e.body, pairs.get(d)))
    : []));
};

check('the shape that shipped is caught', flagged(`
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (busy) return;
    let cancelled = false;
    setBusy(true);
    go().finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [visible, busy, go]);
`), ['busy']);

// A fixpoint with no cleanup: it sets synchronously and converges, and there is
// nothing to strand. App.tsx's `model` correction.
check('a converging correction is not', flagged(`
  const [model, setModel] = useState('auto');
  useEffect(() => {
    if (allowed.includes(model)) return;
    setModel(allowed[0]);
  }, [allowed, model]);
`), []);

// Set from an event handler, not while the effect runs. App.tsx's resize.
check('nor a setter called from a listener', flagged(`
  const [isResizing, setIsResizing] = useState(false);
  useEffect(() => {
    if (!isResizing) return;
    const up = () => setIsResizing(false);
    document.addEventListener('mouseup', up);
    return () => document.removeEventListener('mouseup', up);
  }, [isResizing]);
`), []);

// Set inside a `.then`, so a torn-down run only declines to write a value that
// is already written. App.tsx's preview recovery.
check('nor one inside a promise handler', flagged(`
  const [loadedHtml, setLoadedHtml] = useState('');
  useEffect(() => {
    if (loadedHtml) return;
    let cancelled = false;
    fetchIt().then((html) => { if (!cancelled && html) setLoadedHtml(html); });
    return () => { cancelled = true; };
  }, [loadedHtml]);
`), []);

// And a setter handed somewhere rather than called.
check('nor a setter merely passed along', flagged(`
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const stop = register({ onDone: setBusy });
    return () => stop();
  }, [busy, register]);
`), []);

// --- and the effect that shipped broken, specifically ----------------------
const panel = readAdminPanel();
const inv = effects(panel).find((e) => e.body.includes('fetchModelInventory('));
check('the inventory effect was found', Boolean(inv), true);
check('it no longer guards on its own busy flag', /inventoryBusy/.test(inv.body), false);
check('nor lists it', inv.deps.includes('inventoryBusy'), false);
check('nor the value it fetches', inv.deps.includes('inventory'), false);
check('it depends only on things outside itself', inv.deps,
  ['visible', 'superAdmin', 'modelPeriod', 'fetchModelInventory']);
// A counter, so a superseded request cannot clear the flag a newer one set —
// which is the other half of how the spinner got stuck.
check('identity is a ref', /inventoryRequestRef\.current/.test(inv.body), true);
check('and the newest request is the one that wins',
  /const current = \(\) => inventoryRequestRef\.current === id/.test(inv.body), true);
check('every handler is guarded by it', (inv.body.match(/if \(current\(\)\)/g) ?? []).length, 3);
// The one that matters: whatever else happens, the spinner stops.
check('including the one that clears the spinner', /finally\(\(\) => \{ if \(current\(\)\) setInventoryBusy\(false\)/.test(inv.body), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
