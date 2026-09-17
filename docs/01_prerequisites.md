# 01. 前提条件

## 必要なソフトウェア

| ツール | バージョン | 用途 |
|--------|----------|------|
| Node.js | 22+ | バックエンド・フロントエンド実行 |
| npm | 10+ | パッケージ管理 |
| AWS CLI | 2.x | AWSリソース操作 |
| Git | 2.x | ソースコード管理 |

## AWS アカウント要件

- Bedrock モデルアクセスが有効化済み（推論プロファイル。2026-09-13 時点で SSM `/makeui/models/*` が指すもの）
  - `jp.anthropic.claude-sonnet-4-6`（`sonnet`・`default`）
  - `jp.anthropic.claude-opus-4-8`（`opus`）
  - `jp.anthropic.claude-haiku-4-5-20251001-v1:0`（`haiku`。要件の抽出・プロンプトの添削・修復の計画など、生成内の分類系の呼び出しは常にこれ）
  - `amazon.titan-embed-text-v2:0`（Knowledge Base の埋め込み）

  モデルを差し替えるときは SSM の値を変えるだけです（[03_configuration.md](./03_configuration.md)）。
  「使えない」と出るときは、クォータではなく**モデルの利用規約（agreement）が未承諾**のことが多いです。
- AgentCore が利用可能なリージョン（`ap-northeast-1`）
- IAM ユーザーまたはロールに以下の権限:
  - `bedrock:InvokeModel` / `bedrock:InvokeModelWithResponseStream`
  - `bedrock:ApplyGuardrail` (Guardrails)
  - `bedrock:Retrieve` (Knowledge Base)
  - `bedrock-agentcore:*`
  - `ssm:GetParameter` / `ssm:PutParameter` / `ssm:GetParametersByPath`
  - `dynamodb:PutItem` / `dynamodb:GetItem` / `dynamodb:Query` / `dynamodb:UpdateItem`
  - `s3:PutObject` / `s3:GetObject`
  - `cloudformation:*` (デプロイ時)

## AWS CLI 設定

```bash
aws configure
# AWS Access Key ID: <your-key>
# AWS Secret Access Key: <your-secret>
# Default region name: ap-northeast-1
# Default output format: json

# 確認
aws sts get-caller-identity
```

---

## 次のステップ

[02_infrastructure.md](./02_infrastructure.md) に進み、インフラをデプロイします。
