# MakeUI

自然言語から、**そのまま開発を続けられる**マルチ画面の UI プロジェクトを生成する
SaaS です。出力は React / Vue のいずれかで、スクリーンショットではなく
`npm install` して続きが書けるファイル一式を返します。

AWS 上で動作します（Bedrock AgentCore Runtime / Memory / Browser、Bedrock
Knowledge Base、Guardrails、Cognito、CloudFront）。

---

## リポジトリ構成

```
├── backend/            AgentCore Runtime と API Lambda（TypeScript）
│   ├── src/
│   │   ├── handlers/       API Lambda・Runtime・ジョブ実行
│   │   ├── orchestration/  生成・編集の手順（generate / edit / repair / audit / presets / prompts）
│   │   ├── services/       プロジェクト・バージョン履歴・チャット・使用量・S3 保存
│   │   ├── tools/          転送形式とコンパイラ、決定的修復、写真、AgentCore Browser / Memory / KB
│   │   ├── config/         フレームワーク表、effort、モデル、料金、SSM
│   │   └── utils/          画像入力、添付データ、ログなど
│   ├── scripts/        運用・計測スクリプト（一覧は scripts/README.md）
│   └── test/           単体テスト（`npm test` がディレクトリを走査）
├── frontend/           React SPA（Vite）
│   ├── src/
│   │   ├── auth/           Cognito とログイン画面
│   │   ├── components/     画面ごとのフォルダ（project-list / workspace / version-diff / admin / common）
│   │   ├── hooks/          生成・編集・履歴・使用量・管理
│   │   └── utils/          役割ごとのフォルダ（preview / editing / chat / projects / requests / motion …）
│   └── test/           単体テスト（`npm test`）
├── infrastructure/     CloudFormation、CI/CD、セットアップスクリプト
│   └── buildspec/          CodeBuild の4ステージ
└── docs/               設計・構成・運用の説明資料
```

## ドキュメント

| | |
|---|---|
| [docs/00_overview.md](./docs/00_overview.md) | 全体像とリソース一覧 |
| [docs/01_prerequisites.md](./docs/01_prerequisites.md) | 前提条件 |
| [docs/02_infrastructure.md](./docs/02_infrastructure.md) | インフラ構築手順 |
| [docs/03_configuration.md](./docs/03_configuration.md) | 設定（SSM、モデル、プリセット） |
| [docs/04_backend.md](./docs/04_backend.md) | 生成パイプライン、監査、決定的修復 |
| [docs/05_frontend.md](./docs/05_frontend.md) | フロントエンド構成 |
| [docs/06_startup_and_test.md](./docs/06_startup_and_test.md) | 起動・デプロイ・動作確認 |
| [docs/07_cicd.md](./docs/07_cicd.md) | CI/CD パイプラインとデプロイ手順 |
| [docs/08_agentcore_strands.md](./docs/08_agentcore_strands.md) | AgentCore と Strands の設計 |
| [docs/DESIGN.md](./docs/DESIGN.md) | システム設計書（詳細） |
| [backend/scripts/README.md](./backend/scripts/README.md) | 運用・計測スクリプトの一覧と使い方 |

はじめて読む場合は `docs/00_overview.md` から。

---

## 動かす

### 前提

Node.js 22 以上、AWS CLI v2、対象アカウントへの認証情報。詳細は
[docs/01_prerequisites.md](./docs/01_prerequisites.md)。

### ローカル開発

```bash
cd backend  && npm ci && npm test
cd frontend && npm ci && npm run dev
```

`npm test` は両方ともディレクトリを走査します。テストファイルを追加したら、
どこかのリストに登録する必要はありません（登録漏れで CI が22スイート中20しか
実行していなかったことがあり、いまは走査に変えてあります）。

### デプロイ

**push すればデプロイされます。**

```bash
git add -A && git commit -m "..." && git push
```

CodePipeline が ビルド → テスト → バックエンド配備 → フロントエンド配備 →
スモークテストの順に走ります。手順とトラブルシュートは
[docs/07_cicd.md](./docs/07_cicd.md)。

> **注意.** AgentCore Runtime を更新すると、**実行中の生成ジョブは落ちます**。
> 検証を回す前にパイプラインがアイドルであることを確認してください。

---

## 設計上の要点

この製品の難しさは「LLM に UI を書かせること」ではなく、**書かせたものが本当に
表示されると保証すること**にあります。生成物は一体としてコンパイルされるため、
1ファイルでも壊れていれば全画面が消えます。

そのため次の層を重ねています。

1. **決定的修復**（`backend/src/tools/fixups/framework-fixups.ts`）— モデル呼び出しなしで
   直せる既知の書き方を直す。実測で真っ白な画面を出した書き方だけが入っています。
   生成の組み立て後・修復候補の判定前・編集の後の3か所で走ります
2. **コンパイル関門** — 生成物を実際にビルドする
3. **ブラウザ検証**（AgentCore Browser）— 実際に描画し、押し、色を測る
4. **要件の照合** — 依頼文から Haiku が抜き出した要件（表示する文言・場所・キー操作・画面）を、
   完成したソースに対して機械的に確かめる。確かめられないものは「確認できない」と言う
5. **修復パス** — 監査と要件の照合が挙げた欠陥をモデルに直させ、**同じ計測器で測り直して、
   利用者への影響で重み付けした不備が減ったときだけ**採用する
6. **最後の砦** — それでもビルドできないコンポーネントは、プレースホルダに差し替えて
   **アプリ全体は動かす**

6 が要点です。1〜5 は既知の失敗を潰しますが、既知の一覧は完成しません。
実測で保存済み文書 **60件中60件が描画**します（うち58件はスタブなし）。

詳細と、各判断の根拠になった実測値は [docs/04_backend.md](./docs/04_backend.md)。

> **計測値の比較に注意.** 2026-09-13 に、ブラウザ検証の誤検知の修正（スコアの基準 `SCORE_RUBRIC` 3→4）と
> 修復判定の重み付けが入りました。スコア・修復の受理率・欠陥の修正率は、この日の前後で
> そのまま比べられません。管理画面とチャットは、古い基準のスコアに「旧基準」と表示します。

---

## ライセンス

[MIT License](./LICENSE) です。

デザインプリセットには、Carbon Design System・Material Design 3（Apache License 2.0）、
デジタル庁デザインシステム・Spindle（MIT License）が公開しているトークン値を含みます。
出典とライセンスは [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) にまとめています。

> **注意.** MakeUI は、Carbon（IBM）、Material Design（Google）、Spindle（CyberAgent / Ameba）、
> デジタル庁デザインシステム（デジタル庁）の公式プロジェクトではなく、各権利者による承認や
> 提携を受けたものでもありません。各名称は、それぞれの権利者の商標または登録商標です。
