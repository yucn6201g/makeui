# デジタル庁デザインシステム — コンポーネント実装例

値は `@digital-go-jp/design-tokens` 2.0.1 と公式のサンプルコンポーネント（React 版）に基づく（DADS v2.18.0）。

## ボタン
大 56px・中 48px・小 36px・極小 28px。角丸は大・中 8px、小 6px、極小 4px。文字は 16px/700。
ホバーで背景が一段濃くなり、下線が付くのがこのシステムの特徴。

```css
.da-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;min-width:96px;min-height:48px;padding:0 16px;border-radius:8px;font:700 16px/1 'Noto Sans JP',sans-serif;cursor:pointer;text-underline-offset:3px}
.da-btn--lg{min-height:56px}
.da-btn--sm{min-height:36px;border-radius:6px;padding:0 12px}
.da-btn--primary{background:#0017C1;color:#FFFFFF;border:4px double transparent}
.da-btn--primary:hover{background:#00118F;text-decoration:underline}
.da-btn--primary:active{background:#000060}
.da-btn--outline{background:#FFFFFF;color:#0017C1;border:1px solid currentColor}
.da-btn--outline:hover{background:#C5D7FB;color:#00118F;text-decoration:underline}
.da-btn--text{background:transparent;color:#0017C1;border:none;text-decoration:underline}
.da-btn--text:hover{background:#E8F1FE;text-decoration-thickness:3px}
.da-btn[aria-disabled="true"]{background:#B3B3B3;color:#F2F2F2;pointer-events:none}
.da-btn:focus-visible{outline:4px solid #000000;outline-offset:2px;box-shadow:0 0 0 2px #FFD43D}
```

## 入力欄（テキスト・セレクト・テキストエリア）
枠は 1px #666666、角丸 8px、高さ 大 56px・中 48px・小 40px。ラベルは欄の上、エラーは欄の下。
プレースホルダをラベル代わりにしない。読み取り専用は破線の枠。

```html
<div class="da-field">
  <label for="applicant">申請者氏名<span class="da-req">必須</span></label>
  <input id="applicant" type="text" aria-describedby="applicant-help applicant-err" aria-invalid="true">
  <p id="applicant-help" class="da-help">住民票の記載どおりに入力してください</p>
  <p id="applicant-err" class="da-err">氏名を入力してください</p>
</div>
```

```css
.da-field label{display:block;font:700 16px/1.7 'Noto Sans JP',sans-serif;color:#1A1A1A;margin-bottom:8px}
.da-req{margin-left:8px;padding:0 8px;border-radius:8px;background:#EC0000;color:#FFFFFF;font-size:14px}
.da-field input,.da-field select,.da-field textarea{width:100%;min-height:48px;padding:12px 16px;border:1px solid #666666;border-radius:8px;background:#FFFFFF;color:#333333;font-size:16px}
.da-field input:hover{border-color:#000000}
.da-field input:focus{outline:4px solid #000000;outline-offset:2px;box-shadow:0 0 0 2px #FFD43D}
.da-field input[aria-invalid="true"]{border-color:#EC0000}
.da-field input:read-only{border-style:dashed}
.da-field input:disabled{border-color:#B3B3B3;background:#F2F2F2;color:#949494}
.da-help{font-size:16px;color:#666666;margin:8px 0 0}
.da-err{font-size:16px;color:#CE0000;margin:8px 0 0;font-weight:700}
```

## データテーブル（申請一覧・審査状況）
行政の一覧は装飾を持たせない。数値は右寄せ・等幅数字。

```css
.da-table{width:100%;border-collapse:collapse;font-size:16px;line-height:1.3}
.da-table th{background:#F2F2F2;font-weight:700;text-align:left;padding:12px 16px;border-bottom:1px solid #CCCCCC}
.da-table td{padding:12px 16px;border-bottom:1px solid #CCCCCC}
.da-table .num{text-align:right;font-variant-numeric:tabular-nums}
.da-table tbody tr:hover{background:#E8F1FE}
```

## ステータスバッジ
色だけで意味を伝えない。必ず文字を伴わせる。

```css
.da-badge{display:inline-block;padding:2px 8px;border-radius:8px;font-size:16px;color:#FFFFFF;background:#767676}
.da-badge--done{background:#197A4B}
.da-badge--error{background:#CE0000}
.da-badge--review{background:#927200}
```

## 通知バナー
締切・必要書類・エラーなど、見落としてはいけない情報に使う。トーストで済ませない。

```css
.da-banner{display:grid;grid-template-columns:auto 1fr;gap:8px 16px;padding:16px 24px;border:1px solid currentColor;border-radius:8px;background:#FFFFFF}
.da-banner__title{font:700 17px/1.7 'Noto Sans JP',sans-serif;color:#1A1A1A}
.da-banner--success{color:#197A4B}
.da-banner--error{color:#CE0000}
.da-banner--warning{color:#C74700}
.da-banner--info{color:#0017C1}
```

## リンク
常に下線。訪問済みは #8B008B。

```css
.da-link{color:#00118F;text-decoration:underline;text-underline-offset:3px}
.da-link:visited{color:#8B008B}
.da-link:hover{text-decoration-thickness:3px}
.da-link:focus-visible{outline:4px solid #000000;outline-offset:2px;background:#FFD43D;border-radius:4px}
```
