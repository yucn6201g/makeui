# Spindle（Ameba デザインシステム）— レイアウトと画面構成

## モバイル優先
375px 幅で先に設計し、広い画面ではコンテンツを中央の列（本文は最大 720px 前後、グリッドは 1080px）に置く。
画面の左右の余白: モバイル 16px、タブレット 24px、デスクトップ 40px。

## シェル
- 上部バー: サービス名または戻る矢印 + 画面タイトル、右に操作
- 主要画面の下部ナビゲーション（4〜5項目）。デスクトップでは同じ行き先を横並びのヘッダーナビにする

```css
.sp-topbar{display:flex;align-items:center;gap:12px;height:56px;padding:0 16px;background:#FFFFFF;border-bottom:1px solid #08121A14}
.sp-bottomnav{position:fixed;inset:auto 0 0 0;display:flex;height:64px;background:#FFFFFF;border-top:1px solid #08121A14}
.sp-bottomnav a{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;font-size:12px;color:#08121A9C}
.sp-bottomnav a[aria-current="page"]{color:#298737;font-weight:700}
```

## 画面の型
- フィード・一覧: サムネイル付きのカードまたはリスト行。タイトル（太字）、メタ情報1行（中の濃さ）、リアクション行（いいね・コメント）。中身が先
- 詳細: ヒーロー画像またはタイトル、アバター付きの著者・メタ行、本文 16px/1.8、関連コンテンツ。モバイルでは画面下に固定のアクションバー
- フォーム: 1行1項目、ラベルは上、下に横幅いっぱいの contained ボタン
- 空状態・完了: 自作のイラスト、1文の説明、1つの操作

## 余白の段階（px）
4 / 6 / 8 / 12 / 14 / 16 / 20 / 24 / 28 / 36 / 40 / 44 / 48 / 56 / 64 / 72 / 80 / 96。
要素間は 16〜24px。タップ領域は 44px 以上。

## 色の使い方
アクセントは Ameba グリーン #298737 の1色（押下・ホバー #0F5C1F、淡い面 #E7F5E9）。
灰色は別の色を足さず、インク #08121A の透過（#08121A0A・#08121A14・#08121A4D・#08121A9C・#08121ABD）で作る。
エラー・注意は #D91C0B、フォーカスは #0091FF。

## 書体
'Helvetica Neue', Helvetica, Arial, 'Segoe UI', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', Meiryo, sans-serif。
見出し 700 / 1.3、本文 16px / 400 / 1.6（長文は 1.8）。サイズは 28 / 22 / 20 / 17 / 16 / 14 / 13 / 12px。
