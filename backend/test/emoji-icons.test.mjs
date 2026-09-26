/**
 * Emoji out of a generated UI, without asking a model.
 *
 * A model fixed `emoji` 6 times in 40, and 15 of the 80 most recent documents in
 * S3 shipped with it. Replayed over those 80 (2026-09-14): 15 -> 0 documents
 * carrying the finding, 33 files rewritten, 25 glyphs drawn as icons and 15
 * removed, and no file that parsed before stopped parsing. The fixtures below are
 * the shapes those 38 occurrences took, copied from the documents.
 *
 *   node test/emoji-icons.test.mjs      (from backend/)
 */
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { readFixups } from './lib/fixups-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/tools/fixups/emoji-icons.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/emoji-icons.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const { replaceEmoji } = await import(pathToFileURL(path.join(root, 'dist/emoji-icons.test.mjs')).href);
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
};
const EMOJI = /[\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2705}\u{274C}\u{FE0F}]/u;

// --- an icon slot holding a glyph becomes a drawing -----------------------------------------
const slot = replaceEmoji('src/screens/ItemsScreen.tsx', '<div className="empty-icon">📋</div>', 'react');
check('a glyph-only element is drawn as an icon', /^<div className="empty-icon"><svg [^>]*><path d="[^"]+" \/><\/svg><\/div>$/.test(slot.body), true);
check('in JSX the stroke attributes are camelCase', /strokeWidth="1\.5"/.test(slot.body) && !/stroke-width/.test(slot.body), true);
check('and hidden from assistive technology', /aria-hidden="true"/.test(slot.body), true);
check('counted as drawn', [slot.replaced, slot.removed], [1, 0]);

const vue = replaceEmoji('src/screens/RankingScreen.vue', '<div class="empty-state-icon">📊</div>', 'vue');
check('in a Vue template they are kebab-case', /stroke-width="1\.5"/.test(vue.body) && !/strokeWidth/.test(vue.body), true);

const trash = replaceEmoji('src/screens/CartScreen.tsx', '<button aria-label={`${item.name}を削除`}>\n  🗑\n</button>', 'react');
const gear = replaceEmoji('src/components/ui/Header.tsx', '<span className="logo-icon">⚙</span>', 'react');
check('the drawing follows what the glyph depicts', trash.body.includes('M4 7h16') && gear.body.includes('M12 15a3 3'), true);
check('a glyph nothing matches still gets a drawing, not a hole', replaceEmoji('src/App.tsx', '<i>🦄</i>', 'react').body.includes('<svg'), true);

// --- a glyph in front of a label is removed -------------------------------------------------
const label = replaceEmoji('src/screens/DashboardScreen.tsx', '<button aria-label="CSVでダウンロード"> 📥 CSVエクスポート </button>', 'svelte');
check('a glyph before a label is removed with its space', label.body, '<button aria-label="CSVでダウンロード"> CSVエクスポート </button>');
check('counted as removed', [label.replaced, label.removed], [0, 1]);
check('in a heading too', replaceEmoji('src/App.vue', '<h1 class="logo">📊 売上分析</h1>', 'vue').body, '<h1 class="logo">売上分析</h1>');
check('and in a string a component renders', replaceEmoji('src/data/nav.ts', "export const NAV = [{ label: '📅 予定' }]", 'react').body, "export const NAV = [{ label: '予定' }]");
check('a `.ts` module never gets markup', /svg/.test(replaceEmoji('src/lib/cmp.ts', "if (a >✅< b) {}", 'react').body), false);

// --- what is left alone --------------------------------------------------------------------
check('rating stars are typesetting, not emoji', replaceEmoji('src/screens/Review.tsx', '<span>★★★☆☆</span>', 'react').body, '<span>★★★☆☆</span>');
check('a warning sign likewise', replaceEmoji('src/screens/Alert.tsx', '<p>⚠ 在庫が不足しています</p>', 'react').body, '<p>⚠ 在庫が不足しています</p>');
check('a stylesheet is not the UI', replaceEmoji('src/styles/globals.css', '.x::before { content: "✅"; }', 'react').body, '.x::before { content: "✅"; }');
check('nor is prose', replaceEmoji('docs/design-guidelines.md', '❌ Emoji as icons', 'react').body, '❌ Emoji as icons');
check('a file with none is returned unchanged', replaceEmoji('src/App.tsx', '<main>在庫</main>', 'react'), { body: '<main>在庫</main>', replaced: 0, removed: 0 });

const mixed = replaceEmoji('src/screens/DealScreen.tsx', '<div class="toast"> ✅ 株式会社ソルテックの金額を更新しました</div>\n<div class="icon">📭</div>', 'svelte');
check('no emoji survive a mixed file', EMOJI.test(mixed.body), false);

// --- wiring ---------------------------------------------------------------------------------
const fixups = readFixups();
check('it runs inside fixupProject, so after the build, before judging a repair, and after an edit',
  /export function fixupProject[\s\S]*for \(const \[path, body\] of readProjectFiles\(out\)\) \{\s*const e = replaceEmoji\(path, body, kind\)/.test(fixups), true);
check('last, on the files as the other fixups left them', fixups.lastIndexOf('replaceEmoji(path, body, kind)') > fixups.lastIndexOf('const r = fixupFile(kind, path, body)'), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
