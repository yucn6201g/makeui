# 02. インフラストラクチャ構築

## このステップで行うこと

CloudFormation で基盤リソース（Cognito, CloudFront, DynamoDB, S3）を作成し、AgentCore リソースをセットアップします。

---

## 1. Bedrock モデルアクセスの有効化

1. AWS マネジメントコンソール → **Amazon Bedrock** → **Model access**
2. 以下のモデルにチェックを入れて **Request model access**:
   - Anthropic → Claude Sonnet 4.6（`sonnet`・`default`）
   - Anthropic → Claude Opus 4.8（`opus`）
   - Anthropic → Claude Haiku 4.5（`haiku`。要件の抽出や修復の計画など、分類系の呼び出しに常に使います）
   - Amazon → Titan Embeddings V2（Knowledge Base）

   実際に使うモデルは SSM `/makeui/models/*` の推論プロファイル ARN で決まります（[03_configuration.md](./03_configuration.md)）。

---

## 2. CloudFormation デプロイ

```bash
cd infrastructure
chmod +x deploy.sh
./deploy.sh
```

作成されるリソース:
- **Cognito User Pool**: `makeui-users` (MFA必須・管理者招待制) + Admin グループ + クライアント
- **CloudFront Distribution**: HTTPS フロントエンド配信 (OAC + S3)。`published/*`（サンドボックス CSP）と `stock/*` のビヘイビアを含む
- **S3 バケット**: フロントエンド用、Knowledge Base用、生成物保存用
- **DynamoDB テーブル**: `makeui-token-usage` (使用量追跡 + バージョン履歴)
- **IAM ロール**: `makeui-lambda-role`（backend / worker の両 Lambda が使う）
- **EventBridge ルール**: `makeui-orphan-sweep` とその呼び出し許可（`makeui-backend` が存在する場合のみ）

スタックに**含まれないもの**: Lambda 関数 `makeui-backend` / `makeui-worker`（コードと環境変数は
`deploy-lambda.sh` が管理）、HTTP API `makeui-api`、AgentCore 一式（`setup-agentcore.sh`）。

### 既存スタックの更新は変更セットを確認してから

2 回目以降の `./deploy.sh` は `update-stack` を直接呼びません。変更セットを作り、リソースごとの
変更内容（送り直されるプロパティの Before / After）を表示して、`y` を入力したときだけ実行します。
実行は `--disable-rollback` 付きです。

**表示された Modify は、そのリソースの全プロパティをテンプレートの値で送り直す**という意味です。
本番を手で直してテンプレートに書かないと、次の更新で手直しが消えます（2026-09-16 に実際に
8 リソースがこの状態でした）。本番の設定を手で変えたら、同じ変更を `template.yaml` にも入れてください。
ロールバックを無効にしているのは、ロールバックが**前回のテンプレートの値**を送り直すためで、
ドリフトしたリソースにとっては失敗と同じ被害になるからです。失敗したらスタックイベントで原因を直し、
もう一度 `./deploy.sh` を実行します。

---

## 3. AgentCore リソースセットアップ

> **Important:** このスクリプトは後続の `setup-knowledge-base.sh` が使用する IAM ロール（`makeui-kb-role`）を作成します。必ずこのステップを先に実行してください。

```bash
chmod +x setup-agentcore.sh
./setup-agentcore.sh
```

作成されるリソース:
- **AgentCore Runtime**: ジョブ実行の本体（`makeuiBackend`）
- **AgentCore Memory**: ユーザーデザイン好みのセマンティック記憶
- **AgentCore Workload Identity**: ランタイムロールとの紐付け
- **AgentCore Browser**: 生成物のレンダリング検証（`makeuiBrowser-XXXXXXXXXX`・稼働中）
- **IAM ロール**: Memory, Runtime, KB 用

> Code Interpreter・Policy Engine・`makeui-gateway-role` は作成後に削除しました。いずれも
> 呼び出し元が存在せず、リソース・SSM パラメータ・IAM 権限だけが揃っている状態だったためです。

#### Browser に必要な IAM 権限（`makeui-runtime-role` / `makeui-runtime-browser`）

```json
{
  "Action": [
    "bedrock-agentcore:StartBrowserSession",
    "bedrock-agentcore:StopBrowserSession",
    "bedrock-agentcore:GetBrowserSession",
    "bedrock-agentcore:UpdateBrowserStream",
    "bedrock-agentcore:ConnectBrowserAutomationStream",
    "bedrock-agentcore:ConnectBrowserLiveViewStream"
  ],
  "Resource": "arn:aws:bedrock-agentcore:ap-northeast-1:<ACCOUNT>:browser-custom/makeuiBrowser-XXXXXXXXXX*"
}
```

**リソースタイプは `browser-custom/` です。`browser/` ではありません。** 間違えると
`StartBrowserSession` が AccessDenied になり、エラー本文が正しい ARN を教えてくれます。

**`ConnectBrowserAutomationStream` は IAM ポリシーシミュレータでは `implicitDeny` と出ますが、
実在する必須アクションです。** シミュレータのアクション定義が新しいアクションに追いついて
いないだけで、これを「存在しない」と判断して外すと WebSocket 接続だけが失敗します。
**シミュレータの結果は「許可されている」証明にはなっても、「存在しない」証明にはなりません。**

管理者権限のローカル検証は、この種の誤りを一切検出しません。**動いたことと、
最小権限で動くことは別の話**です。
> Gateway はロールだけが作られ、Gateway 本体は一度も作られていませんでした。

### AgentCore Runtime のロール権限

Runtime はジョブ全体を実行するため、worker Lambda と同等の権限が必要です。以下が欠けると**ジョブは動くのに一部機能だけ静かに失敗**します。

| 権限 | 欠けたときの症状 |
|------|-----------------|
| `logs:CreateLogGroup` / `CreateLogStream` / `PutLogEvents` | ロググループが作成されず、障害調査ができない |
| `bedrock-agentcore:BatchCreateMemoryRecords` | デザイン嗜好が保存されない（生成自体は成功する） |
| `bedrock-agentcore:RetrieveMemoryRecords` | 過去の嗜好が反映されない |
| `bedrock-agentcore:ListMemoryRecords` / `BatchDeleteMemoryRecords` | Memory の掃除が効かず、旧形式レコードと重複が無制限に溜まる（生成は成功するため気付けない） |
| `bedrock:Retrieve` | KnowledgeBase 検索が 0 件になる |
| `bedrock:InvokeModelWithResponseStream` | ストリーミング生成が失敗する |
| `s3:DeleteObject`（outputs） | 大容量ペイロードの中継ファイルが残り続ける |
| `dynamodb:*`（token-usage テーブル） | ジョブ状態・使用量が記録されない |

API Lambda 側には `bedrock-agentcore:InvokeAgentRuntime` が必要です。これが無いと `dispatchJob()` は毎回 worker Lambda にフォールバックし、**900秒の制約が復活したまま気付けません**。

```bash
# 実行系の確認
aws logs filter-log-events --log-group-name /aws/lambda/makeui-backend \
  --filter-pattern '"dispatched"' --query "events[].message" --output text
```

---

## 4. Knowledge Base 作成

```bash
chmod +x setup-knowledge-base.sh
./setup-knowledge-base.sh
```

作成されるリソース:
- **Bedrock Knowledge Base**: `makeui-design-kb-s3v`（**S3 Vectors**）
- **Data Source**: S3 バケット `makeui-knowledge-base-<account-id>` を自動同期
- **Embedding Model**: Amazon Titan Embeddings V2 (`amazon.titan-embed-text-v2:0`, 1024次元)
- **IAM Policy**: KB ロールに S3 / Bedrock / S3 Vectors アクセス権限

### なぜ OpenSearch Serverless をやめたか

**OCU は時間課金で、クエリ数と無関係です。** コレクションが存在する限り最小構成
（Indexing 1 OCU + Search 1 OCU）が常時起動し、誰も検索しなくても課金が続きます。
実測（ap-northeast-1）:

```text
APN1-IndexingOCU   $8.016 / 日
APN1-SearchOCU     $8.016 / 日
合計               $16.03 / 日  →  約 $480〜500 / 月
```

KB を作成した 2026-08-01 から1日も欠かさずこの額でした。一方、そこに入っている
データは **14ファイル 33 KB**、ストレージ課金は1日 $0.0000005 です。請求のほぼ全額が
「箱を起動しておく代金」でした。停止・スケールtoゼロはできません。

S3 Vectors は保存量とクエリ数の従量課金で、アイドル時のコストがありません。
Bedrock KB の API は同じなので、**アプリケーション側のコードは検索フィルタ以外変わりません**。

### フィルタは `equals`（`stringContains` ではない）

移行で1点だけ実装が変わります。**S3 Vectors は `stringContains` を拒否します**:

```text
ValidationException: STRING_CONTAINS operation type is not supported for S3 Vectors
```

実測したところ、使えるのは `equals` と `listContains` のみで、`startsWith` と `in` も
拒否されました。そこで絞り込みは、ソース URI の部分一致ではなく**メタデータ属性**で行います。

各ドキュメントの隣に `<ファイル名>.metadata.json` を置きます:

```json
{"metadataAttributes":{"preset":"carbon"}}
```

ユーザーがアップロードしたデザインシステムには `{"owner":"<userId>"}` を書き込みます
（アップロードのエンドポイントが**取り込みジョブを開始する前に**書きます。後から置くと
次回同期まで反映されないためです）。

`equals` は **OpenSearch Serverless でも動きます**。これが切り戻しを安全にしている点で、
同じコードがどちらのストアでも動作します。

### 移行の手順（ストア種別は後から変更できない）

ストア種別は KB 作成時に固定され、`update-knowledge-base` では変更できません
（"You can't change the `knowledgeBaseConfiguration` or `storageConfiguration` fields"）。
**同じ KB を移行することはできません。** 別ストアへ移すには新しい KB を作り、向き先を
差し替えます。切り替え点は SSM パラメータなので、デプロイは不要です。

```bash
aws ssm put-parameter --name /makeui/agentcore/knowledge-base-id --value <新KB_ID> --overwrite
aws ssm put-parameter --name /makeui/agentcore/data-source-id    --value <新DS_ID> --overwrite
```

2026-08-16 の移行では、新旧2つの KB を並べて7プリセット全件の検索結果が一致することを
確認し、実生成で `knowledgeBaseHits: 5` を得てから旧側を削除しました。

**旧 OpenSearch 資産は削除済みです**（コレクション `makeui-kb-collection`、KB
`makeui-design-kb`、暗号化/ネットワーク/データアクセスの各ポリシー、および KB ロールの
`makeui-kb-oss-access` ポリシー）。削除するまで課金は止まりません — SSM の向き先を
変えただけでは1円も減らない、という点は移行時に取り違えやすいところです。

### S3 ディレクトリ構造

プレフィックスは UI が提供するプリセットと一致させます。

```text
s3://makeui-knowledge-base-<account-id>/
├── digital-agency/    components.md / layout.md
├── carbon/            components.md / layout.md
├── spindle/           components.md / layout.md
├── material3/         components.md / layout.md
├── shared/            interaction-patterns.md / accessibility.md
└── user/{userId}/     ユーザーが登録した自分のデザインシステム（本人だけが検索できる）
```

`components.md` にはコンポーネント単位の実装レシピ（マークアップ・状態・トークン）、`layout.md` には画面構成のパターンを置きます。`shared/` はプリセット非依存の内容で、`lookup_interaction_patterns` ツールが参照します。

各プリセットは SSM の `/makeui/presets/<name>/kb-prefix` で検索時のフィルタに使われます。検索は `equals` フィルタを `x-amz-bedrock-kb-source-uri` に対して適用するため、**プレフィックス名が実際の S3 パスと一致していないと 0 件になります**（S3 Vectors への移行前は `stringContains` でした。上の「フィルタは `equals`」節を参照）。

### ドキュメント追加・再同期

```bash
# ローカルの knowledge-base-docs/ にドキュメントを配置
# (Markdown, PDF, HTML, TXT に対応)
aws s3 sync ./knowledge-base-docs/ s3://makeui-knowledge-base-${ACCOUNT_ID}/

# インジェスション（ベクトル化）を再実行
KB_ID=$(aws ssm get-parameter --name "/makeui/agentcore/knowledge-base-id" --query Parameter.Value --output text)
DS_ID=$(aws ssm get-parameter --name "/makeui/agentcore/data-source-id" --query Parameter.Value --output text)
aws bedrock-agent start-ingestion-job \
  --knowledge-base-id ${KB_ID} \
  --data-source-id ${DS_ID} \
  --region ap-northeast-1
```

---

## 4-2. 生成物バケットのライフサイクル

`makeui-outputs-<account-id>` には次のプレフィックスがあります。**一時的なものには失効期限が要ります** —
`jobs/` だけ設定が漏れており、Lambda のペイロード上限を超えた分の中継ファイルが溜まり続けて
いました。

| プレフィックス | 内容 | 失効 |
|---------------|------|------|
| `outputs/` | 生成物の保存 | 90日 |
| `published/` | 公開 HTML（発行URLの有効期限と一致させる） | 30日 |
| `jobs/` | 大容量ペイロードの中継、ジョブのページ HTML、**却下された修復候補**（`jobs/<requestId>/rejected/`。アプリを壊した候補を診断用に残す。2026-09-13〜） | 7日 |
| `temp/` | 中継ペイロード | 1日 |
| `versions/` | バージョン履歴の文書（`versions/<userId>/<versionId>.html`）。行は DynamoDB に鍵だけを持つ | 失効させない |
| `projects/` | プロジェクトの最新文書（`projects/<userId>/<projectId>.html`） | 失効させない |
| `stock/` | ストック写真ライブラリ（`backend/scripts/curate-images.mjs` が構築） | 失効させない |
| `backend/` | Runtime のデプロイ成果物（失効させない） | — |

```bash
aws s3api put-bucket-lifecycle-configuration   --bucket makeui-outputs-${ACCOUNT_ID}   --lifecycle-configuration file://lifecycle.json
```

---

## 4-3. CloudFront のセキュリティヘッダ

`ResponseHeadersPolicy`（`template.yaml`）が CSP を配ります。**`font-src` は明示が必要**です。
省略すると `default-src 'self'` に落ち、スタイルシートを許可してもフォント本体の取得で止まります。

```
default-src 'self';
script-src  'self' 'unsafe-inline';
style-src   'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src    'self' https://fonts.gstatic.com;
img-src     'self' data: blob:;
connect-src 'self' https://*.amazonaws.com https://*.amazoncognito.com;
frame-src   'self' blob:
```

> ここに `fonts.googleapis.com` が無かったため、`index.css` の `@import` が本番でだけ
> ブロックされ、**Inter を前提にしたデザインが本番では一度も適用されていませんでした**。
> 開発サーバーは CSP を送らないので気付けません。CSP を変えたら、ローカルではなく
> **本番で** `document.fonts.size` を確認してください。

---

## 5. Bedrock Guardrails セットアップ

コンテンツフィルタリング（暴力/性的/PII保護/プロンプトインジェクション防止）を設定:

```bash
chmod +x setup-guardrails.sh
./setup-guardrails.sh
```

作成されるリソース:
- **Bedrock Guardrail**: コンテンツポリシー + PIIフィルター
- SSM パラメータ: `/makeui/guardrail-id`, `/makeui/guardrail-version`

Guardrails はパイプライン実行前にユーザー入力をチェックします（`ApplyGuardrail` API）。

---

## 6. フロントエンドデプロイ

> **Note:** 先に [03_configuration.md](./03_configuration.md) で `frontend/.env` を設定してからビルドしてください。

```bash
cd ../frontend
npm install && npm run build

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
aws s3 sync dist/ s3://makeui-frontend-${ACCOUNT_ID}/

# キャッシュ無効化
DIST_ID=$(aws ssm get-parameter --name "/makeui/cloudfront-distribution-id" --query Parameter.Value --output text)
aws cloudfront create-invalidation --distribution-id ${DIST_ID} --paths '/*'
```

CloudFront ドメインでアクセス:
```bash
aws ssm get-parameter --name "/makeui/cloudfront-domain" --query Parameter.Value --output text
```

---

## 7. 確認

```bash
# 全パラメータが登録されているか確認
aws ssm get-parameters-by-path --path "/makeui/" --recursive
```

---

## 次のステップ

[03_configuration.md](./03_configuration.md) に進み、モデル・パイプライン設定を行います。

## CI/CD スタック（makeui-pipeline）

`makeui-infra` とは**別スタック**です。寿命と影響範囲が違うためで、`makeui-infra` は
Cognito プール・各バケット・DynamoDB テーブル（すべて Retain）を持っているので、
パイプラインの変更がそれらを UPDATE_ROLLBACK に巻き込めてはいけません。

| リソース | 名前 | 備考 |
|---|---|---|
| CodeCommit | `makeui` | Retain。ソースの正本 |
| CodeBuild | `makeui-build` | MEDIUM。npm ci・型検査・テスト・成果物生成 |
| CodeBuild | `makeui-deploy-backend` | Lambda 2本 + AgentCore Runtime |
| CodeBuild | `makeui-deploy-frontend` | S3 + CloudFront |
| CodeBuild | `makeui-smoke-test` | デプロイ後の外形確認 |
| CodePipeline | `makeui` | 5ステージ |
| S3 | `makeui-pipeline-artifacts-<account>` | 30日で失効 |
| EventBridge | `makeui-pipeline-on-push` | push 検知（ポーリングしない） |
| IAM | `makeui-codebuild-build` / `makeui-codebuild-deploy` / `makeui-codepipeline` / `makeui-pipeline-trigger` | ロールは2つに分けています。ビルドはログと成果物バケットだけ、配備は本番を置き換えられる。ビルドに配備権限を与えると、テストの変更が配備ステージを通らずに本番へ届きます |

手順は [07_cicd.md](./07_cicd.md)。

## 棚卸し（削除したもの）

| 対象 | 判断 |
|---|---|
| `infrastructure/oss-block.bak` | OpenSearch Serverless 作成処理の残骸。KB は S3 Vectors へ移行済みで、どこからも参照されておらず、**誤って再実行できてしまう**ため削除 |
| SSM `/makeui/agentcore/oss-collection-id` | 上記コレクションの ID。コレクション自体は削除済みで、パラメータだけが残って存在しないリソースを指していた（実際、本調査中に一度これを見て誤った推測をしました）。削除 |

**削除しなかったもの**も記録しておきます。`s3://makeui-outputs-.../` は合計約 975MB で、
うち 936MB は `stock/`（写真ライブラリ 3,642枚）です。月額数円で、生成物の品質に直接効くので
残します。`jobs/` `outputs/` `published/` `temp/` にはすでにライフサイクル規則があり、
`versions/`（12MB）は利用者のバージョン履歴なので対象外です。

Lambda のバージョンは各1、AgentCore Runtime は1つ、IAM ロールはすべて使用中でした。
