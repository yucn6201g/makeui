# Material Design 3 — コンポーネント実装例

値は `@material/web` 2.5 のトークン（v0_192、ベースラインのライトスキーム）に基づく。

## ボタン
高さ 40px、左右 24px、角丸は丸形、文字は label-large（14px/500/20px、tracking 0.1px）。

```css
.m3-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:40px;padding:0 24px;border:none;border-radius:9999px;font:500 14px/20px Roboto,'Noto Sans JP',sans-serif;letter-spacing:0.1px;cursor:pointer;transition:background-color 200ms cubic-bezier(0.2,0,0,1),box-shadow 200ms cubic-bezier(0.2,0,0,1)}
.m3-btn--filled{background:#6750A4;color:#FFFFFF}
.m3-btn--filled:hover{box-shadow:0 1px 2px rgba(0,0,0,0.3),0 1px 3px 1px rgba(0,0,0,0.15)}
.m3-btn--tonal{background:#E8DEF8;color:#1D192B}
.m3-btn--outlined{background:transparent;color:#6750A4;border:1px solid #79747E}
.m3-btn--text{background:transparent;color:#6750A4;padding:0 12px}
.m3-btn--elevated{background:#F7F2FA;color:#6750A4;box-shadow:0 1px 2px rgba(0,0,0,0.3),0 1px 3px 1px rgba(0,0,0,0.15)}
.m3-fab{width:56px;height:56px;border-radius:16px;background:#EADDFF;color:#21005D;box-shadow:0 1px 3px rgba(0,0,0,0.3),0 4px 8px 3px rgba(0,0,0,0.15)}
```

## テキストフィールド
高さ 56px。filled は上だけ角丸 4px と下線、outlined は 1px の枠と角丸 4px。フォーカスで 2px #6750A4。

```css
.m3-field{position:relative}
.m3-field input{width:100%;height:56px;padding:24px 16px 8px;font:400 16px/24px Roboto,'Noto Sans JP',sans-serif;color:#1D1B20}
.m3-field--filled input{background:#E6E0E9;border:none;border-bottom:1px solid #49454F;border-radius:4px 4px 0 0}
.m3-field--filled input:focus{outline:none;border-bottom:2px solid #6750A4}
.m3-field--outlined input{background:transparent;border:1px solid #79747E;border-radius:4px;padding:16px}
.m3-field--outlined input:focus{outline:none;border:2px solid #6750A4}
.m3-field label{position:absolute;left:16px;top:8px;font-size:12px;color:#49454F}
.m3-field input[aria-invalid="true"]{border-color:#B3261E}
.m3-supporting{margin:4px 16px 0;font-size:12px;color:#49454F}
```

## カード・チップ・リスト

```css
.m3-card{padding:16px;border-radius:12px}
.m3-card--elevated{background:#F7F2FA;box-shadow:0 1px 2px rgba(0,0,0,0.3),0 1px 3px 1px rgba(0,0,0,0.15)}
.m3-card--filled{background:#E6E0E9}
.m3-card--outlined{background:#FEF7FF;border:1px solid #CAC4D0}
.m3-chip{display:inline-flex;align-items:center;gap:8px;height:32px;padding:0 16px;border:1px solid #79747E;border-radius:8px;font:500 14px/20px Roboto,'Noto Sans JP',sans-serif;color:#49454F}
.m3-chip[aria-pressed="true"]{background:#E8DEF8;border-color:transparent;color:#1D192B}
.m3-list-item{display:flex;align-items:center;gap:16px;min-height:56px;padding:8px 16px;color:#1D1B20;font-size:16px}
.m3-list-item--two-line{min-height:72px}
.m3-list-item__supporting{font-size:14px;color:#49454F}
```

## ナビゲーション

```css
.m3-top-app-bar{display:flex;align-items:center;gap:8px;height:64px;padding:0 16px;background:#FEF7FF;font:400 22px/28px Roboto,'Noto Sans JP',sans-serif;color:#1D1B20}
.m3-top-app-bar--scrolled{background:#F3EDF7}
.m3-nav-bar{display:flex;height:80px;background:#F3EDF7}
.m3-nav-bar a{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;font:500 12px/16px Roboto,'Noto Sans JP',sans-serif;color:#49454F}
.m3-nav-bar .indicator{display:grid;place-items:center;width:64px;height:32px;border-radius:9999px}
.m3-nav-bar a[aria-current="page"] .indicator{background:#E8DEF8;color:#1D192B}
.m3-nav-rail{width:80px;background:#FEF7FF}
```

## ダイアログ・スナックバー

```css
.m3-dialog{max-width:560px;padding:24px;border-radius:28px;background:#ECE6F0;color:#49454F}
.m3-dialog h2{margin:0 0 16px;font:400 24px/32px Roboto,'Noto Sans JP',sans-serif;color:#1D1B20}
.m3-dialog__actions{display:flex;justify-content:flex-end;gap:8px;margin-top:24px}
.m3-scrim{background:rgba(0,0,0,0.32)}
.m3-snackbar{display:flex;align-items:center;gap:12px;min-height:48px;padding:0 16px;border-radius:4px;background:#322F35;color:#F5EFF7;font-size:14px}
.m3-snackbar button{color:#D0BCFF}
```
