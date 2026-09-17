# 03. SSM Parameter Store 設定

## このステップで行うこと

SSM Parameter Store にモデルID・プリセット設定を登録します。バックエンドはこれらを非同期取得し、5分間キャッシュします。

---

## 1. モデル設定

値には推論プロファイルの ARN を設定します。`GET /models` はこの文字列からバージョン（`4.5` など）を抽出してチップに表示するため、モデルを差し替えてもフロントの再デプロイは不要です。

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
PROFILE="arn:aws:bedrock:ap-northeast-1:${ACCOUNT_ID}:inference-profile"

aws ssm put-parameter --name "/makeui/models/sonnet" \
  --value "${PROFILE}/jp.anthropic.claude-sonnet-4-6" --type String --overwrite

aws ssm put-parameter --name "/makeui/models/opus" \
  --value "${PROFILE}/jp.anthropic.claude-opus-4-8" --type String --overwrite

aws ssm put-parameter --name "/makeui/models/haiku" \
  --value "${PROFILE}/jp.anthropic.claude-haiku-4-5-20251001-v1:0" --type String --overwrite

aws ssm put-parameter --name "/makeui/models/default" \
  --value "${PROFILE}/jp.anthropic.claude-sonnet-4-6" --type String --overwrite
```

## 2. プリセット設定

`kb-prefix` は KnowledgeBase 内の S3 プレフィックスに対応します。UI が提供するプリセットと一致させてください。

```bash
for p in digital-agency carbon spindle material3; do
  aws ssm put-parameter --name "/makeui/presets/${p}/kb-prefix" \
    --value "${p}/" --type String --overwrite
done
```

> `/makeui/pipeline/mode` `/makeui/pipeline/quality-threshold`
> `/makeui/pipeline/max-refinements` `/makeui/presets/available` は削除しました。
> いずれも読み手が先に消えており、`pipeline/mode` に至っては `getModelConfig()` が
> **全モデル解決のたびに取得して捨てて**いました。設定に見えるものが動作に影響しない状態は、
> 次に触る人が値を変えて「効かない」と悩む種になります。

## 3. AgentCore Memory のストラテジID

Memory のレコードは、メモリリソースが宣言する名前空間テンプレート
`/strategies/{memoryStrategyId}/actors/{actorId}/` に従って書く必要があります。
ストラテジ ID を取得してパラメータに保存します。

```bash
STRATEGY_ID=$(aws bedrock-agentcore-control get-memory \
  --memory-id makeuiMemory-XXXXXXXX \
  --query "memory.strategies[0].strategyId" --output text)

aws ssm put-parameter --name "/makeui/agentcore/memory-strategy-id" \
  --value "${STRATEGY_ID}" --type String --overwrite
```

## 4. フロントエンド環境変数

バックエンドはデプロイ済みの API のみです。ローカルにバックエンドは立てません
（詳細は [04_backend.md](./04_backend.md) の「ローカル開発サーバーを削除した理由」）。
フロントエンドの開発サーバーは `VITE_API_URL` 越しにデプロイ済み API を叩きます。

```bash
cd frontend
cat > .env << 'EOF'
VITE_API_URL=https://xxxxxxxxxx.execute-api.ap-northeast-1.amazonaws.com
VITE_COGNITO_USER_POOL_ID=ap-northeast-1_xxxxxxxxx
VITE_COGNITO_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxx
EOF
```

> `VITE_COGNITO_USER_POOL_ID` と `VITE_COGNITO_CLIENT_ID` は `deploy.sh` 実行時に表示された Stack Outputs の値を設定します。
> Lambda / Runtime 側の環境変数はデプロイ時に設定されるもので、`.env` では持ちません。

## 5. 確認

```bash
aws ssm get-parameters-by-path --path "/makeui/" --recursive \
  --query "Parameters[].{Name:Name,Value:Value}" --output table
```

Runtime の環境変数も併せて確認してください。**11件あるのが正常です**（2026-09-13 時点）。

```bash
aws bedrock-agentcore-control get-agent-runtime \
  --agent-runtime-id makeuiBackend-XXXXXXXXXX \
  --query "environmentVariables"
```

```
AGENTCORE_BROWSER_ID  AWS_ACCOUNT_ID  BROWSER_VERIFY_ENABLED=1  CLOUDFRONT_DOMAIN
COGNITO_USER_POOL_ID  DESIGN_SWARM_ENABLED=1  KB_BUCKET_NAME  MODEL_PRICING
OUTPUT_BUCKET_NAME  PORT=8080  USAGE_TABLE_NAME
```

- `AGENTCORE_BROWSER_ID` と `BROWSER_VERIFY_ENABLED` は、`deploy-runtime.sh` が
  **必須値として合流**させます（ライブの値があればそちらが優先）。これが欠けると
  ブラウザ検証が黙って止まり、実行時の減点も修復も起きません。
- `MODEL_PRICING` は SSM `/makeui/pricing/models` から毎回読み直して設定します
  （SSM 側が優先）。設定方法は `backend/scripts/README.md` の「モデル別の価格表」。

API Lambda（`makeui-backend`）側は次の11件です。`KNOWLEDGE_BASE_ID`・`GUARDRAIL_ID`・
`GUARDRAIL_VERSION`・`MEMORY_ID` は 2026-09-10 に削除しました（どのコードも読んでおらず、
デプロイ時に一度だけ解決された古い値 ─ 存在しない KB ID と Guardrail バージョン 1 ─
のままでした）。

```
AGENT_RUNTIME_ARN  ALLOWED_ORIGIN  AWS_ACCOUNT_ID  CLOUDFRONT_DOMAIN  COGNITO_USER_POOL_ID
KB_BUCKET_NAME  MODEL_PRICING  MODEL_PRICING_ENFORCE  OUTPUT_BUCKET_NAME
USAGE_TABLE_NAME  WORKER_FUNCTION_NAME
```

`update-agent-runtime` は設定を**全置換**するため、`--environment-variables` を省いたデプロイで全部消えます。消えても `status` は READY になり `/ping` も通るので、ここを見ない限り分かりません。デプロイには `infrastructure/deploy-runtime.sh` を使ってください（読み出して再適用し、消えていれば異常終了します）。

---

## パラメータ一覧

| パス | 値の例 | 用途 |
|------|--------|------|
| `/makeui/models/sonnet` | `arn:...:inference-profile/jp.anthropic.claude-sonnet-4-6` | バランスtier |
| `/makeui/models/opus` | `arn:...:inference-profile/jp.anthropic.claude-opus-4-8` | 品質tier |
| `/makeui/models/haiku` | `arn:...:inference-profile/jp.anthropic.claude-haiku-4-5-...` | 軽量tier |
| `/makeui/models/default` | 上記いずれかの ARN | 未指定時に使うモデル |
| `/makeui/agentcore/memory-id` | `makeuiMemory-xxx` | Memory |
| `/makeui/agentcore/memory-strategy-id` | `UserPreferences-xxx` | Memory の名前空間構築に必須 |
| `/makeui/agentcore/runtime-role-arn` | `arn:...:role/makeui-runtime-role` | Runtime 実行ロール |
| `/makeui/agentcore/memory-role-arn` | `arn:...:role/...` | Memory の実行ロール |
| `/makeui/agentcore/kb-role-arn` | `arn:...:role/...` | Knowledge Base の実行ロール |
| `/makeui/agentcore/browser-id` | `makeuiBrowser-xxx` | Browser |
| `/makeui/agentcore/knowledge-base-id` | `<KNOWLEDGE_BASE_ID>` | Knowledge Base（S3 Vectors） |
| `/makeui/agentcore/data-source-id` | `<DATA_SOURCE_ID>` | KB Data Source |
| `/makeui/agentcore/workload-identity-id` | `makeuiWorkload` | Workload Identity |
| `/makeui/presets/*/kb-prefix` | `carbon/` | プリセット別KBプレフィックス（digital-agency / carbon / spindle / material3） |
| `/makeui/guardrail-id` | `<GUARDRAIL_ID>` | Guardrail |
| `/makeui/guardrail-version` | `3` | Guardrail バージョン |
| `/makeui/pricing/models` | JSON（モデル別の単価） | トークンの重み付けと管理画面の金額。`scripts/set-model-pricing.sh` が書き、デプロイ時に `MODEL_PRICING` として配布 |

> `getAgentCoreConfig()` はここに挙げたパラメータを **`Promise.all` で毎回取得**します。
> 1つでも欠けると例外になり、Memory も KnowledgeBase も同時に落ちます。パラメータを消すときは
> **先にコードから外してデプロイし、その後に削除**してください（Code Interpreter・Policy Engine、
> および `pipeline/*` と `presets/available` の削除はこの順で実施しました）。

> KnowledgeBase ID・Guardrail ID・Memory ID は **Parameter Store が唯一の情報源**です。
> 以前は API Lambda にも同名の環境変数がありましたが、読むコードが無く、値も古いまま
> 食い違っていたため削除しました。

> `/makeui/api-url`・`/makeui/cloudfront-*`・`/makeui/cognito/*`・`/makeui/frontend-bucket`・
> `/makeui/outputs-bucket`・`/makeui/knowledge-base-bucket`・`/makeui/token-usage-table` は、
> `infrastructure/deploy.sh` と `setup-agentcore.sh` がスタックの出力を**記録として**書くもので、
> 手入力は不要です。バックエンドのコードはこれらを読みません（2026-09-13 時点）。

### 比較用の実験フラグ（Runtime を直接呼ぶときだけ）

生成ジョブの `input.experiment` に `{ "requirementBriefing": false }` を入れると、要件のチェックリストを設計フェーズに、
名前の挙がった画面をビルドに渡さずに生成します（抽出と照合はいつもどおり行うので、両方で同じ数値が出ます）。
変更の効果を同じコードの上で比べるためのもので、**API Lambda は `experiment` を取り除いてから Runtime に渡す**ため、
アプリや公開 API からは指定できません。`backend/scripts/compare-generate.mjs --no-briefing` が使います。
2026-09-14 に在庫管理の依頼で比べた結果は、ありの3回が平均71、なしの2回が平均69でした（差はばらつきの範囲）。

---

## 次のステップ

[04_backend.md](./04_backend.md) に進み、バックエンドの構成を確認します。
