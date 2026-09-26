// A glyph on the button whose label already says what the glyph would say.
//
// `icons` is the second largest source-visible finding: 22 of 76 stored
// documents render nothing from src/components/icons/. Its own instruction
// names four places a glyph could go — 「ナビ・ボタン・空状態・ステータス表示」 —
// and a user reported two of the four going wrong on one storefront: a
// magnifier centred on a product photograph, and another in an empty cart. A
// project holding ONE icon reaches for it wherever it wants a graphic.
//
// So: buttons only, and only where the pairing is not a judgement.
//
// MEASURED TWICE. A first table reached 4 of 12 documents and paired 戻る with
// CloseIcon — 戻る is "back", not "close". Separated and re-read pairing by
// pairing rather than counted: 5 of 22 documents, 9 pairings, all correct. The
// reason 5 is so low is that 13 of the 22 have no icon FILES to pair with;
// writing the glyph the pairing needs takes it to 17 of 22 and 53 pairings,
// every one of them read. Run through the whole pass the finding goes from 12
// to 1 of 34 and 10 to 1 of 41.
//
//   node test/action-icons.test.mjs      (from backend/)
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { fixupsEntry, readFixups } from './lib/fixups-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = async (entry, out) => {
  await esbuild.build({
    entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'esm',
    outfile: path.join(root, out), external: ['@aws-sdk/*', '@smithy/*'], logLevel: 'error',
  });
  return import(pathToFileURL(path.join(root, out)).href);
};
const ai = await build('src/tools/fixups/action-icons.ts', 'dist/ai.test.mjs');
const fx = await build(fixupsEntry(), 'dist/aif.test.mjs');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};
const files = (o) => new Map(Object.entries(o));
const screen = (buttons) => files({
  'src/styles/globals.css': ':root { --c: #06c; }',
  'src/screens/A.tsx': `export default function A() {\n  return (<div>\n${buttons}\n  </div>);\n}`,
});
const glyphsIn = (r, file = 'src/screens/A.tsx') =>
  [...(r.files.get(file) ?? '').matchAll(/<(\w+Icon) \/>/g)].map((m) => m[1]);

// --- the vocabulary, read rather than counted ------------------------------
const PAIRS = [
  ['保存', 'CheckIcon'], ['確定する', 'CheckIcon'], ['適用', 'CheckIcon'],
  ['キャンセル', 'CloseIcon'], ['閉じる', 'CloseIcon'], ['取り消し', 'CloseIcon'],
  ['戻る', 'ChevronLeftIcon'], ['ホームに戻る', 'ChevronLeftIcon'], ['前へ', 'ChevronLeftIcon'],
  ['次へ', 'ChevronRightIcon'],
  ['検索', 'SearchIcon'], ['絞り込む', 'FilterIcon'],
  ['追加', 'PlusIcon'], ['新規作成', 'PlusIcon'], ['登録する', 'PlusIcon'],
  ['カートに追加', 'CartIcon'], ['削除', 'TrashIcon'], ['編集', 'EditIcon'],
  ['設定', 'SettingsIcon'], ['ダウンロード', 'DownloadIcon'],
];
for (const [label, want] of PAIRS) {
  const r = fx.fixIconsNotDrawn(screen(`    <button onClick={go}>${label}</button>`), 'react');
  check(`${label} takes ${want}`, glyphsIn(r), [want]);
}
// The pairing the first table got wrong, stated as its own check.
check('戻る is not close', ai.ACTION_GLYPHS.find((g) => g.label.test('戻る')).name, 'ChevronLeftIcon');

// --- which way round -------------------------------------------------------
// 「次へ →」 reads; 「→ 次へ」 does not. 「← 戻る」 reads; 「戻る ←」 does not.
{
  const r = fx.fixIconsNotDrawn(screen(
    '    <button onClick={a}>次へ</button>\n    <button onClick={b}>戻る</button>'), 'react');
  const body = r.files.get('src/screens/A.tsx') ?? '';
  check('a forward chevron follows the label', /次へ<ChevronRightIcon \/>/.test(body), true);
  check('and a back chevron leads it', /<ChevronLeftIcon \/>戻る/.test(body), true);
}

// --- what must not be given one --------------------------------------------
check('a label this file has no word for is left alone',
  fx.fixIconsNotDrawn(screen('    <button onClick={go}>詳しく見る</button>'), 'react').fixed, []);
// The label must be the whole button. 「削除しますか」 in a dialog is not a
// delete button, and a button with structure in it is a layout this cannot see.
check('a label that only starts with an action word is not one',
  fx.fixIconsNotDrawn(screen('    <button onClick={go}>本当に削除しますか、確認してください</button>'), 'react').fixed, []);
check('a button with an element inside it is left alone',
  fx.fixIconsNotDrawn(screen('    <button onClick={go}><span>保存</span></button>'), 'react').fixed, []);
check('and one with an interpolated label',
  fx.fixIconsNotDrawn(screen('    <button onClick={go}>{label}</button>'), 'react').fixed, []);
// A project already rendering a glyph is not the project this reports on.
check('a project already drawing an icon is left alone', fx.fixIconsNotDrawn(files({
  'src/components/icons/HomeIcon.tsx': 'export default () => <svg/>;',
  'src/screens/A.tsx': "import HomeIcon from '../components/icons/HomeIcon';\nexport default () => (<div><HomeIcon /><button onClick={go}>保存</button></div>);",
}), 'react').fixed, []);

// --- the project's own glyph comes first ------------------------------------
{
  const r = fx.fixIconsNotDrawn(files({
    'src/styles/globals.css': ':root { --c: #06c; }',
    'src/components/icons/CheckmarkIcon.tsx': 'export const CheckmarkIcon = () => <svg/>;',
    'src/screens/A.tsx': 'export default () => (<div><button onClick={go}>保存</button></div>);',
  }), 'react');
  check('the glyph the project drew is used', glyphsIn(r), ['CheckmarkIcon']);
  check('and imported by name, as it is exported',
    /import \{ CheckmarkIcon \} from '\.\.\/components\/icons\/CheckmarkIcon'/.test(r.files.get('src/screens/A.tsx') ?? ''), true);
  check('no new file is written for it',
    r.files.has('src/components/icons/CheckIcon.tsx'), false);
}
// And when it drew nothing, the glyph is written — to the contract the
// instruction already states.
{
  const r = fx.fixIconsNotDrawn(screen('    <button onClick={go}>保存</button>'), 'react');
  const glyph = r.files.get('src/components/icons/CheckIcon.tsx') ?? '';
  check('a missing glyph is written', glyph.length > 0, true);
  check('24x24, stroked, no fill',
    /viewBox="0 0 24 24"[\s\S]*fill="none"[\s\S]*stroke="currentColor"[\s\S]*strokeWidth="1.5"/.test(glyph), true);
  check('hidden from a screen reader, because the label says it',
    /aria-hidden="true"/.test(glyph), true);
  // Sized in em: these projects set their buttons from 13px to 16px.
  check('and sized to the text beside it', /width="1.15em"/.test(glyph), true);
  check('it is a default export, and imported as one',
    /export default function CheckIcon/.test(glyph)
    && /import CheckIcon from '\.\.\/components\/icons\/CheckIcon'/.test(r.files.get('src/screens/A.tsx') ?? ''), true);
}

// --- one decision per label -------------------------------------------------
// Every 保存 button in the project gets the same treatment, or the screens
// disagree with each other about what a save button looks like.
{
  const r = fx.fixIconsNotDrawn(files({
    'src/styles/globals.css': ':root { --c: #06c; }',
    'src/screens/A.tsx': 'export default () => (<div><button onClick={a}>保存</button><button onClick={b}>保存</button></div>);',
    'src/screens/B.tsx': 'export default () => (<button onClick={c}>保存</button>);',
  }), 'react');
  check('every button with that label is treated the same', glyphsIn(r).length, 2);
  check('across files too', glyphsIn(r, 'src/screens/B.tsx'), ['CheckIcon']);
  check('and the import is written once per file',
    ((r.files.get('src/screens/A.tsx') ?? '').match(/^import /gm) ?? []).length, 1);
}

// --- the rule that lines it up ----------------------------------------------
// An inline <svg> sits on the text's baseline rather than beside it, which is
// worse than the finding. One rule, because the class names differ per preset.
{
  const r = fx.fixIconsNotDrawn(screen('    <button onClick={go}>保存</button>'), 'react');
  const css = r.files.get('src/styles/globals.css') ?? '';
  check('a rule is written for buttons that now hold a drawing',
    /button:has\(> svg\)/.test(css), true);
  check('with the gap and the alignment', /align-items: center;\n  gap: 0\.4em;/.test(css), true);
  check('and it is written once', (css.match(/makeui:icon-buttons/g) ?? []).length, 1);
}

// --- Vue --------------------------------------------------------------------
{
  const r = fx.fixIconsNotDrawn(files({
    'src/styles/globals.css': ':root { --c: #06c; }',
    'src/screens/A.vue': '<template>\n  <button @click="go">保存</button>\n</template>\n',
  }), 'vue');
  const body = r.files.get('src/screens/A.vue') ?? '';
  check('a Vue button gets the glyph', /<CheckIcon \/>保存/.test(body), true);
  check('with the import in a script setup block',
    /<script setup lang="ts">\nimport CheckIcon from '\.\.\/components\/icons\/CheckIcon';/.test(body), true);
  check('and the glyph is a Vue single-file component',
    /^<template>/.test(r.files.get('src/components/icons/CheckIcon.vue') ?? ''), true);
  check('with kebab-case attributes',
    /stroke-width="1.5"/.test(r.files.get('src/components/icons/CheckIcon.vue') ?? ''), true);
}

// --- the wiring ---------------------------------------------------------------
import fs from 'node:fs';
const src = readFixups();
check('the project pass runs it', src.includes('apply(fixIconsNotDrawn(files, kind))'), true);
// After the artwork, which is the other pass that reads the markup: a button
// given a glyph is not a place an illustration would have gone.
check('and after the drawing',
  src.indexOf('apply(fixArtworkNotDrawn(files, kind))') < src.indexOf('apply(fixIconsNotDrawn(files, kind))'), true);
// The contract now names the two places a glyph must not go.
const prompt = fs.readFileSync(path.join(root, 'src/orchestration/prompts/prompt-contracts.ts'), 'utf8');
check('the build is told not to put one on a photograph', /ON A PHOTOGRAPH/.test(prompt), true);
check('nor to use one as an empty state', /AS AN EMPTY STATE'S PICTURE/.test(prompt), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
