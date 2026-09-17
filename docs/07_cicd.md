# 07. CI/CD — デプロイ手順

デプロイは **`git push` だけ**です。以降、`infrastructure/deploy-*.sh` を手で叩く必要はありません
（叩けますし、緊急時にはそうしてください。後述の「パイプラインを迂回する」を参照）。

```
git add -A
git commit -m "何を変えたか"
git push
```

これで CodePipeline が起動し、ビルド → テスト → バックエンド配備 → フロントエンド配備 →
デプロイ後の検証 まで通します。どこかで落ちればそこで止まり、**壊れたものが本番に出ません**。

---

## 構成

```
CodeCommit (makeui / main)
      │  push
      ▼
EventBridge ルール  makeui-pipeline-on-push
      │
      ▼
CodePipeline  makeui
      │
      ├─ 1. Source          CodeCommit からソースを取得
      │
      ├─ 2. Build           CodeBuild  makeui-build
      │                     npm ci → tsc --noEmit ×2 → テスト ×2 →
      │                     lambda.mjs / runtime/index.js / frontend/dist を生成
      │                     成果物が空でないことをここで確認する
      │
      ├─ 3. DeployBackend   CodeBuild  makeui-deploy-backend
      │                     deploy-lambda.sh  → makeui-backend / makeui-worker
      │                     deploy-runtime.sh → AgentCore Runtime 新バージョン
      │
      ├─ 4. DeployFrontend  CodeBuild  makeui-deploy-frontend
      │                     deploy-frontend.sh → S3 + CloudFront 無効化
      │
      └─ 5. Verify          CodeBuild  makeui-smoke-test
                            デプロイが実際に効いたことを外から確認する
```

**バックエンドが先、フロントエンドが後**にしてあります。フロントエンドは API を呼ぶので、
両方変える変更のとき、2つの配備の間に残る状態として正しいのは「API が新しくクライアントが古い」
方だからです。

### 使っている AWS Code サービス

| サービス | 用途 |
|---|---|
| **CodeCommit** | ソース。`makeui` リポジトリの `main` ブランチ |
| **CodeBuild** | 4プロジェクト（ビルド / バックエンド配備 / フロントエンド配備 / 検証） |
| **CodePipeline** | 5ステージのオーケストレーション |
| EventBridge | push を検知してパイプラインを起動（ポーリングは使わない） |
| S3 | 成果物置き場（`makeui-pipeline-artifacts-<account>`、30日で失効） |

**CodeDeploy は使っていません。** 理由を残しておきます。CodeDeploy が価値を出すのは
Lambda のエイリアスを使った段階的な切り替えとロールバックですが、この構成では

- AgentCore Runtime は CodeDeploy のデプロイ対象になりません（そもそも CloudFormation の
  リソースタイプもありません）
- CloudFront + S3 の配信も対象外
- 残る Lambda 2本は、API 本体と非同期ワーカー。ワーカーは API から**関数名で**同期呼び出し
  されているため、エイリアス方式へ移すには呼び出し側も同時に変える必要があります

つまり「入れれば動く」ものではなく、**呼び出し経路の作り替え**を伴います。段階的切り替えが
必要になった時点で入れるのが正しく、そのときに必要なのは
`lambda:UpdateFunctionCode` を `PublishVersion` + `UpdateAlias` に変え、`WORKER_FUNCTION_NAME`
をエイリアス ARN にすることです。今は使わない、という判断を記録しておきます。

---

## 初回セットアップ（1回だけ）

```bash
bash infrastructure/setup-pipeline.sh
```

これが行うこと:

1. `makeui-pipeline` スタックを作成（CodeCommit・CodeBuild ×4・CodePipeline・IAM・成果物バケット）
2. 作業ツリーを `git init` し、CodeCommit を `origin` に設定
3. CodeCommit 用の認証ヘルパーを**このリポジトリにだけ**設定（`git config --local`）
4. 最初の push → パイプラインが1回走る

AgentCore Runtime の名前は CloudFormation から引けない（リソースタイプが無い）ので、
スクリプトが `makeuiBackend*` で解決してスタックのパラメータに渡します。別の Runtime に
向けたい場合は `RUNTIME_NAME=... bash infrastructure/setup-pipeline.sh`。

### push が 403 になるとき

Windows の既定では `credential.helper=manager`（Git Credential Manager）が
グローバルに設定されており、**AWS のヘルパーより先に**動きます。Credential Manager が
初回 push で得た資格情報をキャッシュしますが、それは時間制限のある SigV4 署名なので、
数回後の push で期限切れのものが再送され、CodeCommit は 401 → 403 を返します。
「2回は通ったのに3回目から通らない」という出方をします。

`setup-pipeline.sh` は空値を先に入れて継承リストをリセットしているため、通常は起きません。
手で直す場合:

```bash
git config --local --unset-all credential.helper
git config --local --add credential.helper ''
git config --local --add credential.helper '!aws codecommit credential-helper $@'
```

---

## 日々の使い方

### デプロイする

```bash
git add -A
git commit -m "画面遷移の不具合を修正"
git push
```

### 進捗を見る

```bash
aws codepipeline get-pipeline-state --name makeui --region ap-northeast-1 \
  --query "stageStates[].{stage:stageName,status:latestExecution.status}" --output table
```

コンソール:
`https://ap-northeast-1.console.aws.amazon.com/codesuite/codepipeline/pipelines/makeui/view?region=ap-northeast-1`

### 失敗したログを読む

```bash
aws codebuild list-builds-for-project --project-name makeui-build --region ap-northeast-1 \
  --query "ids[0]" --output text
```

で最新のビルド ID を取り、コンソールのログか CloudWatch Logs
`/aws/codebuild/makeui-build` を見ます。

### 手動で再実行する

```bash
aws codepipeline start-pipeline-execution --name makeui --region ap-northeast-1
```

---

## 検証ステージが見ているもの

このステージの各項目は、**過去に実際に「デプロイ成功」と表示されたまま本番が壊れた**
経路に対応しています。「配備しました」としか言わないステージでは、どれも素通りしていました。

| 確認 | これが無かったときに起きたこと |
|---|---|
| Runtime が READY | `update-agent-runtime` は即座に返る。新バージョンが起動に失敗しても、前のバージョンが応答し続けるので成功と区別がつかない |
| Runtime の環境変数が8個以上（2026-09-13 時点の実数は11個。一覧は `03_configuration.md`） | `update-agent-runtime` は設定を**置換**する。環境変数を渡し忘れると全部消え、READY になり、次の生成がバケット名の欠落で落ちる |
| API Lambda がHTTP応答を返す | Runtime 用の成果物（`index.js`）を Lambda（`lambda.mjs`）に配備したことがある。関数は存在し、デプロイは成功し、全リクエストが module-not-found で落ち、画面には「Failed to fetch」だけが出た |
| index.html が `no-cache` | `Cache-Control` 無しで上げると CloudFront の既定 TTL 24時間に入る。デプロイが誰にも届かない |
| index.html が名指すバンドルが 200 かつ JS | `sync --delete` が遅延読み込みされるチャンクを消し、CloudFront の 404→index.html が HTML を 200 で返した。ブラウザには「モジュールのパースエラー」としか出ない |

---

## 生成の実行中にデプロイしないこと

AgentCore Runtime に新しいバージョンを配備すると、**実行中のセッションは終了します**。
パイプラインは push のたびに Runtime を更新するので、誰かが UI を生成している最中に
push すると、そのジョブは進捗が止まったまま完了も失敗もしません。

実測: 検証用の生成3本が 17:38 で更新を止め、Runtime は 17:39:47 に v130 へ上がっていました。
ジョブ側にはエラーが記録されないため、**「重い生成なのだろう」としか見えません**。

- 利用者がいる時間帯の push は避けるか、実行中ジョブが無いことを確認してください
- 連続で push すると、その数だけ実行がキューに積まれ、Runtime も同じ回数上がります

```bash
# 実行中のジョブがあるか
aws dynamodb scan --table-name makeui-token-usage --region ap-northeast-1   --filter-expression "#s = :r"   --expression-attribute-names '{"#s":"status"}'   --expression-attribute-values '{":r":{"S":"running"}}'   --query "length(Items)" --output text
```

---

## Bedrock の1日あたりトークン枠

1ファイルずつビルドしていた頃（`perFileBuild: true`）、1回の生成は **40万〜110万トークン**を消費し、
検証のために一晩で十数本回したところ、アカウントの**1日あたりのトークン枠を使い切りました**:

```
ThrottlingException: Too many tokens per day, please wait before trying again.
```

現在はどのモードも単一呼び出しのビルド（`perFileBuild: false`）で、2026-09-13 の Haiku・仕上げの実測は
1回あたり **12万〜22万トークン**（入力＋出力。キャッシュの読み書きを除く）でした。それでも検証の本数を
重ねると枠に届くので、何が起きるかは把握しておいてください。

- ジョブは `failed` になり、`errorMsg` に上記がそのまま入って**チャットにも出ます**
  （メッセージは利用者にとって意味が通るので、ここは追加の対処をしていません）
- 枠が尽きた呼び出しを、より大きな呼び出し（全文書き換え）で再試行することはしません

枠を上げるか消費を下げるかは運用判断です。どこにトークンが行っているかは
`backend/scripts/token-stages.mjs` で確認できます（生成では修復が最大の工程です）。

---

## パイプラインを迂回する

緊急時は従来どおり直接叩けます。**そのときも同じスクリプトが走ります** — パイプラインは
スクリプトを再実装しておらず、呼んでいるだけです。

```bash
bash infrastructure/deploy-lambda.sh
bash infrastructure/deploy-runtime.sh
bash infrastructure/deploy-frontend.sh
```

パイプライン経由では `SKIP_BUILD=1` が渡ります。ビルドステージが**テスト済みの成果物**を
すでに作っているためで、ここで作り直すと「テストを通っていないもの」を配備することになります。
手で叩くときは設定しないでください（ビルドから走ります）。

---

## 変更したときに触るファイル

| 変えたいこと | ファイル |
|---|---|
| ビルドやテストの手順 | `infrastructure/buildspec/build.yml` |
| バックエンドの配備手順 | `infrastructure/buildspec/deploy-backend.yml`（実体は `deploy-*.sh`） |
| 検証項目 | `infrastructure/buildspec/smoke-test.yml` |
| ステージ構成・権限 | `infrastructure/pipeline.yaml` → `bash infrastructure/setup-pipeline.sh` で反映 |

`pipeline.yaml` を変えたら `setup-pipeline.sh` を再実行してください（冪等です）。
このスクリプトは CodeBuild のロググループに保持期間30日も設定します
（CodeBuild は初回実行時にロググループを暗黙作成し、**保持期間は無期限**です。
4つのうち3つは手で30日に設定されていて `makeui-smoke-test` だけ抜けており、
ビルド出力を永久に保持していました。初回ビルドより前は対象が存在しないため、
1度パイプラインを流したあとに再実行してください）。

### テストは列挙ではなく発見する

`npm test` は両方とも `&&` で繋いだ手書きの列でした。修正と同じ週に追加した
テストがその列に入っておらず、**CodeBuild は22スイート中20しか実行していませんでした**。
入っていなかった2つは、いずれも「検出器が古くなってユーザに不具合が届いた」ことを
理由に存在するテストです。次に同じことが起きても、何も言わなかったことになります。

手で更新するリストは、黙って不完全になります。しかも失敗の仕方が最悪で、
**パイプラインは緑になります**。現在は `backend/test/run-all.mjs` と
`frontend/test/run-all.mjs` がディレクトリを走査します（`*.probe.mjs` は除外
— デプロイ済み Runtime を呼ぶためトークンを消費し、数分かかります）。

```bash
node test/run-all.mjs --list   # 実行対象のファイル名だけ出す
```

失敗したスイートだけが出力を出します。緑の実行が数十スイート分の PASS を吐くログは
誰も読まないからで、それがそもそも2つの欠落を見逃した理由です。
2026-09-13 時点で backend 107 スイート、frontend 46 スイートです。
