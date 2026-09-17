# デジタル庁デザインシステム — レイアウトと画面構成

## 基本骨格
コンテンツ最大幅 1200px 中央寄せ、12カラム、ガター 24px。モバイル < 768px、タブレット 768〜1023px、デスクトップ ≥ 1024px。
ヘッダーは白背景と下 1px #CCCCCC、サービス名を左、ユーティリティリンクを右。常設のサイドバーは置かない（1ページ1タスク）。

## 手続きページの標準構成
1. パンくず（現在地の明示）
2. ページ見出し（32px/700/1.5）
3. 概要文（16px/1.7、letter-spacing 0.02em）
4. ステップナビゲーション（全ステップを表示し、現在のステップに aria-current="step"）
5. 入力セクション（見出し 24px/700、セクション間 40px、項目間 24px）
6. 確認画面（入力値をすべて読み取り専用の定義リストで再表示してから送信）
7. 完了画面（受付番号と次に行うこと）

```css
.da-steps{display:flex;list-style:none;padding:0;margin:0 0 40px;counter-reset:step}
.da-steps li{flex:1;padding:12px 16px;border-bottom:4px solid #CCCCCC;font-size:16px;color:#666666}
.da-steps li[aria-current="step"]{border-bottom-color:#0017C1;font-weight:700;color:#0017C1}
.da-confirm{display:grid;grid-template-columns:240px 1fr;border-top:1px solid #CCCCCC}
.da-confirm dt,.da-confirm dd{margin:0;padding:16px;border-bottom:1px solid #CCCCCC}
.da-confirm dt{background:#F2F2F2;font-weight:700}
```

## 一覧画面
見出し、一覧の説明文、検索欄と絞り込み（枠付きのセレクトと入力欄。チップだけにしない）、テーブル、ページ送り。

## 詳細画面
見出し、ステータスバッジ、定義リスト（dt/dd）。操作ボタンは本文の最後にまとめ、進む操作を先に置く。

## 浮かせる要素の影
ページ上のカードやパネルは影なしで 1px の枠。影はドロップダウン・ダイアログ・スクロール時の固定ヘッダーだけに使う。

```css
.da-menu{box-shadow:0 2px 8px 1px rgba(0,0,0,0.1),0 1px 5px 0 rgba(0,0,0,0.3);border-radius:8px;background:#FFFFFF}
.da-dialog{box-shadow:0 4px 16px 3px rgba(0,0,0,0.1),0 1px 6px 0 rgba(0,0,0,0.3);border-radius:16px;padding:32px}
```

## アクセシビリティ要件（JIS X 8341-3 AA）
- 本文 #1A1A1A on #FFFFFF。テキストに使える最も薄い灰色は #767676（4.5:1）、テキスト以外の枠は #949494（3:1）以上
- フォーカスは黒 4px のアウトライン（offset 2px）と黄 #FFD43D のリング。outline:none 単独使用は禁止
- 見出しレベルを飛ばさない。ランドマーク必須
- 本文 16px 以上、行間 1.7。リンクは下線を維持
