// `route-unrendered` fires when the router can parse a ScreenId that App has
// no branch for — the route resolves, App returns nothing, and the user gets
// "render() は呼ばれましたが画面が空です".
//
// It was also wrong every single time it fired. Across the 597-document corpus
// it raised 27 findings and all 27 were correct code:
//
//   9   a Vue `v-else` fallback          — the fallback test knew only React
//   3   a Svelte `{:else}` fallback        spellings, so two of the three
//   3   `return NotFoundScreen;`           frameworks could not express one
//   12  `screenMap = { dashboard: … }`   — a bare object key is not a quoted
//                                          literal, so the ids whose spelling
//                                          happens to be a valid identifier
//                                          were named and the hyphenated ones
//                                          were not
//
// Not one React document ever raised it. That asymmetry was the finding.
//
//   node test/route-unrendered.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/orchestration/audit/interaction-audit.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/ru.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'pipe', cwd: root }
);
const { auditInteractivity } = await import(pathToFileURL(path.join(root, 'dist/ru.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${got}\n      want ${want}`);
  ok ? pass++ : fail++;
};

const fence = (p, body) => `@@@makeui:file ${p}\n${body}\n@@@makeui:endfile\n`;
const ROUTES = fence(
  'src/routes.ts',
  `export type ScreenId = 'dashboard' | 'ranking' | 'category-detail' | 'not-found';\n` +
    `export const NAV_ITEMS = [{ id: 'dashboard', label: 'ダッシュボード', href: '#/' }];`
);
const NAV = fence(
  'src/composables/useNavigation.ts',
  `export const DEFAULT_ROUTE = { screen: 'dashboard' };\n` +
    `export function useNavigation() { window.addEventListener('hashchange', () => {}); return { route: DEFAULT_ROUTE, navigate() {} } }`
);
const raised = (kind, app) =>
  auditInteractivity(
    `<!DOCTYPE html><html><body>\n${ROUTES}${NAV}${fence(`src/App${kind === 'react' ? '.tsx' : kind === 'vue' ? '.vue' : '.svelte'}`, app)}</body></html>`,
    kind
  ).some((d) => d.id === 'route-unrendered');

// ------------------------------------------------------------ the true positive
//
// The document the check was written for: a chain of equality tests that names
// three of the four ids and stops. 'not-found' resolves and renders nothing.
check(
  'a branch chain that forgot an id',
  raised(
    'react',
    `export default function App() {\n` +
      `  return <main>\n` +
      `    {route.screen === 'dashboard' && <DashboardScreen />}\n` +
      `    {route.screen === 'ranking' && <RankingScreen />}\n` +
      `    {route.screen === 'category-detail' && <CategoryDetailScreen />}\n` +
      `  </main>\n}`
  ),
  true
);

// ------------------------------------------------------------ the false positives
check(
  'a Vue v-else is a fallback',
  raised(
    'vue',
    `<template><main>\n` +
      `  <DashboardScreen v-if="route.screen === 'dashboard'" />\n` +
      `  <RankingScreen v-else-if="route.screen === 'ranking'" />\n` +
      `  <NotFoundScreen v-else />\n` +
      `</main></template>`
  ),
  false
);
// `v-else-if` alone is not one — it is another branch, and the chain can still
// end without covering every id.
check(
  'v-else-if alone is not a fallback',
  raised(
    'vue',
    `<template><main>\n` +
      `  <DashboardScreen v-if="route.screen === 'dashboard'" />\n` +
      `  <RankingScreen v-else-if="route.screen === 'ranking'" />\n` +
      `</main></template>`
  ),
  true
);
check(
  'a Svelte {:else} is a fallback',
  raised(
    'svelte',
    `{#if route.screen === 'dashboard'}\n  <DashboardScreen />\n` +
      `{:else if route.screen === 'ranking'}\n  <RankingScreen />\n` +
      `{:else}\n  <NotFoundScreen />\n{/if}`
  ),
  false
);
check(
  'a bare return of a component is a fallback',
  raised(
    'svelte',
    `<script>\n  let screenComponent = $derived.by(() => {\n` +
      `    if (route.screen === 'dashboard') return DashboardScreen;\n` +
      `    if (route.screen === 'ranking') return RankingScreen;\n` +
      `    return NotFoundScreen;\n  });\n</script>\n` +
      `<svelte:component this={screenComponent} />`
  ),
  false
);
check(
  'a map with bare keys covers the ids in it',
  raised(
    'vue',
    `<template><main><component :is="currentScreen" /></main></template>\n` +
      `<script setup lang="ts">\nconst screenMap = {\n` +
      `  dashboard: DashboardScreen,\n  ranking: RankingScreen,\n` +
      `  'category-detail': CategoryDetailScreen,\n  'not-found': NotFoundScreen,\n};\n</script>`
  ),
  false
);
// A shell that renders one screen unconditionally cannot go blank, whatever
// the route says — and it names no id, so the check has nothing to measure.
check(
  'a shell with no branches at all',
  raised('svelte', `<script>\n  import DashboardScreen from './screens/DashboardScreen.svelte';\n</script>\n<main><DashboardScreen /></main>`),
  false
);
// The abstention is not blanket: a map that really is missing an id still has
// the other ids as bare keys, so the finding survives.
check(
  'a map that forgot an id still reports it',
  raised(
    'vue',
    `<template><main><component :is="currentScreen" /></main></template>\n` +
      `<script setup lang="ts">\nconst screenMap = {\n` +
      `  dashboard: DashboardScreen,\n  ranking: RankingScreen,\n` +
      `  'category-detail': CategoryDetailScreen,\n};\n</script>`
  ),
  true
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
