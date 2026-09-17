// The stylesheet contract has to be written in the framework it is given to.
//
// It was one constant, written in React — `className`, `style={{…}}` — and it
// landed for React and for nothing else. Measured across nine runs of one brief:
//
//     React   globals.css 21-27k, 116-160 rules, scoped blocks  0
//     Vue     globals.css  6-12k,  13- 77 rules, scoped 17-23k over  6-12 blocks
//     Svelte  globals.css  0-10k,   0- 53 rules, scoped 16-31k over  9-16 blocks
//
// Vue and Svelte were not writing less CSS than React. They were writing more of
// it, once per component, because both scope a component's <style> and that
// makes it the obvious place to put styling. The contract never said not to — it
// said the stylesheet was the design, which reads as satisfied when the styling
// is in a stylesheet somewhere. One Svelte run shipped no globals.css at all.
//
//   node test/stylesheet-contract.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/orchestration/graph.ts')}" --bundle --platform=node --format=esm ` +
    `--loader:.txt=text --outfile="${path.join(root, 'dist/sc-graph.test.mjs')}" ` +
    `--external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'inherit', cwd: root }
);
const { stylesheetContract, projectContract } = await import(pathToFileURL(path.join(root, 'dist/sc-graph.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const react = stylesheetContract('react');
const vue = stylesheetContract('vue');
const svelte = stylesheetContract('svelte');

// The part every framework shares — the reason the contract exists at all.
for (const [kind, text] of [['react', react], ['vue', vue], ['svelte', svelte]]) {
  check(`${kind}: names the stylesheet`, text.includes('src/styles/globals.css'), true);
  check(`${kind}: asks for 80+ rules`, /80\+/.test(text), true);
  check(`${kind}: asks for interaction states`, text.includes(':focus-visible'), true);
  check(`${kind}: rules out inline styling`, text.includes('Inline styles are only for values that come from DATA'), true);
}

// The class attribute, in each framework's own spelling. A contract that shows a
// Vue developer `className` is teaching a mistake in the course of correcting one.
check('react is shown className', react.includes('<article className="card card--product">'), true);
check('vue is shown class', vue.includes('<article class="card card--product">'), true);
check('svelte is shown class', svelte.includes('<article class="card card--product">'), true);
check('vue is never shown className', /className/.test(vue), false);
check('svelte is never shown className', /className/.test(svelte), false);

// The bad example has to be in the framework's own syntax too, or it reads as a
// rule about some other language.
check('react is shown a JSX inline style', react.includes('style={{ padding: 16'), true);
check('vue is shown an attribute inline style', vue.includes('style="padding: 16px'), true);

// The scoped-style section: the finding this change was made for.
for (const [kind, text] of [['vue', vue], ['svelte', svelte]]) {
  check(`${kind}: is told a scoped block is not where the design lives`,
    text.includes('A SCOPED <style> BLOCK IS NOT WHERE THE DESIGN LIVES'), true);
  // The numbers, not just the rule. "Do not scope your styles" is an opinion;
  // "you wrote 23k of scoped CSS against React's 0 and no two screens agreed" is
  // the reason, and the reason is the part that survives paraphrase.
  check(`${kind}: is given the measurement rather than an assertion`,
    /Vue\s+globals\.css\s+6–12k/.test(text) && /Svelte\s+globals\.css\s+0–10k/.test(text), true);
  check(`${kind}: is told what a scoped block IS for`,
    text.includes('only for layout that genuinely belongs to this one component'), true);
  check(`${kind}: is named as itself`,
    text.includes(kind === 'vue' ? 'Vue scopes a component' : 'Svelte scopes a component'), true);
}

// React has no scoped block to misuse, and telling it not to use one would be
// an instruction about a feature the framework does not have.
check('react is not given the scoped section',
  react.includes('A SCOPED <style> BLOCK IS NOT WHERE THE DESIGN LIVES'), false);

// --- the structural contract, in the framework's own file names ---------------
// PROJECT_CONTRACT was one constant naming App.tsx, src/main.tsx,
// src/store/AppProvider.tsx, useReducer and useApp(), plus a React icon
// component as its one worked example — all of it handed to every Vue and
// Svelte generation.
//
// Measured on v144, from the section at the very top of that text ("THE SHELL
// CARRIES THE NAVIGATION"): React rendered NAV_ITEMS in its shell — badly, but
// it rendered it. Vue and Svelte declared NAV_ITEMS in routes.ts, used it
// nowhere, and put a footer of href="#" links where the navigation should have
// been. Both reported `shell-without-nav`, and both were still reporting it
// after three repair passes.
const contracts = { react: projectContract('react'), vue: projectContract('vue'), svelte: projectContract('svelte') };

// The instruction itself is the same for everyone — only the nouns change.
for (const [kind, text] of Object.entries(contracts)) {
  check(`${kind}: the shell is told to carry the navigation`,
    text.includes('THE SHELL CARRIES THE NAVIGATION'), true);
  check(`${kind}: names its own shell file`, text.includes(`App${kind === 'react' ? '.tsx' : kind === 'vue' ? '.vue' : '.svelte'}`), true);
  check(`${kind}: names its own entry`,
    text.includes(kind === 'react' ? 'src/main.tsx' : 'src/main.ts'), true);
}

// Nothing from another framework may survive into a Vue or Svelte contract. The
// worked example matters most of the three: it is the most concrete thing in
// several thousand words, so it is what gets copied.
for (const kind of ['vue', 'svelte']) {
  const text = contracts[kind];
  check(`${kind}: no .tsx path anywhere`, /[A-Za-z]+\.tsx/.test(text), false);
  check(`${kind}: no className`, /className/.test(text), false);
  check(`${kind}: no useReducer or useApp()`, /useReducer|useApp\(\)/.test(text), false);
  check(`${kind}: no AppProvider`, /AppProvider/.test(text), false);
}

// Each gets an icon example it could actually paste.
check('vue: the icon example is an SFC',
  /CalendarIcon\.vue/.test(contracts.vue) && /<script setup lang="ts">/.test(contracts.vue), true);
check('vue: and uses Vue attribute syntax',
  /stroke-width="1.5"/.test(contracts.vue) && /:width="size"/.test(contracts.vue), true);
check('svelte: the icon example is a Svelte component',
  /CalendarIcon\.svelte/.test(contracts.svelte) && /\$props\(\)/.test(contracts.svelte), true);
check('react: the icon example is still JSX',
  /export function CalendarIcon/.test(contracts.react) && /strokeWidth=\{1\.5\}/.test(contracts.react), true);

// React keeps its own idioms — those are not leftovers, they are correct there.
check('react: still names its own store', /AppProvider/.test(contracts.react), true);
check('react: still names useReducer', /useReducer/.test(contracts.react), true);

// The store sentence takes the framework's own mechanism.
check('vue: the store is described as reactive',
  /reactive\(\)/.test(contracts.vue), true);
check('svelte: the store is described with runes',
  /\$state/.test(contracts.svelte), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
