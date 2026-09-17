# 09. E2E テスト（MakeUI 本体の画面）

MakeUI 本体（ログイン・チャット・生成・プレビュー・編集・履歴・公開・管理画面）を、実際のブラウザで操作して確かめるテストの方針と手順です。生成されたアプリの品質を見る仕組み（Runtime のブラウザ巡回、`scripts/replay-walk.mjs`）とは別物です。

> 状態: **方針と手順を定めた段階**（2026-09-14）。まだテストは1本もありません。着手の順番は末尾の「段階計画」にあります。

---

## 1. なぜ必要か

今あるのは、関数単位の自前テスト（バックエンド 117 本・フロントエンド 47 本）と、デプロイ後のスモークテスト（Runtime が READY か、`index.html` が 200 か）だけです。**画面を操作して、送信した内容が API に正しく届き、結果が画面に出るか**を通しで確かめているものがありません。

これまでに起きた不具合の多くは、まさにこの隙間にありました。

- 添付した画像や説明文が、一部の送信経路で API に届いていなかった（2026-09-14 修正）
- API にルートが無く 404 になっているのに、どのテストも気付かなかった（メモリ「Verification constraints」の HTTP 層の盲点）

## 2. 方針（決めごと）

### 2.1 ツール
- **Playwright Test**（`@playwright/test`）。まず **Chromium のみ**。
- 置き場所は `frontend/e2e/`、TypeScript。既存の `npm test`（自前ランナー）とは別のコマンド `npm run e2e` にします。

### 2.2 三つの層に分ける

| 層 | 何を確かめるか | バックエンド | 認証 | いつ走らせるか | 費用 |
|----|----------------|--------------|------|----------------|------|
| **L1 モック E2E** | 画面の操作、API に送る内容、応答の表示、エラー表示 | **Playwright の `page.route` で全部モック** | ダミーのトークンを localStorage に入れる | 手元と CI（push ごと） | 0 |
| **L2 契約の一致** | L1 のモックの形が、本物のバックエンドの応答と食い違っていないか | 本物のハンドラ（単体テストとして） | 不要 | `npm test` の一部 | 0 |
| **L3 実環境スモーク** | ステージングで、ログイン済みの利用者として1件だけ生成が通るか | 本物（**ステージングのみ**） | 専用のテスト用ユーザー。トークンは CI が取得する | 手動か夜間 | 生成1件（Haiku・節約） |

**大半は L1 で書きます。** L1 はモデルも AWS も呼ばないので、速く、何度走らせても費用がかかりません。L1 だけだと「モックが本物とずれる」危険があるので、L2 でそこを塞ぎます。L3 は通しの最終確認で、数を増やしません。

**本番環境では E2E テストを走らせません。** L3 はステージング環境ができてからです（エンタープライズ対応の P0「確認環境と本番の分離」が前提）。

### 2.3 認証とパスワードの扱い（厳守）
- **本物の資格情報を、テストコード・フィクスチャ・リポジトリ・ログのどこにも置かない。**
- L1 の認証済み状態は、署名の無いダミーの JWT（期限は未来）を localStorage に入れて作ります。`amazon-cognito-identity-js` は手元で署名を検証しないので、これで画面は「ログイン済み」になります。トークンの更新に行く通信（`cognito-idp.*.amazonaws.com`）もモックします。
- ログイン画面のテストは、**モックした Cognito に対して、明らかなダミー値だけ**を使います（例: `e2e-user@example.invalid`）。
- L3 のテスト用ユーザーの作成と、そのシークレットを Secrets Manager に登録する作業は**管理者（人）が行います**。Claude はパスワードを扱わず、どの入力欄にも入れません。
- Playwright の `storageState` ファイルは `.gitignore` に入れます。

### 2.4 要素の選び方
- **`getByRole` / `getByLabel`（アクセシブルな名前）を優先**します。これはアクセシビリティの確認も兼ねます。
- 名前で取れない要素にだけ `data-testid` を足します。命名は `画面-要素`（例: `composer-send`、`preview-frame`）。
- CSS クラス名や、変わりやすい日本語の文言の完全一致には頼りません。

### 2.5 待ち方
- **固定の sleep は禁止**。Playwright の自動待機と `expect(...).toBeVisible()` などで待ちます。
- 生成ジョブのポーリング（`GET /jobs/{id}`）は、モック側で `pending → running → completed` を呼ばれた回数で進めます。本物の数分を待ちません。
- ポーリング間隔が長い箇所は `page.clock` で時間を進めます。

### 2.6 プレビュー（iframe）
- 生成結果のプレビューは iframe の中にあります。`frameLocator` で中身を確かめます。
- 表示内容は、小さな固定のプロジェクト（見出し1つ・ナビ2つ程度）のフィクスチャにします。生成物の品質はここでは見ません。
- iframe が `blob:` か `srcdoc` か、sandbox の設定で `frameLocator` が届くかは**最初に確認が必要**です（`LiveFrame.tsx` / `Preview.tsx`）。

### 2.7 不安定さへの備え
- CI では再試行 2 回、初回の再試行でトレースを取り、失敗時はスクリーンショットと動画を残します。
- テストどうしは独立させます（テストごとに新しいブラウザコンテキストとモックの状態）。
- 並列数は固定します。

### 2.8 当面やらないこと
- 画面の画像比較（スクリーンショットの差分）は、L1 が安定してから主要画面だけ検討します。
- アクセシビリティ自動検査（`@axe-core/playwright`）は、主要画面で重大な違反 0 件から段階的に入れます。

## 3. 対象シナリオ（優先順）

### P1 — 最初に書くもの
| # | シナリオ | 確かめること |
|---|----------|--------------|
| 1 | 未ログインで開く → ログイン画面 → ダミー値でモックのサインイン | メイン画面に移る。新しいパスワードの要求・MFA の分岐もモックで通る |
| 2 | ログイン済み（トークン注入）で開く | プロジェクト一覧・モデル一覧・利用量が読み込まれる |
| 3 | プロンプトを入力して送信 | `POST /generate` の本文（prompt・model・preset・effort・outputKind）、ジョブが完了するとプレビューに見出しが出る |
| 4 | デザインプリセットを選ぶ | 5つ（なし・デジタル庁・Carbon・Spindle・M3）が選べ、選んだ id が本文に入る |
| 5 | 入力の上限 | 2,000 文字を超えると送れない。5MB を超える画像は添付を拒否する |
| 6 | 表示中のプロジェクトに編集を指示 | `POST /modify` の本文（instruction・images・imageCaptions）、結果がプレビューに反映される |
| 7 | エラー | `/generate` の 4xx・5xx、ジョブの失敗、利用上限（429）が利用者に分かる形で出る |

### P2
バージョン履歴と差分、公開（`POST /publish`）とリンクのコピー、利用量メニュー、プランモード（`POST /plan` → 承認 → ビルド）、画像の添付と説明文、チャット履歴、新しいチャットの確認ダイアログ、CSS インスペクタと直接編集、管理画面（`cognito:groups` に admin を含むトークンで `/admin/*`）。

### P3
スマホ幅での表示、キーボードだけでの操作、アクセシビリティ自動検査。

## 4. ディレクトリ構成

```text
frontend/
├── playwright.config.ts          # baseURL、webServer（vite preview）、再試行、トレース
└── e2e/
    ├── fixtures/
    │   ├── auth.ts                # ダミー JWT の生成と localStorage への注入
    │   ├── api.ts                 # page.route のモック一式（ジョブの状態遷移を含む）
    │   └── data/                  # projects.json, models.json, usage.json, job-completed.json,
    │                              # project-small.html（プレビュー用の小さなプロジェクト）
    └── tests/
        ├── auth.spec.ts
        ├── generate.spec.ts
        ├── modify.spec.ts
        ├── limits.spec.ts
        └── errors.spec.ts
```

## 5. 手順

### 5.1 初回の準備（手元）
```bash
cd frontend
npm install -D @playwright/test
npx playwright install chromium
```

### 5.2 E2E 用のビルド設定
E2E では本物の API と Cognito に向けないため、ビルド時の環境変数を E2E 専用の値にします（`frontend/.env.e2e`、リポジトリに入れてよい値だけ）。

```text
VITE_API_URL=http://api.e2e.test
VITE_COGNITO_USER_POOL_ID=ap-northeast-1_E2ETEST00
VITE_COGNITO_CLIENT_ID=e2etestclient000000000000
```

`http://api.e2e.test` は実在しない宛先です。モックし忘れた通信は必ず失敗するので、「本物に届いてしまった」が起きません。

### 5.3 実行
```bash
npm run e2e          # vite build --mode e2e → vite preview → playwright test
npm run e2e -- --ui  # 画面を見ながら1本ずつ
```

### 5.4 認証済み状態の作り方（fixtures/auth.ts の中身の方針）
`amazon-cognito-identity-js` は次のキーを localStorage から読みます。

```text
CognitoIdentityServiceProvider.<clientId>.LastAuthUser          = <username>
CognitoIdentityServiceProvider.<clientId>.<username>.idToken      = <JWT>
CognitoIdentityServiceProvider.<clientId>.<username>.accessToken  = <JWT>
CognitoIdentityServiceProvider.<clientId>.<username>.refreshToken = <任意の文字列>
CognitoIdentityServiceProvider.<clientId>.<username>.clockDrift   = 0
```

JWT は `header.payload.signature` の形で、payload に `email`、`exp`（未来）、`cognito:username`、必要なら `cognito:groups: ["admin"]` を入れます。署名部分はダミーで構いません。`page.addInitScript` で、ページの読み込み前に書き込みます。

### 5.5 API モックの書き方（fixtures/api.ts の方針）
- `http://api.e2e.test/**` を1か所でまとめて受け、ルートごとに応答を返します。
- テストは「どの本文が送られたか」を記録から取り出して検証します（例: `expect(api.last('POST /generate').body.preset).toBe('carbon')`）。
- 応答の JSON は `e2e/fixtures/data/` に置きます。実際のジョブの結果から作る場合は、**個人情報と実在のユーザー ID を必ず取り除きます**。

### 5.6 CI への組み込み
- `infrastructure/buildspec/build.yml` の単体テストの後に L1 を足します（`npx playwright install --with-deps chromium` → `npm run e2e`）。失敗したら止めます。
- **所要時間の目標は 5 分以内**。超える場合は、別の CodeBuild プロジェクトに分けて並列にします。
- 失敗時のトレース・スクリーンショット・動画は CodeBuild のアーティファクトに残します。

## 6. テストを足すときの決まり
1. 新しい画面操作や API 呼び出しを足したら、L1 のシナリオを1本足す（少なくとも「送った本文」と「表示」を1つずつ確かめる）。
2. 新しい API ルートを足したら、L1 のモックと L2 の契約テストの両方を足す。
3. 名前で取れない要素に `data-testid` を足すときは、2.4 の命名に従う。
4. 固定の sleep、本物の宛先への通信、本物の資格情報は、レビューで差し戻す。
5. 不具合を直したら、再発を捕まえる L1 のテストを先に書いてから直す。

## 7. 段階計画

| 段階 | 内容 | 前提 |
|------|------|------|
| **1. 土台** | Playwright の導入、`playwright.config.ts`、`fixtures/auth.ts` と `fixtures/api.ts`、P1 の #2（ログイン済みで開く）と #3（生成して表示）の2本。iframe に `frameLocator` が届くかをここで確認 | なし |
| **2. P1 の残り** | #1・#4〜#7。CI（build.yml）へ組み込み、所要時間を測る | 段階1 |
| **3. L2 契約テスト** | モックの応答とバックエンドの実ハンドラの応答の形を比べるテストを `npm test` に追加 | 段階2 |
| **4. P2** | 履歴・公開・プラン・添付・管理画面など | 段階2 |
| **5. L3 実環境スモーク** | ステージングで、テスト用ユーザーとして1件だけ生成を通す（Haiku・節約、費用の上限つき） | ステージング環境、テスト用ユーザーとシークレット（管理者が用意） |

## 8. 未確定・要確認
- プレビューの iframe の作り（`blob:` / `srcdoc` / sandbox）で `frameLocator` が中に届くか（段階1で確認）
- CodeBuild のイメージで Chromium を動かしたときのビルド時間
- 名前で取れない要素がどれくらいあり、`data-testid` をどれだけ足す必要があるか
- L3 用のステージング環境の構成（エンタープライズ対応の P0 と合わせて決める）
