import type { VFile } from './virtualFs';
import { detectKind, type OutputKind } from './frameworkKind';

/**
 * Wraps the generated sources in everything that makes a directory a project.
 *
 * The model emits application code and nothing else, deliberately: the manifest,
 * the build config, the entry document and the ignore file are identical every
 * time, easy to get subtly wrong, and would cost output tokens on every single
 * generation to reproduce. They are cheaper and more reliable here.
 *
 * This used to be React-only — one `hasReact` test at the top and an early
 * return for everything else. So a Vue project downloaded as bare
 * `src/` with no package.json, no vite config, no entry document and no readme:
 * not a project a developer could continue, just a folder of files. The `npm
 * install && npm run dev` the readme promised had nothing to install and nothing
 * to run.
 *
 * The other half of that failure was quieter and would have survived adding a
 * manifest. The entry document hard-coded `<div id="root">`, which is React's
 * convention; Vue mounts on `#app`. A downloaded Vue
 * project therefore built, served, and rendered a blank page — the preview hid
 * it, because the preview injects its own mount element. The root id is now read
 * from the project's own entry file, so the document matches the code rather
 * than a convention.
 */

/** Everything that differs between the three frameworks, in one place. */
interface Scaffold {
  /** Element the app mounts into when the entry file does not say. */
  defaultRoot: string;
  /** Runtime dependencies. */
  dependencies: Record<string, string>;
  /** Build-time dependencies, before TypeScript's own are added. */
  devDependencies: Record<string, string>;
  /** The `typecheck` script, which is not `tsc --noEmit` for every framework. */
  typecheck: string;
  /** vite.config.ts, verbatim. */
  viteConfig: string;
  /** Extra compilerOptions this framework's files need. */
  compilerOptions: Record<string, unknown>;
  /** Files only this framework needs. */
  extraFiles?: VFile[];
  /** The readme's "what to edit next" section. */
  guide: (ext: string) => string;
}

const REACT: Scaffold = {
  defaultRoot: 'root',
  dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
  devDependencies: { '@vitejs/plugin-react': '^4.3.4', vite: '^6.0.7' },
  typecheck: 'tsc --noEmit',
  viteConfig: `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
});
`,
  compilerOptions: { jsx: 'react-jsx' },
  guide: (ext) => `- **画面を追加する**: \`src/screens/\` に \`<名前>Screen.${ext}\` を作り、
  \`src/routes.ts\` の \`ScreenId\` と \`NAV_ITEMS\`、\`src/App.${ext}\` の分岐に追加します。
- **ルーティングを本格化する**: \`src/hooks/useNavigation.ts\` は hash ルーターです。
  React Router に置き換える場合、\`Route\` 型はそのまま流用できます。`,
};

const VUE: Scaffold = {
  defaultRoot: 'app',
  dependencies: { vue: '^3.5.13' },
  devDependencies: { '@vitejs/plugin-vue': '^5.2.1', vite: '^6.0.7' },
  // `tsc` cannot read a .vue file. vue-tsc is the same compiler with the SFC
  // reader attached, and leaving it as `tsc --noEmit` means `npm run typecheck`
  // silently checks none of the components.
  typecheck: 'vue-tsc --noEmit',
  viteConfig: `import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
});
`,
  compilerOptions: { jsx: 'preserve' },
  extraFiles: [
    {
      path: 'src/vue-shims.d.ts',
      lang: 'ts',
      // Without this, every `import X from './X.vue'` is an unresolved module to
      // TypeScript — the build runs, the editor is red, and `npm run typecheck`
      // fails on files that are correct.
      content: `declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<{}, {}, any>;
  export default component;
}
`,
    },
  ],
  guide: () => `- **画面を追加する**: \`src/screens/\` に \`<名前>Screen.vue\` を作り、
  \`src/routes.ts\` の \`ScreenId\` と \`NAV_ITEMS\`、\`src/App.vue\` の分岐に追加します。
- **ルーティングを本格化する**: \`src/composables/useNavigation.ts\` は hash ルーターです。
  vue-router に置き換える場合、\`Route\` 型はそのまま流用できます。`,
};

const SCAFFOLDS: Record<OutputKind, Scaffold> = { react: REACT, vue: VUE };

/** Derive an npm-safe package name from the document title. */
function packageName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'makeui-app';
}

/**
 * The element the app actually mounts into, read from the entry file.
 *
 * `createRoot(document.getElementById('root'))`, `createApp(App).mount('#app')`
 * and `mount(App, { target: document.getElementById('app') })` all name it, and
 * the entry document has to agree with whichever one the project wrote — an id
 * that does not match is a project that builds, serves and renders nothing.
 */
function rootId(entry: string | undefined, fallback: string): string {
  if (!entry) return fallback;
  const byId = entry.match(/getElementById\(\s*['"]([\w-]+)['"]/);
  if (byId) return byId[1];
  const bySelector = entry.match(/(?:mount|querySelector)\(\s*['"]#([\w-]+)['"]/);
  if (bySelector) return bySelector[1];
  return fallback;
}

/** The project's entry module, whatever this framework calls it. */
function entryFile(sources: VFile[]): VFile | undefined {
  return sources.find((f) => /^src\/(main|index)\.(tsx|ts|jsx|js)$/.test(f.path));
}

const TREE_NOTES: Record<string, string> = {
  'src/screens': '画面コンポーネント（1画面1ファイル）',
  'src/components/ui': '再利用するUI部品（Button, Card, Modal …）',
  'src/components/icons': 'アイコン（インライン SVG）',
  'src/components/illustrations': '図版・空状態のイラスト（インライン SVG）',
  'src/components': '共通コンポーネント',
  'src/hooks': 'カスタムフック（useNavigation など）',
  'src/composables': 'コンポーザブル（useNavigation など）',
  'src/store': '全画面で共有する状態',
  'src/lib': '純粋なヘルパー・共有ロジック',
  'src/data': '型付きモックデータ',
  'src/styles': 'スタイルとデザイントークン',
  'src/types': '共通の型定義',
  docs: 'デザインガイドラインなどのドキュメント',
};

/**
 * The readme's structure section, written from the files that are really there.
 *
 * The previous version carried two hand-maintained trees and chose between them
 * with a `legacyLayout` flag, so it described a layout the project might not
 * have. Reading the directories back is both shorter and correct by
 * construction.
 */
function describeTree(sources: VFile[], entry: string): string {
  const dirs = new Set<string>();
  for (const f of sources) {
    const i = f.path.lastIndexOf('/');
    if (i > 0) dirs.add(f.path.slice(0, i));
  }
  const lines = [`- \`${entry}\` — エントリーポイント`];
  const shell = sources.find((f) => /^src\/App\.(tsx|jsx|vue)$/.test(f.path));
  if (shell) lines.push(`- \`${shell.path}\` — シェルと画面の切り替え`);
  if (sources.some((f) => f.path === 'src/routes.ts')) {
    lines.push('- `src/routes.ts` — 画面 ID・ルート・ナビゲーション定義');
  }
  for (const dir of [...dirs].sort()) {
    const note = TREE_NOTES[dir];
    if (note) lines.push(`- \`${dir}/\` — ${note}`);
  }
  return lines.join('\n');
}

/**
 * Turn extracted sources into a project a developer can clone into and continue.
 *
 * Returns the input untouched when the files are not a project this understands,
 * which is the honest answer for a document stored before the project formats
 * existed: adding a Vite manifest around a single HTML page would describe a
 * build that does not work.
 */
export function toProjectFiles(files: VFile[], title = 'MakeUI App'): VFile[] {
  const kind = detectKind(files);
  if (!kind) return files;
  const spec = SCAFFOLDS[kind];

  const sources = files.filter((f) => f.path !== 'index.html');
  const entry = entryFile(sources);
  const entryPath = entry?.path ?? (kind === 'react' ? 'src/main.tsx' : 'src/main.ts');
  const mount = rootId(entry?.content, spec.defaultRoot);
  const ext = kind === 'react' ? 'tsx' : kind;
  const name = packageName(title);

  const scaffold: VFile[] = [
    {
      path: 'index.html',
      lang: 'html',
      content: `<!DOCTYPE html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
  </head>
  <body>
    <div id="${mount}"></div>
    <script type="module" src="/${entryPath}"></script>
  </body>
</html>
`,
    },
    {
      path: 'package.json',
      lang: 'json',
      content: `${JSON.stringify(
        {
          name,
          private: true,
          version: '0.1.0',
          type: 'module',
          scripts: {
            dev: 'vite',
            // Deliberately not `tsc -b && vite build`. A type error in generated
            // code should not stop a developer from seeing the app run; the type
            // check is its own script, so it is available without being a gate
            // on the first thing anyone tries.
            build: 'vite build',
            preview: 'vite preview',
            typecheck: spec.typecheck,
          },
          ...(Object.keys(spec.dependencies).length ? { dependencies: spec.dependencies } : {}),
          devDependencies: {
            ...spec.devDependencies,
            typescript: '^5.7.0',
            // `vite.config.ts` is inside the tsconfig's `include`, and Vite's own
            // types reference Node's. Without this, `npm run typecheck` fails on
            // a project with no errors in it: "TS2688: Cannot find type
            // definition file for 'node'".
            '@types/node': '^22.10.0',
            ...(kind === 'react'
              ? { '@types/react': '^18.3.0', '@types/react-dom': '^18.3.0' }
              : {}),
            ...(kind === 'vue' ? { 'vue-tsc': '^2.2.0' } : {}),
          },
        },
        null,
        2
      )}
`,
    },
    {
      path: 'vite.config.ts',
      lang: 'ts',
      content: spec.viteConfig,
    },
    {
      path: 'tsconfig.json',
      lang: 'json',
      content: `${JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2020',
            useDefineForClassFields: true,
            lib: ['ES2020', 'DOM', 'DOM.Iterable'],
            module: 'ESNext',
            skipLibCheck: true,
            moduleResolution: 'bundler',
            allowImportingTsExtensions: true,
            resolveJsonModule: true,
            isolatedModules: true,
            noEmit: true,
            strict: true,
            // Off on purpose. Generated code keeps a few unused imports, and a
            // developer opening the project for the first time should not be met
            // by a wall of errors about them.
            noUnusedLocals: false,
            noUnusedParameters: false,
            noFallthroughCasesInSwitch: true,
            ...spec.compilerOptions,
          },
          include: ['src', 'vite.config.ts'],
        },
        null,
        2
      )}
`,
    },
    {
      path: 'src/vite-env.d.ts',
      lang: 'ts',
      content: `/// <reference types="vite/client" />\n`,
    },
    ...(spec.extraFiles ?? []),
    {
      path: '.gitignore',
      lang: 'md',
      content: ['node_modules', 'dist', '.DS_Store', '*.local', '.vite', ''].join('\n'),
    },
    {
      path: '.editorconfig',
      lang: 'md',
      content: `root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 2
insert_final_newline = true
trim_trailing_whitespace = true
`,
    },
  ];

  scaffold.push({
    path: 'README.md',
    lang: 'md',
    content: `# ${title}

MakeUI が生成した ${SCAFFOLD_LABEL[kind]} アプリケーションです。
そのまま \`npm install\` して開発を継続できます。

## セットアップ

\`\`\`bash
npm install
npm run dev
\`\`\`

本番ビルドは \`npm run build\`、型チェックは \`npm run typecheck\` です。

## 構成

${describeTree(sources, entryPath)}

アプリは \`index.html\` の \`<div id="${mount}">\` にマウントされます。

## この先の作業

${spec.guide(ext)}
- **データを実APIに差し替える**: \`src/data/\` はモックです。同じ型を返す
  取得処理に置き換えれば、画面側の変更は不要です。
- **図版を差し替える**: インライン SVG で描いた仮の図版があります。
  実際の画像に置き換える場合は \`src/assets/\` を作り、\`import\` して使ってください。
- **画像の権利**: 埋め込まれている写真はすべて CC0 です。そのまま利用・再配布できます。

## デモアカウント

ログイン画面がある場合、デモ用の認証情報はソース内に定義され、ログイン画面上にも
表示されます。本番化の際は必ず削除してください。
`,
  });

  /*
   * One file per path. A Vue build wrote its own vite.config.ts, package.json and
   * tsconfig.json despite the contract (1 of 4 in September; the backend now
   * drops them), and a project stored before that exports them beside these —
   * two files at one path in the ZIP. The scaffold's copy is the one that matches
   * the preview, so it is the one kept.
   */
  const supplied = new Set(scaffold.map((f) => f.path));
  return [...scaffold, ...sources.filter((f) => !supplied.has(f.path))];
}

const SCAFFOLD_LABEL: Record<OutputKind, string> = {
  react: 'TypeScript React',
  vue: 'Vue 3 + TypeScript',
};
