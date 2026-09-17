# backend/scripts

手で走らせる運用スクリプトです。`npm test` からも CI/CD からも呼ばれないので、
参照が無いことを理由に消さないでください。

| スクリプト | 用途 |
|---|---|
| `vendor-react.mjs` | React / Vue / Svelte のランタイムを `src/vendor/` に取り込む。**唯一自動で走る**（`npm run vendor` が `build` と `test` の前段） |
| `curate-images.mjs` | ストック画像ライブラリを構築して S3 へ置く |
| `subjects.mjs` | `curate-images.mjs` が使う被写体の分類表。単体では走らせない |
| `set-user-limit.sh` | 1ユーザの月間トークン上限を設定する |
| `fetch-model-pricing.mjs` | AWS が公開している価格ページから、このプロジェクトが実際に呼ぶモデルの価格表を組み立てる |
| `set-model-pricing.sh` | その価格表を SSM `/makeui/pricing/models` と Lambda に設定する |
| `storage-audit.mjs` | テーブルとバケットを突き合わせ、**もう誰も読めない／二重に持っている**データを報告する。`--fix-job-ttl` だけが修復系 |
| `backfill-project-s3.mjs` | プロジェクト行に残ったインライン文書を S3 へ移す（一度きり・実行済み） |
| `backfill-version-s3.mjs` | バージョン行に残ったインライン文書を S3 へ移す（一度きり・実行済み） |
| `purge-probe-users.mjs` | 検証用スクリプトが作ったユーザ（`verify-*`・`probe-*` など、uuid でない id）の行と S3 文書を消す。**既定は報告のみ、`--write` で削除**。計測に使い終わってから走らせる |

### 計測スクリプト（モデル呼び出しなし）

どれも CloudWatch Logs（Runtime のロググループ）か保存済みの文書を読むだけで、**トークンを使いません**。
パイプラインを変える提案は、まずこれらで「実際にどこで何が起きているか」を確かめてからにします。

| スクリプト | 何に答えるか | 既定の期間 |
|---|---|---|
| `pipeline-outcomes.mjs [days]` | **2026-09-13 の変更が本番で何をしているか**を1回で読む。要件の達成、修復の受理と却下の理由、重み付けで受理された件数、判定前の自動修正、壊れた候補の保存（S3 権限の失敗も）、`export-missing` の修正と出荷、ファイル1つずつの救済、コントラスト自動修正、再計測、ブラウザ巡回（時間切れ・押した数・確認クリック・タイムゾーン・押しても動かない率）、**2026-09-14 の変更**（差分形式の修復の割合・返答の長さ・適用できなかった数、絵文字と default import の決定的な書き換え、アプリを壊した修復案の React #130 と Web ストレージのエラー） | 7日 |
| `token-stages.mjs` | 1回の生成・編集のトークンが、どの工程にどれだけ行くか | — |
| `token-effect.mjs` | トークン削減の変更が、ノイズと区別できる効果を出したか | — |
| `cache-yield.mjs` | プロンプトキャッシュの区切りが元を取っているか（読み取りは読んだ側に計上される点に注意） | — |
| `repair-passes.mjs` | 修復パス1回ごとに何が得られているか（パス数の上限を決める材料） | 45日 |
| `repair-change-size.mjs [days]` | 修復・編集がファイルの何割を変えているか。**差分形式を作るかの判断基準（30ファイル未満は判断しない、40%以下なら作る、70%以上なら作らない）がスクリプト内に書いてあります** | 7日 |
| `fix-rates.mjs [days]` | 欠陥の id ごとに、修復パスが直した割合。`src/orchestration/repair-yield.ts` の `FIX_RATE` を作り直す | 30日 |
| `defect-survival.mjs [days]` | 欠陥が実行の終わりにまだ残っていた割合（利用者が受け取る側の数字）。`SURVIVAL` を作り直す | 30日 |
| `retry-rates.mjs [days]` | 同じ実行の中で、同じ欠陥に2回目・3回目の修復をする価値があるか。`RETRY_RATE` を作り直す | 45日 |
| `retry-cost.mjs [days]` | 欠陥を修復の対象から外すと、実際に何トークン減るか | 45日 |
| `defect-growth.mjs` | 「修復を受理したのに欠陥数が増えた」が、悪化なのか数え方の揺れなのか | — |
| `score-items.mjs [n]` | スコアの評価項目のうち、実際に差を生んでいるものはどれか（S3 の保存済み文書を採点し直す） | 60文書 |
| `replay-walk.mjs [--out dir] [--serve port] <doc>...` | **保存済みの出力を、今の巡回コードでブラウザで巡回し直す。** 入力はローカルの文書・`s3://…`・`job:<id>`・`label:<prefix>`。実行可能なページ・巡回式・一括巡回ページ `replay.html` を作り、`--serve` で配信する。塗り率と隠している要素、箇条書きのナビ、巨大アイコン、シェルの計測値、例外を出したコントロールを並べる。**実行時の指摘を直す前に、まずこれで誤検知かどうかを確かめる** | — |
| `compare-report.mjs <label>...` | `compare-generate.mjs` で走らせた実行を、ラベルごとに並べて平均を出す（スコア・要件・未解決の指摘・トークンと工程別の出力・修復の採用と却下・差分形式の返答の長さ） | ラベルの実行が始まってから |

### 比較のための生成（**費用がかかる**）

| スクリプト | 用途 |
|---|---|
| `compare-generate.mjs --label <名前> [--briefs 0,1,2] [--repeat n] [--no-briefing] [--yes]` | 本番の Runtime を直接呼び、固定の依頼文（会議室予約・在庫管理・フラッシュカード）で Haiku の仕上げ生成を走らせる。**1回あたり約0.5ドル**。`--yes` が無いと実行せず、回数と見込み額だけ表示する。利用者は既定で `probe-compare`（誰の月間使用量にも入らず、`purge-probe-users.mjs` で消せる）。`--no-briefing` は要件を設計とビルドに渡さない実験用フラグ（公開 API からは指定できない） |

依頼文は 2026-09-14 のベースライン（変更前: 平均19.7万トークン・スコア77、6回）と同じなので、新しい実行と比べられます。
スコアは同じ入力でも約11点ぶれるため、3回程度の平均の差がそれより小さければ結論にしません。

> **期間の取り方に注意.** 2026-09-13 に修復判定の基準（測り直しの対称化・重み付け）と、
> ブラウザ巡回の誤検知（押しても動かない）が変わりました。`fix-rates`・`defect-survival`・
> `repair-passes` などを読むときは、**この日より後だけ**を対象にしてください。前後を混ぜると、
> 修正率や受理率が実際以上に動いて見えます。

## モデル別の価格表

```bash
node scripts/fetch-model-pricing.mjs > prices.json   # AWS から取得
./scripts/set-model-pricing.sh prices.json           # 設定
./scripts/set-model-pricing.sh --show                # 現在値
./scripts/set-model-pricing.sh --clear               # 解除
```

月間上限は `input + output` をモデルに関係なく数えていました。実測すると、出力が
数える分の43%を占め（44実行で入力5,954,020 / 出力4,497,258）、キャッシュの読み書き
1,334,606トークン（数える分の12.8%）は課金されているのに1つも数えられていません。

価格はこのリポジトリに書きません。AWS の Pricing API が ap-northeast-1 について
返すのは Claude 2.0 / 2.1 / 3 Haiku / 3 Sonnet だけで、**このプロジェクトが実際に
動かしているモデルはどのリージョンにも入っていません**。

代わりに `fetch-model-pricing.mjs` が価格ページから読みます。ページの各セルは
`{priceOf!…!<hash>}` というトークンで、実際の数値は
`b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/…` のフィードにあります。

**行は SSM の `/makeui/models/*` から決めます** — `sonnet` は Sonnet 5 ではなく
Sonnet 4.6 で、ページには両方載っており価格は1.5倍違います。**列はヘッダ文字列で
一致させます** — バッチ列を on-demand と読むと半額になり、しかも何も気づけません。
キャッシュ書き込みは5分の列です（`prompt-cache.ts` が `ttl` なしの `ephemeral` を
送るため）。

保存先は SSM `/makeui/pricing/models`（`/makeui/models/*` の隣）と Lambda の環境変数。
**Runtime はこのスクリプトからは書きません** — `update-agent-runtime` は設定を
置き換えるので、ライブ設定を読み戻して再適用する `deploy-runtime.sh` だけが触ります。
Runtime は次のデプロイで拾い、そこから `weightedTokens` の記録が始まります。

**未設定のうちは全部の重みが1で、上限の挙動は今までと同じです。** 設定すると
`weightedTokens`（＝一番安い入力トークン何個ぶんか）で判定されるようになります。
Haiku の入力なら重み1なので、既存の100万という上限の意味はほぼ変わりません。

## ストレージ監査

```bash
node scripts/storage-audit.mjs
```

書き込み経路を直しても、直す前に書かれた行とオブジェクトは残ります。この
スクリプトは「これを読む経路がまだあるか」を種類ごとに突き合わせて報告します
— S3 にあって行が指していないドキュメント、消えたプロジェクトのチャット、
`ttl` の無いジョブ記録、行に残った文書のコピー。

**孤児オブジェクトは削除しません。** 2026-09-02 の 27 個のように、行の書き込み
がスロットルされて記録されなかった生成の唯一の痕跡であることがあり、それを
消すかどうかは人が決めることです。

## ストック画像ライブラリ

```bash
node scripts/curate-images.mjs
```

生成 UI に入る写真は、このスクリプトが事前に集めた CC0 画像から選ばれます。
現在 `s3://makeui-outputs-<ACCOUNT_ID>/stock/` に **3,642 オブジェクト / 約 936 MB**。

一度だけ走らせるもので、生成のたびには走りません。**利用者が待っている間に
第三者へ何も送らず、ブリーフの内容がリージョンの外に出ない**というのが、
実行時に外部 API を呼ばずこの形にしている理由です。

被写体の分類は `subjects.mjs` にあります。以前は office / people / workspace /
city / nature / abstract / product の7つしかなく、その粗さ自体が不具合でした
— バターを売る店が「product」を要求して棚の写真を受け取る、というのが実測です。

## ユーザの上限設定

```bash
./scripts/set-user-limit.sh <user-id> <monthly-token-limit>
./scripts/set-user-limit.sh abc123-def456 500000
```
