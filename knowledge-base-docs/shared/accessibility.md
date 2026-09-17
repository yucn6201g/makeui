# 共通 — アクセシビリティ要件

配色やプリセットに関わらず、以下は常に満たす。

## 構造
- ランドマーク: header / nav / main / footer を使う
- h1 は1画面に1つ。見出しレベルを飛ばさない
- リストは ul/ol、表は table + th[scope]

## フォーカス
```css
:focus-visible{outline:2px solid currentColor;outline-offset:2px}
```
outline:none を単独で書かない。モーダルを開いたら中の要素にフォーカスを移す。

## ラベルと状態
- 入力には必ず label（for/id）。プレースホルダで代替しない
- 補足・エラーは aria-describedby で結び付ける
- エラーは role="alert"、不正値は aria-invalid="true"
- アイコンのみのボタンは aria-label
- 現在地は aria-current="page"（ナビ）/ "step"（手順）

## 色とコントラスト
本文 4.5:1 以上、大きな文字 3:1 以上。
状態を色だけで示さない（必ず文字か形を伴わせる）。

## モーション
```css
@media (prefers-reduced-motion: reduce){
  *,*::before,*::after{animation-duration:.01ms !important;transition-duration:.01ms !important}
}
```

## タッチとキーボード
タッチ target は44px以上。Tab順序が視覚順と一致すること。
Escape でオーバーレイが閉じること。
