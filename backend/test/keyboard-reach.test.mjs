// A card the mouse opens and the keyboard cannot.
//
// Reported 2026-09-20 on a generated storefront: 「依頼された要件が反映されていません:
// 商品カードはTabキーで辿れる」. The requirement was real, and so was the miss — the
// cards were `<div className="card product-card" onClick={…}>`, which Tab skips
// and Enter never reaches. What was wrong was the ADVICE: the check looked for
// the string 'Tab' in an onKeyDown and the instruction told the build to write
// one, which is how you take the browser's focus order away from the user.
//
// Measured over the 34 stored project documents: 20 such elements in 14 of them
// (41%), after excluding the two shapes that are correctly unreachable — a modal
// backdrop (Escape is its keyboard equivalent) and a panel whose only handler
// stops the backdrop's. The fixup closed all 20 and all 34 still compile.
//
//   node test/keyboard-reach.test.mjs      (from backend/)
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist/kr.test.mjs');
await esbuild.build({
  entryPoints: [path.join(root, 'src/tools/fixups/keyboard-reach.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile: out,
  external: ['@aws-sdk/*', '@smithy/*'], logLevel: 'error',
});
const { unreachableControls, reachByKeyboard } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};
const tags = (src, kind = 'react') => unreachableControls(src, kind).map((c) => c.tag);
const roles = (src, kind = 'react') => unreachableControls(src, kind).map((c) => `${c.tag}:${c.role}`);

// --- the reported case -----------------------------------------------------
const CARD = `
      {products.map((product) => (
        <div
          className="card product-card"
          key={product.id}
          onClick={() => navigate({ screen: 'product', params: { id: product.id } })}
        >
          <h3>{product.name}</h3>
        </div>
      ))}`;
check('a product card with a click handler is unreachable', tags(CARD), ['div']);
const fixedCard = reachByKeyboard(CARD, 'react');
check('and gets a tab stop', /tabIndex=\{0\}/.test(fixedCard.source), true);
check('and a key handler', /onKeyDown=/.test(fixedCard.source), true);
check('and the button role, having nothing interactive inside', /role="button"/.test(fixedCard.source), true);
check('the click expression is untouched', fixedCard.source.includes("params: { id: product.id }"), true);
check('rewriting it twice changes nothing the second time',
  reachByKeyboard(fixedCard.source, 'react').count, 0);

// --- what must never be given a tab stop -----------------------------------
// A backdrop is dismissed by clicking beside the dialog. Escape is its keyboard
// equivalent; a focus ring on a sheet of glass in front of the dialog is not.
check('a modal backdrop is left alone',
  tags(`<div className="modal-overlay" onClick={onClose}><p>x</p></div>`), []);
check('however it is spelt',
  tags(`<div className="dialog-backdrop" onClick={close} />`), []);
// And the panel inside it, whose only job is to keep the backdrop from firing.
check('a panel that only stops propagation is not a control',
  tags(`<div className="modal" onClick={(e) => e.stopPropagation()}><h2>t</h2></div>`), []);
check('written without a block, the same',
  tags(`<div className="panel" onClick={e => { e.stopPropagation(); }}>x</div>`), []);
// But a panel that stops propagation AND does something is one.
check('a control that stops propagation and also acts is still a control',
  tags(`<div className="row" onClick={(e) => { e.stopPropagation(); open(row.id); }}>x</div>`), ['div']);

check('an element that is already focusable is left alone',
  tags(`<div className="c" tabIndex={0} onClick={go}>x</div>`), []);
check('so is one that already says what it is',
  tags(`<div className="c" role="button" onClick={go}>x</div>`), []);
check('a real button needs nothing', tags(`<button onClick={go}>行く</button>`), []);
check('nor does an anchor', tags(`<a href="#/x" onClick={go}>行く</a>`), []);
check('an element with no click handler is not a control',
  tags(`<div className="card"><h3>t</h3></div>`), []);
// A component decides its own markup; attributes added here would be props it
// may not accept, and `tabIndex` on a component that spreads nothing is dropped.
check('a component is left to itself', tags(`<Card onClick={go}>x</Card>`), []);

// --- where the role would replace meaning rather than add it ---------------
// A `tr` belongs to its table and an `li` to its list.
check('a clickable row gets the tab stop without the role',
  roles(`<tr key={p.id} onClick={() => open(p.id)}><td>{p.name}</td></tr>`), ['tr:false']);
check('and a list item likewise',
  roles(`<li onClick={() => pick(x)}><span>{x}</span></li>`), ['li:false']);
// A div holding a real button would nest a button inside a button.
check('a card containing a button gets no role',
  roles(`<div className="card" onClick={open}><p>t</p><button onClick={add}>追加</button></div>`),
  ['div:false']);
check('a card containing only text gets one',
  roles(`<div className="card" onClick={open}><p>t</p><span>{n}</span></div>`), ['div:true']);

// --- Vue -------------------------------------------------------------------
const VUE = `<div class="product-card" @click="go(product.id)"><h3>{{ product.name }}</h3></div>`;
check('the same shape in Vue', tags(VUE, 'vue'), ['div']);
const fixedVue = reachByKeyboard(VUE, 'vue').source;
check('Vue gets a lower-case tabindex', /tabindex="0"/.test(fixedVue), true);
check('and keydown modifiers rather than an arrow function',
  /@keydown\.enter\.prevent="\$event\.currentTarget\.click\(\)"/.test(fixedVue), true);
check('v-on:click counts too', tags(`<tr v-on:click="open(r)"><td>x</td></tr>`, 'vue'), ['tr']);
check('a Vue backdrop is left alone',
  tags(`<div class="modal-overlay" @click="close" />`, 'vue'), []);

// --- the scan must survive real source -------------------------------------
// The `>` inside an arrow function is not the end of the tag, and neither is
// the `}` inside a nested object.
check('an arrow function in an attribute does not end the tag',
  tags(`<div className="a" onClick={() => setOpen({ id: 1 })}><span>x</span></div>`), ['div']);
check('a template literal class name is read',
  tags('<div className={`row ${active ? "on" : ""}`} onClick={go}>x</div>'), ['div']);
// Self-closing, with no subtree to look into.
check('a self-closing element is handled', roles(`<div className="hit" onClick={go} />`), ['div:true']);

// Several in one file are all rewritten, and the later ones do not shift.
const TWO = `<div className="a" onClick={x}>1</div>\n<div className="b" onClick={y}>2</div>`;
const both = reachByKeyboard(TWO, 'react');
check('every control in a file is rewritten', both.count, 2);
check('and the second one is still intact', /className="b"/.test(both.source), true);
check('nothing is reported on a file with no markup', reachByKeyboard('const a = 1 < 2;', 'react').count, 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
