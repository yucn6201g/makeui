# Material Design 3 — レイアウトと画面構成

## ウィンドウサイズに応じたレイアウト
- compact（< 600px）: 上に top app bar、下に navigation bar（3〜5項目）
- medium（600〜839px）: 左に navigation rail（幅 80px）
- expanded（≥ 840px）: navigation rail または navigation drawer。一覧と詳細を左右の2ペインに並べる

画面の左右の余白は compact 16px、medium 以上 24px。8px グリッド。

## 面の分け方
影ではなく面のトーンで分ける。背景 #FEF7FF（surface）の上に、低い順に
#FFFFFF（lowest）→ #F7F2FA（low）→ #F3EDF7（container）→ #ECE6F0（high）→ #E6E0E9（highest）。
影（elevation）は FAB・elevated カード・メニューなど浮く要素だけ。

## 画面の型
- 一覧画面: 検索付きの top app bar、フィルタチップの行、リストまたはカードのグリッド。作成は右下の FAB
- 詳細画面: 戻る矢印と操作を持つ top app bar、ヘッダー（ヒーロー画像やタイトル）、内容のセクション。expanded では一覧の横のペインに表示
- フォーム: outlined テキストフィールドを1カラム、間隔 16〜24px。下に filled ボタン（compact では横幅いっぱい）
- ダイアログ: 角丸 28px、見出しは headline-small、操作はテキストボタンを右寄せ

## タイポグラフィ
書体 Roboto, 'Noto Sans JP'。
display-small 36/44・headline-medium 28/36・headline-small 24/32・title-large 22/28・title-medium 16/24/500・body-large 16/24（tracking 0.5px）・body-medium 14/20（0.25px）・label-large 14/20/500。

## 形
角丸の段階: 0・4px・8px・12px・16px・28px・丸形。
ボタンは丸形、チップ 8px、カード 12px、FAB 16px、ダイアログ 28px、テキストフィールド 4px。

## 色
主色は #6750A4（ベースライン）、淡い面は primary-container #EADDFF と secondary-container #E8DEF8。
文字は on-surface #1D1B20 と on-surface-variant #49454F、枠は outline #79747E と outline-variant #CAC4D0、エラーは #B3261E。
状態レイヤー: ホバー 8%、フォーカス・押下 10% を要素の上に重ねる。

## 動き
標準の easing cubic-bezier(0.2, 0, 0, 1)。小さな変化 200ms、大きな遷移 300〜400ms。
