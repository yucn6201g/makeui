# Carbon Design System — レイアウトと画面構成

## UI シェル
上に高さ 48px の暗いヘッダー（#161616、製品名を左、グローバル操作を右）。複数セクションの製品は左に幅 256px のサイドナビ（#FFFFFF、項目の高さ 32px）。

```css
.cds-header{display:flex;align-items:center;height:48px;padding:0 16px;background:#161616;color:#F4F4F4;font-size:14px;font-weight:600}
.cds-sidenav{width:256px;background:#FFFFFF;border-right:1px solid #E0E0E0}
.cds-sidenav a{display:flex;align-items:center;height:32px;padding:0 16px;color:#525252;font-size:14px}
.cds-sidenav a[aria-current="page"]{background:#E0E0E0;color:#161616;box-shadow:inset 3px 0 0 #0F62FE}
```

## グリッドと余白
2x グリッド。大画面は16カラム、ガター 32px。ブレークポイント sm 320・md 672・lg 1056・xl 1312・max 1584。
余白の段階（px）: 2 / 4 / 8 / 12 / 16 / 24 / 32 / 40 / 48 / 64 / 80 / 96 / 160。

## ページの組み立て
- ページ見出し: パンくず、heading-04（28px/400）または heading-05（32px/400）の見出し、その直下にタブ（任意）
- 一覧画面: ツールバー（左に検索、右にフィルタと主操作）→ データテーブル → ページネーション。行を選ぶとツールバーが一括操作バー（#0F62FE）に置き換わる
- 詳細画面: 構造化リストまたはタイルを16カラムのグリッドに配置。操作はページ見出しの右
- フォーム: 1カラム（グリッド8カラム幅まで）、グループ間 32px、ボタンは下の左端に置き、セカンダリをその左に並べる
- ダッシュボード: #F4F4F4 のタイルを 1px の隙間で並べる。数値は heading-05

## タイポグラフィ（productive）
本文は body-01（14px/1.43、letter-spacing 0.16px）。見出しは 20px 以上だと太さ 400 — 太さではなく大きさと余白で階層を作る。
書体は 'IBM Plex Sans JP', 'IBM Plex Sans'。コードは 'IBM Plex Mono'。

## 形と奥行き
角丸なし（タグのみ丸）。パネルやタイルは影ではなく背景の階層（#FFFFFF → #F4F4F4 → #E8E8E8 → #E0E0E0）で分ける。
影を使うのはメニューやドロップダウンなど浮く要素だけ（0 2px 6px rgba(0,0,0,0.3)）。
動きは productive: 70ms / 110ms、cubic-bezier(0.2, 0, 0.38, 0.9)。
