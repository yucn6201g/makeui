# Carbon Design System — コンポーネント実装例

値は `@carbon/themes` 11.81（white テーマ）、`@carbon/type`、`@carbon/layout`、`@carbon/styles` に基づく。
v11 の既定は角丸なし（タグだけが丸い）。

## ボタン
高さ 48px（large、既定）・40px（medium）・32px（small）。ラベルは左寄せで右に 64px の余白（アイコン用）。角丸 0。

```css
.cds-btn{display:inline-flex;align-items:center;min-height:48px;padding:0 64px 0 16px;border:1px solid transparent;border-radius:0;font:400 14px/1.29 'IBM Plex Sans JP','IBM Plex Sans',sans-serif;letter-spacing:0.16px;cursor:pointer}
.cds-btn--md{min-height:40px}
.cds-btn--sm{min-height:32px;padding-right:48px}
.cds-btn--primary{background:#0F62FE;color:#FFFFFF}
.cds-btn--primary:hover{background:#0050E6}
.cds-btn--primary:active{background:#002D9C}
.cds-btn--secondary{background:#393939;color:#FFFFFF}
.cds-btn--secondary:hover{background:#474747}
.cds-btn--tertiary{background:transparent;color:#0F62FE;border-color:#0F62FE}
.cds-btn--ghost{background:transparent;color:#0F62FE;padding:0 16px}
.cds-btn--danger{background:#DA1E28;color:#FFFFFF}
.cds-btn--danger:hover{background:#B81921}
.cds-btn:focus-visible{outline:2px solid #0F62FE;outline-offset:-2px;box-shadow:inset 0 0 0 1px #FFFFFF}
```

## テキスト入力
背景 #F4F4F4、枠は下線 1px #8D8D8D だけ。高さ 40px。ラベルは上に 12px #525252、補足は下に 12px #6F6F6F。

```css
.cds-field label{display:block;margin-bottom:8px;font-size:12px;line-height:1.33;letter-spacing:0.32px;color:#525252}
.cds-field input{width:100%;height:40px;padding:0 16px;border:none;border-bottom:1px solid #8D8D8D;border-radius:0;background:#F4F4F4;color:#161616;font-size:14px;letter-spacing:0.16px}
.cds-field input:hover{background:#E8E8E8}
.cds-field input:focus{outline:2px solid #0F62FE;outline-offset:-2px}
.cds-field input[aria-invalid="true"]{outline:2px solid #DA1E28;outline-offset:-2px}
.cds-helper{margin-top:4px;font-size:12px;color:#6F6F6F}
.cds-error{margin-top:4px;font-size:12px;color:#DA1E28}
```

## データテーブル
見出し行 #E0E0E0、行の高さ 48px、行の区切り 1px #E0E0E0。上にツールバー、下にページネーション。

```css
.cds-table{width:100%;border-collapse:collapse;font-size:14px;letter-spacing:0.16px}
.cds-table th{height:48px;padding:0 16px;background:#E0E0E0;color:#161616;font-weight:600;text-align:left}
.cds-table td{height:48px;padding:0 16px;border-bottom:1px solid #E0E0E0;color:#525252}
.cds-table tbody tr:hover td{background:#E8E8E8;color:#161616}
.cds-table tr[aria-selected="true"] td{background:#E0E0E0}
.cds-toolbar{display:flex;align-items:center;height:48px;background:#FFFFFF}
.cds-toolbar--batch{background:#0F62FE;color:#FFFFFF}
.cds-pagination{display:flex;align-items:center;justify-content:space-between;height:48px;padding:0 16px;border-top:1px solid #E0E0E0;background:#F4F4F4;font-size:14px}
```

## インライン通知
左に 3px の線、種類別の背景、アイコン・太字のタイトル・説明を1行に。

```css
.cds-inline-notification{display:flex;gap:12px;align-items:flex-start;min-height:48px;padding:14px 16px;border-left:3px solid currentColor;color:#161616}
.cds-inline-notification strong{font-weight:600}
.cds-inline-notification--error{border-left-color:#DA1E28;background:#FFF1F1}
.cds-inline-notification--success{border-left-color:#24A148;background:#DEFBE6}
.cds-inline-notification--warning{border-left-color:#F1C21B;background:#FCF4D6}
.cds-inline-notification--info{border-left-color:#0043CE;background:#EDF5FF}
```

## タグ・タブ・タイル

```css
.cds-tag{display:inline-flex;align-items:center;height:24px;padding:0 8px;border-radius:999px;background:#E0E0E0;color:#161616;font-size:12px}
.cds-tabs{display:flex;border-bottom:1px solid #E0E0E0}
.cds-tab{height:48px;padding:0 16px;border-bottom:2px solid transparent;color:#525252;font-size:14px}
.cds-tab[aria-selected="true"]{border-bottom-color:#0F62FE;color:#161616;font-weight:600}
.cds-tile{padding:16px;background:#F4F4F4;border-radius:0}
.cds-menu{background:#F4F4F4;box-shadow:0 2px 6px rgba(0,0,0,0.3)}
```
