# Spindle（Ameba デザインシステム）— コンポーネント実装例

値は `@openameba/spindle-tokens` 1.10、リポジトリの theme-light トークン、`@openameba/spindle-ui` 3.3 に基づく。
Spindle のアイコンは CC BY-NC-ND のため使わない。アイコンは自作の線画にする。

## ボタン
角丸は丸形（3em）。大 48px・中 40px・小 32px。文字は太字、line-height 1.3。モバイルでは横幅いっぱい。

```css
.sp-btn{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;font-weight:700;line-height:1.3;border-radius:3em;cursor:pointer;transition:background-color .3s}
.sp-btn--large{min-height:48px;padding:8px 16px;font-size:16px}
.sp-btn--medium{min-height:40px;padding:8px 16px;font-size:14px}
.sp-btn--small{min-height:32px;padding:6px 10px;font-size:13px}
.sp-btn--contained{background:#298737;color:#FFFFFF;border:none}
.sp-btn--contained:hover{background:#0F5C1F}
.sp-btn--outlined{background:transparent;color:#298737;border:2px solid #298737}
.sp-btn--outlined:hover{background:#E7F5E9}
.sp-btn--lighted{background:#E7F5E9;color:#237B31;border:none}
.sp-btn--lighted:hover{background:#C6E5C9}
.sp-btn--neutral{background:#08121A14;color:#08121ABD;border:none}
.sp-btn--danger{background:transparent;color:#D91C0B;border:2px solid #D91C0B}
.sp-btn:disabled{opacity:.3}
.sp-btn:focus-visible{outline:2px solid #0091FF;outline-offset:1px}
```

## テキストフィールド
高さ 48px（小 40px）、枠 1px #08121A4D、角丸 8px、文字 16px。

```css
.sp-field label{display:block;margin-bottom:8px;font-size:14px;font-weight:700;color:#08121A}
.sp-field input{width:100%;min-height:48px;padding:0 16px;border:1px solid #08121A4D;border-radius:8px;background:#FFFFFF;color:#08121A;font-size:16px}
.sp-field input:focus{outline:2px solid #0091FF;outline-offset:1px}
.sp-field input[aria-invalid="true"]{border-color:#D91C0B}
.sp-field__error{margin-top:6px;font-size:13px;color:#D91C0B}
.sp-field__help{margin-top:6px;font-size:13px;color:#08121A9C}
```

## カード・リスト
文字の濃さは同じインク #08121A の透過で段階をつける（高 #08121A、中 #08121ABD、低 #08121A9C）。

```css
.sp-card{display:block;border-radius:12px;background:#FFFFFF;box-shadow:0 3.25px 7.75px 0 #08121A1F;overflow:hidden}
.sp-card__title{font-size:16px;font-weight:700;line-height:1.3;color:#08121A}
.sp-card__meta{font-size:13px;color:#08121A9C}
.sp-list-item{display:flex;align-items:center;gap:12px;min-height:56px;padding:12px 16px;border-bottom:1px solid #08121A14;color:#08121A;font-size:16px}
.sp-avatar{width:40px;height:40px;border-radius:50%}
```

## インライン通知・スナックバー

```css
.sp-inline-notification{display:flex;gap:8px;align-items:center;padding:8px 16px;border-radius:12px;background:#E7F5E9;color:#08121A;font-size:14px}
.sp-inline-notification--caution{background:#D91C0B0D;color:#D91C0B}
.sp-snackbar{display:flex;align-items:center;gap:16px;padding:14px 16px 14px 20px;border-radius:4px;background:#394148;color:#FFFFFF;font-size:14px}
```

## ダイアログ・セミモーダル・メニュー

```css
.sp-dialog{max-width:400px;padding:24px;border-radius:20px;background:#FFFFFF;box-shadow:0 11px 28px 0 #08121A1F}
.sp-dialog__actions{display:flex;flex-direction:column;gap:8px;margin-top:24px}
.sp-semimodal{border-radius:20px 20px 0 0;background:#FFFFFF;padding:24px 16px}
.sp-menu{border-radius:12px;background:#FFFFFF;box-shadow:0 4.75px 14.25px 0 #08121A1F;padding:8px 0}
```

## 動き
速い 150ms、標準 350ms。easing は ease-out cubic-bezier(0,0,0,1)。いいね・バッジなど小さく現れる要素にだけ弾み cubic-bezier(0.55,2.05,0.65,0.75) を使ってよい。
