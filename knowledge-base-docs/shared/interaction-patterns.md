# 共通 — インタラクション実装パターン

生成するモックは「動く」ことを前提とする。以下は配色に依存しない実装の型。

## 画面遷移（ハッシュルーター・依存ライブラリなし）
```js
const screens = [...document.querySelectorAll('[data-screen]')];
function show(id){
  screens.forEach(s => s.classList.toggle('is-active', s.dataset.screen === id));
  document.querySelectorAll('[data-goto]').forEach(a =>
    a.toggleAttribute('aria-current', a.dataset.goto === id));
}
addEventListener('hashchange', () => show(location.hash.slice(2) || 'home'));
document.addEventListener('click', e => {
  const t = e.target.closest('[data-goto]'); if(!t) return;
  e.preventDefault(); location.hash = '#/' + t.dataset.goto;
});
show(location.hash.slice(2) || 'home');
```
ブラウザの戻る／進むが機能すること。未知のルートは先頭画面へフォールバックする。

## 状態と再描画
```js
const state = { items: seed, cart: [], filter: '' };
function render(){ /* state から DOM を作り直す */ }
function mutate(fn){ fn(state); render(); }
```
ハンドラ内で innerHTML を直接書き換えない。必ず state を変えて render() を呼ぶ。

## カート追加（合計・バッジ・空状態）
```js
mutate(s => {
  const hit = s.cart.find(c => c.id === id);
  hit ? hit.qty++ : s.cart.push({ id, qty: 1 });
});
```
render 内で合計と点数を state から再計算する。cart が空なら空状態を描画する。

## モーダル（3経路で閉じる）
```js
function openModal(el){ el.hidden = false; el.querySelector('[autofocus],button')?.focus(); }
function closeModal(el){ el.hidden = true; }
modal.addEventListener('click', e => { if (e.target === modal) closeModal(modal); });
addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(modal); });
```
閉じるボタン・背景クリック・Escape の3経路を必ず用意する。

## フォーム検証
```js
form.addEventListener('submit', e => {
  e.preventDefault();
  const bad = [...form.elements].filter(el => el.required && !el.value.trim());
  bad.forEach(el => el.setAttribute('aria-invalid','true'));
  if (bad.length) { bad[0].focus(); return; }
  mutate(s => s.items.push(read(form)));
  showToast('保存しました');
  location.hash = '#/list';
});
```

## 絞り込み・検索・並べ替え
state のみを変えて render() を呼ぶ。0件時は必ず空状態を描画する。
