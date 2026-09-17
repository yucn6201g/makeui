# Third-party notices

MakeUI 自体は [MIT License](./LICENSE) です。このファイルは、リポジトリに含まれる
第三者由来の値と、その出典・ライセンスをまとめたものです。

## デザインシステムのトークン値

デザインプリセットと Knowledge Base 用の資料には、各デザインシステムが公開している
トークン値（色・タイポグラフィ・余白・角丸・影など）を記載しています。資料の文章と
CSS の例は MakeUI 側で書いたもので、公式ドキュメントの文章を転載したものではありません。

| デザインシステム | 値の出典（パッケージ） | ライセンス | 著作権者 |
|---|---|---|---|
| Carbon Design System | `@carbon/themes`、`@carbon/type`、`@carbon/layout` | Apache License 2.0 | IBM Corp. |
| Material Design 3 | `@material/web` | Apache License 2.0 | Google LLC |
| デジタル庁デザインシステム | `@digital-go-jp/design-tokens` | MIT License | デジタル庁 |
| Spindle（Ameba デザインシステム） | `@openameba/spindle-tokens`、`@openameba/spindle-ui` | MIT License | openameba |

含まれている場所:

- `backend/src/orchestration/design-presets.ts`
- `backend/src/orchestration/preset-foundation.ts`
- `frontend/src/utils/presets.ts`
- `knowledge-base-docs/`

各ライセンスの全文は、それぞれのパッケージ（npm レジストリおよび各リポジトリ）に
同梱されています。Apache License 2.0 の全文: https://www.apache.org/licenses/LICENSE-2.0

### 含めていないもの

- **Spindle のアイコン**は CC BY-NC-ND 4.0 のため、リポジトリに含めていません。
  生成プロンプトでも使用を禁じ、自作の線画アイコンを描くよう指示しています。
- 各デザインシステムのロゴ・アイコン画像・フォントファイルは含めていません。

## フォント

生成される UI とプレビューは、IBM Plex、Noto Sans JP、Roboto、Inter を Google Fonts から
**参照**します（いずれも SIL Open Font License 1.1）。フォントファイル自体は
リポジトリに含めていません。

## npm の依存パッケージ

依存パッケージはリポジトリに含めず、`npm ci` で取得します。ライセンスは各パッケージに
従います（2026-09-15 時点で MIT、Apache-2.0、ISC、BSD-2-Clause、BSD-3-Clause、0BSD、
BlueOak-1.0.0 のいずれか）。

ビルド時に `backend/scripts/vendor-react.mjs` が React・Vue・Svelte のブラウザ向けビルドを
バンドルに取り込みます（いずれも MIT License）。取り込んだファイル（`backend/src/vendor/`）は
リポジトリには含めていません。

## 商標

Carbon は IBM Corp.、Material Design は Google LLC、Spindle および Ameba は
株式会社サイバーエージェントの商標または登録商標です。MakeUI はこれらのデザインシステムの
公式プロジェクトではなく、各権利者やデジタル庁による承認・提携を受けたものでもありません。
