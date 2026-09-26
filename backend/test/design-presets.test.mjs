/**
 * The built-in design presets: published systems, with their own values.
 *
 * On 2026-09-14 the five presets written for this app (product, editorial, warm,
 * console, wireframe) were removed, the Digital Agency preset was checked against
 * the Agency's published tokens and corrected, and Carbon, Spindle and Material 3
 * were added from their published token packages. These hold the pieces that
 * have to agree: the spec the model reads, the signature the document is
 * measured against, the menu the user picks from, and what an old project's
 * removed preset turns into.
 *
 *   node test/design-presets.test.mjs      (from backend/)
 */
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/orchestration/presets/design-presets.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/design-presets.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'pipe', cwd: root }
);
const { presetIds, getPresetSpec, presetConformance, resolveUserDesignSystem, hasPresetSignature } =
  await import(pathToFileURL(path.join(root, 'dist/design-presets.test.mjs')).href);
const src = fs.readFileSync(path.join(root, 'src/orchestration/presets/design-presets.ts'), 'utf8');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
};

const BUILT_IN = ['digital-agency', 'carbon', 'spindle', 'material3'];
check('the presets are none and the four published systems', presetIds(), ['none', ...BUILT_IN]);

// --- the menu offers exactly these -----------------------------------------------------------
const menu = fs.readFileSync(path.join(root, '../frontend/src/utils/projects/presets.ts'), 'utf8');
const menuIds = [...menu.matchAll(/^\s*id: '([a-z0-9-]+)',/gm)].map((m) => m[1]);
check('the composer menu offers the same presets', menuIds, presetIds());

// --- each spec and signature agree ---------------------------------------------------------
/** A signature's own values, read from the source (the table is not exported). */
function signature(id) {
  const key = id.includes('-') ? `'${id}'` : id;
  const start = src.indexOf(`  ${key}: {`, src.indexOf('const PRESET_SIGNATURE'));
  const body = src.slice(start, src.indexOf('\n  },', start));
  const list = (name) => [...(new RegExp(`${name}: \\[([^\\]]*)\\]`).exec(body)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
  return { required: list('required'), palette: list('palette'), font: /font: '([^']+)'/.exec(body)?.[1] };
}
for (const id of BUILT_IN) {
  const spec = getPresetSpec(id);
  const sig = signature(id);
  check(`${id}: has a spec with its source and a composition section`,
    spec.length > 3000 && /Reference: https:\/\//.test(spec) && /COMPOSITION \(how screens are built in this system\)/.test(spec), true);
  check(`${id}: has a signature`, hasPresetSignature(id) && sig.palette.length > 5, true);
  check(`${id}: every signature colour is stated in the spec`,
    sig.palette.filter((c) => !spec.toUpperCase().includes(c.toUpperCase())), []);
  check(`${id}: every required anchor is stated in the spec`, sig.required.filter((r) => !spec.includes(r)), []);
  check(`${id}: the signature font is in the spec's font stack`, Boolean(sig.font) && spec.includes(sig.font), true);
}

// --- the Knowledge Base documents the design phase retrieves agree with the signature ------
/*
 * The design specialists search these, so a colour here that the signature does not
 * permit is a colour the phase is taught and then marked down for. The previous
 * Digital Agency documents taught #D32F2F and #D9D9D9 beside a spec that had already
 * drifted the same way — nothing compared them.
 */
{
  const kb = path.join(root, '../knowledge-base-docs');
  const neutral = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return Math.max(r, g, b) - Math.min(r, g, b) <= 12;
  };
  for (const id of BUILT_IN) {
    const dir = path.join(kb, id);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    check(`${id}: has components and layout documents`, ['components.md', 'layout.md'].every((f) => files.includes(f)), true);
    check(`${id}: each document is tagged with its preset for retrieval`,
      ['components.md', 'layout.md'].every((f) => JSON.parse(fs.readFileSync(path.join(dir, `${f}.metadata.json`), 'utf8')).metadataAttributes?.preset === id), true);
    const palette = new Set(signature(id).palette.map((c) => c.toUpperCase()));
    const text = files.filter((f) => f.endsWith('.md')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    const off = [...new Set([...text.matchAll(/#([0-9a-fA-F]{6})(?![0-9a-fA-F])/g)].map((m) => `#${m[1].toUpperCase()}`))]
      .filter((hex) => !palette.has(hex) && !neutral(hex));
    check(`${id}: every solid colour in its documents is on the signature's palette`, off, []);
  }
  const retired = ['product', 'editorial', 'warm', 'console', 'wireframe'].filter((p) => fs.existsSync(path.join(kb, p)));
  check('no documents remain for a removed preset', retired, []);
}

// --- a document built to the system passes, one off it does not ----------------------------
const doc = (css) => `<!DOCTYPE html><html><head><style>${css}</style></head><body><main>x</main></body></html>`;
const onSystem = {
  'digital-agency': "body{font-family:'Noto Sans JP',sans-serif;color:#1A1A1A}.btn{background:#0017C1;border-radius:8px}.btn:hover{background:#00118F}.err{color:#EC0000}.ok{color:#259D63}",
  carbon: "body{font-family:'IBM Plex Sans JP','IBM Plex Sans',sans-serif;color:#161616}.tile{background:#F4F4F4}.btn{background:#0F62FE;border-radius:0}.btn:hover{background:#0050E6}.tag{border-radius:999px}",
  spindle: "body{font-family:'Helvetica Neue','Hiragino Sans',sans-serif;color:#08121A}.btn{background:#298737;border-radius:3em}.field{border-radius:8px}.dialog{border-radius:20px}.btn:hover{background:#0F5C1F}",
  material3: "body{font-family:Roboto,'Noto Sans JP',sans-serif;color:#1D1B20;background:#FEF7FF}.btn{background:#6750A4;border-radius:9999px}.card{border-radius:12px;background:#F7F2FA}.chip{border-radius:8px}",
};
for (const id of BUILT_IN) {
  const r = presetConformance(doc(onSystem[id]), id);
  check(`${id}: an on-system document conforms`, [r.ratio, r.violations], [1, 0]);
  const off = presetConformance(doc('body{font-family:Arial;color:#222}.a{color:#FF00AA}.b{color:#00AAFF}.c{color:#AA00FF}.d{color:#FFAA00}.e{border-radius:10px}'), id);
  check(`${id}: an off-system document does not`, off.violations > 0 && off.ratio < 1, true);
}

// --- Digital Agency: the values that had drifted from the system ---------------------------
{
  const da = getPresetSpec('digital-agency');
  check('DA: error, success and warning are the system\'s semantic colours', ['#EC0000', '#259D63', '#B78F00'].every((c) => da.includes(c)), true);
  check('DA: the values written from memory are gone', ['#D32F2F', '#388E3C', '#F57C00', '#00C1A2', '#001399', '#E8EAFF', '#1A1A1C'].filter((c) => da.includes(c)), []);
  check('DA: buttons are 56/48/36/28px and inputs 56/48/40px', /large min-height 56px · medium 48px · small 36px · extra-small 28px/.test(da) && /heights large 56px · medium 48px · small 40px/.test(da), true);
  check('DA: focus is a black outline over yellow, not a blue ring', /outline: 4px solid #000000/.test(da) && /#FFD43D/.test(da), true);
}
// Spindle's icons are CC BY-NC-ND.
check('Spindle: the spec tells the model not to copy its icons', /icons are licensed CC BY-NC-ND: do NOT copy them/.test(getPresetSpec('spindle')), true);

// --- a removed preset builds with none ------------------------------------------------------
for (const removed of ['product', 'editorial', 'warm', 'console', 'wireframe']) {
  check(`${removed}: resolves to none`, await resolveUserDesignSystem(removed, 'u', 'r'), 'none');
  check(`${removed}: has no spec left`, getPresetSpec(removed), '');
}
check('a current preset is left as it is', await resolveUserDesignSystem('carbon', 'u', 'r'), null);
check('none is left as it is', await resolveUserDesignSystem('none', 'u', 'r'), null);
check('an imported system still resolves to none', await resolveUserDesignSystem('system:abc', 'u', 'r'), 'none');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
