/**
 * How wide the project-name field has to be to show the name in it.
 *
 * The field was 180px fixed, from a time when every project was called
 * 「Untitled」 and the only names were ones a person had typed. The product now
 * writes them itself, up to 32 characters, and 「さくら歯科クリニック予約システム」
 * is sixteen full-width ones — 208px at 13px, cut by nearly a third.
 *
 * An `<input>` does not size to its content and `field-sizing: content` is too
 * new to rely on, so the width is computed here and applied as an inline style.
 * The floor and the ceiling stay in the stylesheet: those are layout facts about
 * the header, not facts about the string.
 */

/**
 * Counted by width, not by `length`.
 *
 * 「さくら歯科クリニック予約システム」 and "Inventory Manager" are both sixteen
 * characters and need very different room. A CJK character occupies about one em
 * at this weight and a Latin one about half, so the two are counted apart —
 * `length` alone makes the Latin name twice as wide as it needs to be and, worse,
 * the Japanese one right only by accident.
 *
 * The ranges are the ones that actually appear in these names: kana, CJK
 * ideographs, full-width forms and the punctuation that comes with them. Anything
 * else is treated as narrow, which is the safe direction — the ceiling in the
 * stylesheet catches an underestimate, while an overestimate pushes the header
 * actions for a name that did not need the room.
 */
const WIDE = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-｠￠-￦]/;

/** Half an em for a Latin character, which is about what 13px sans gives. */
const NARROW_EM = 0.55;

/** Room for the caret and the padding, so the last character is not against the edge. */
const PADDING_EM = 1.5;

export function titleWidthEm(title: string): number {
  let em = 0;
  for (const ch of title) em += WIDE.test(ch) ? 1 : NARROW_EM;
  return Math.round((em + PADDING_EM) * 10) / 10;
}
