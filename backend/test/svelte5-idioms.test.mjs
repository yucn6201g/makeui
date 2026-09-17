// Two Svelte 4 idioms that Svelte 5 removed, and that take the whole page with
// them when a model writes one.
//
// Both were found by compiling the corpus, not by reasoning: measured across 71
// shipped Svelte projects, 6 refuse to build and these are two of the six. A
// component that will not compile is a blank screen, so each of these is worth
// 1.4% of Svelte output going from nothing to something.
//
//   <form onsubmit|preventDefault={handleSubmit}>
//     'onsubmit|preventDefault' is not a valid attribute name
//   let { navigate } = $props(useNavigation());
//     `$props` cannot be called with arguments
//
// The second is the interesting one. The rune takes no arguments, so anything
// inside is a mistake — but there are two readings and they give opposite
// results, so the corpus decided it: `useNavigation` is a real export and
// `<Header />` is rendered in six places with no props at all. Dropping the
// argument compiles and leaves `navigate` undefined, which is a dead navigation
// on every screen. Unwrapping it is what the line plainly means.
//
//   node test/svelte5-idioms.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = (src, out, extra = '') =>
  execSync(
    `npx esbuild "${path.join(root, src)}" --bundle --platform=node --format=esm ` +
      `--loader:.txt=text --outfile="${path.join(root, out)}" ` +
      `--external:@aws-sdk/* --external:@smithy/* ${extra}`,
    { stdio: 'pipe', cwd: root }
  );
bundle('src/tools/framework-fixups.ts', 'dist/s5.test.mjs');
// No `--alias` for @vue/compiler-sfc here: framework-compile.ts already imports
// the browser build by path, so an alias onto the same target doubles it and
// esbuild cannot resolve the result. The frontend's copy still needs one, which
// is why the flag exists over there and not here.
bundle('src/tools/framework-compile.ts', 'dist/s5c.test.mjs');

const { fixSvelteEventModifiers, fixSveltePropsArgument, fixupProject } = await import(
  pathToFileURL(path.join(root, 'dist/s5.test.mjs')).href
);
const { compileFile } = await import(pathToFileURL(path.join(root, 'dist/s5c.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/** Does Svelte accept it? The only question that matters for either of these. */
const compiles = (source) => {
  try {
    const out = compileFile('svelte', 'src/components/X.svelte', source);
    return out.error ?? null;
  } catch (e) {
    return String(e.message ?? e);
  }
};

// --- event modifiers -------------------------------------------------------
const FORM = `<script>
  let value = $state('');
  function handleSubmit() { value = 'sent'; }
</script>
<form onsubmit|preventDefault={handleSubmit}>
  <input bind:value />
  <button type="submit">送信</button>
</form>`;

check('the Svelte 4 idiom does not compile', typeof compiles(FORM), 'string');
{
  const out = fixSvelteEventModifiers(FORM);
  check('it is reported', out.fixed.length, 1);
  check('and the result compiles', compiles(out.source), null);
  check('the handler is still called', /handleSubmit\)\(e\)/.test(out.source), true);
  check('and preventDefault still happens', out.source.includes('e.preventDefault();'), true);
  check('the modifier is gone from the attribute name', /onsubmit\|/.test(out.source), false);
}
{
  // Several at once, in the order they were written.
  const src = '<div onclick|preventDefault|stopPropagation={go}>x</div>';
  const out = fixSvelteEventModifiers(src);
  check('every modifier it can express is expressed',
    out.source.includes('e.preventDefault(); e.stopPropagation();'), true);
}
{
  const src = '<div onclick|self={go}>x</div>';
  check('self becomes the check it means',
    fixSvelteEventModifiers(src).source.includes('if (e.target !== e.currentTarget) return;'), true);
}
{
  // `once` has no expression here. Dropping it changes behaviour, and that is
  // still better than a component that does not compile and a blank screen —
  // but it has to be said, not done quietly.
  const out = fixSvelteEventModifiers('<div onclick|once={go}>x</div>');
  check('a modifier that cannot be expressed is dropped', out.source.includes('onclick={(e) =>'), true);
  check('and the report says which', out.fixed[0].includes('once'), true);
  check('and that it was removed rather than translated', out.fixed[0].includes('除去'), true);
}
{
  // An ordinary handler must come through untouched, or this fixup is a hazard
  // on every file it runs over.
  const src = '<button onclick={go}>x</button><form onsubmit={submit}>y</form>';
  const out = fixSvelteEventModifiers(src);
  check('a handler with no modifier is left exactly as it was', out.source, src);
  check('and nothing is reported', out.fixed, []);
}

// --- $props with an argument ----------------------------------------------
const HEADER = `<script>
  import { useNavigation } from '../lib/navigation.svelte';
  let { navigate } = $props(useNavigation());
</script>
<button onclick={() => navigate('/home')}>ホーム</button>`;

check('the mistaken call does not compile', typeof compiles(HEADER), 'string');
{
  const out = fixSveltePropsArgument(HEADER);
  check('the values keep the source the author gave them',
    out.source.includes("let { navigate } = useNavigation();"), true);
  check('and the result compiles', compiles(out.source), null);
  check('it is reported', out.fixed.length, 1);
  // The alternative repair — dropping the argument — also compiles. It is
  // rejected because `<Header />` is rendered with no props, so `navigate`
  // would be undefined and every button on the page would do nothing.
  check('the rune is not left standing with nothing behind it',
    /\$props\(\)/.test(out.source), false);
}
{
  // An object literal reads as defaults rather than a source, and there the
  // other repair is the safe one: let the parent supply them.
  const src = "<script>let { a } = $props({ a: 1 });</script>";
  const out = fixSveltePropsArgument(src);
  check('an object argument is dropped instead', out.source.includes('$props()'), true);
  check('and that is reported differently', out.fixed[0].includes('オブジェクト'), true);
}
{
  const src = "<script>let { a } = $props();</script>";
  const out = fixSveltePropsArgument(src);
  check('a correct call is untouched', out.source, src);
  check('and reported as nothing', out.fixed, []);
}

// --- through the whole chain ----------------------------------------------
// The fixups run in order over a project, and the event-modifier repair sits
// ahead of the attribute-shorthand one deliberately: the shorthand repair would
// otherwise read `onsubmit|preventDefault={x}` as an attribute to rewrite.
{
  const fence = (p, b) => `@@@makeui:file ${p}\n${b}\n@@@makeui:endfile\n`;
  const project =
    '<!DOCTYPE html><html><body>\n' +
    fence('src/main.ts', "import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.getElementById('app') });") +
    fence('src/App.svelte', FORM) +
    fence('src/components/Header.svelte', HEADER) +
    '</body></html>';
  const fixed = fixupProject(project, 'svelte');
  check('both files come back compiling', [
    compiles(fixed.html.split('@@@makeui:file src/App.svelte\n')[1].split('@@@makeui:endfile')[0]),
    compiles(fixed.html.split('@@@makeui:file src/components/Header.svelte\n')[1].split('@@@makeui:endfile')[0]),
  ], [null, null]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
