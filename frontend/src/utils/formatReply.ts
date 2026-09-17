/**
 * The model's reply, arranged so it can be read.
 *
 * What arrives is one paragraph. Measured on stored threads: five or six
 * sentences of Japanese in a single run, no line breaks, set at 13px in a 420px
 * column — 「…構築します。グラフはすべてインラインSVGで描画し、外部ライブラリは
 * 一切使いません。設計の軸は…」. Every sentence is worth reading and none of
 * them is findable, because there is nothing for the eye to return to.
 *
 * So the unit is the sentence. Japanese ends one with 。 and the break is
 * unambiguous, which is what makes this safe to do without a parser. Very short
 * sentences join the one after them rather than standing alone, because a line
 * holding 「はい。」 reads as a heading for what follows it.
 *
 * Structure is kept when the model does send some — it occasionally writes a
 * bulleted list, and an edit reply is one 「編集 <path> — <理由>」 line per file.
 * Those are already readable and are left as lines rather than being flowed
 * into sentences.
 */

export type ReplyBlock =
  | { kind: 'para'; lines: string[] }
  | { kind: 'list'; items: string[] }
  /**
   * What the run could not fix, held apart so it can be folded away.
   *
   * After a first generation this was a paragraph of bullets under the model's
   * description — on the verification run, eight of them — and the thing a
   * person had just asked for sat above a wall of review notes. They are worth
   * having and not worth reading first, so they render collapsed with the count
   * showing, and open to every one of them.
   *
   * Recognised from the text rather than sent as structure, because the text is
   * what the thread persists: the backend puts them in the reply precisely so a
   * reload keeps them (see `replyWithOutcome`). `test/format-reply.test.mjs`
   * reads the backend's heading so the two cannot drift.
   */
  | { kind: 'findings'; count: number; items: string[] };

/**
 * The line that opens the findings, as `describeOutcome` writes it.
 *
 * `(?:主なもの:)?` because stored threads from before every finding was listed
 * end the heading that way and carry 「・ほか N件」 as their last item — those
 * still fold, and still show what they have.
 */
const FINDINGS_HEADING = /^未解決の指摘が(\d+)件あります。(?:主なもの:)?$/;

/**
 * Below this a sentence is a fragment, and joins the next one.
 *
 * Eight, measured against the real replies rather than picked: at fourteen
 * 「ダッシュボードです。」 (ten characters, a whole sentence) was absorbed into
 * the one after it, and the split stopped doing its job on exactly the kind of
 * opening line these replies begin with. What has to join is 「はい。」 and
 * 「了解。」 — an acknowledgement alone on a line reads as a heading for what
 * follows it.
 */
const SHORT_SENTENCE = 8;

/** A line that is already an item: a bullet, a number, or an edit record. */
function isItemLine(line: string): boolean {
  return /^\s*(?:[-*・>]|\d+[.)]|編集\s)/.test(line);
}

/** The marker at the front of an item, so the renderer can show it as a list. */
function stripMarker(line: string): string {
  return line.replace(/^\s*(?:[-*・>]|\d+[.)])\s*/, '').trim();
}

/**
 * One paragraph of prose, split into sentences.
 *
 * `。` closes a sentence and is kept on the line it ends — dropping it would
 * change the text, and this only rearranges it. A trailing fragment with no
 * 。 (a heading, an unfinished stream) is a line of its own.
 */
export function splitSentences(text: string): string[] {
  const parts = text.split(/(?<=。)/).map((t) => t.trim()).filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    const last = out[out.length - 1];
    // A fragment joins what came before it rather than starting a line, and a
    // short opener waits for the next sentence to join it.
    if (last !== undefined && last.length < SHORT_SENTENCE) out[out.length - 1] = `${last}${part}`;
    else out.push(part);
  }
  // If everything was short the loop leaves one joined line, which is correct.
  return out;
}

/** The reply as blocks a component can render. */
export function formatReply(content: string): ReplyBlock[] {
  const blocks: ReplyBlock[] = [];
  for (const chunk of content.split(/\n\s*\n/)) {
    const lines = chunk.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
    if (lines.length === 0) continue;
    /*
     * The findings sit at the end of the outcome block, after the reach and file
     * lines in the same chunk. Split there: what comes before stays prose, the
     * heading and its bullets become one foldable block, and anything after —
     * there is nothing today — would go back to prose.
     */
    const at = lines.findIndex((l) => FINDINGS_HEADING.test(l.trim()));
    if (at >= 0) {
      const before = lines.slice(0, at);
      let end = at + 1;
      while (end < lines.length && isItemLine(lines[end])) end += 1;
      if (before.length > 0) blocks.push({ kind: 'para', lines: before });
      blocks.push({
        kind: 'findings',
        count: Number(FINDINGS_HEADING.exec(lines[at].trim())?.[1] ?? 0),
        items: lines.slice(at + 1, end).map(stripMarker),
      });
      const after = lines.slice(end);
      if (after.length > 0) blocks.push({ kind: 'para', lines: after });
      continue;
    }
    if (lines.every(isItemLine)) {
      blocks.push({ kind: 'list', items: lines.map(stripMarker) });
      continue;
    }
    // Several plain lines in one chunk were already broken by the model; only a
    // single run of prose is re-broken.
    if (lines.length > 1) {
      blocks.push({ kind: 'para', lines });
      continue;
    }
    blocks.push({ kind: 'para', lines: splitSentences(lines[0]) });
  }
  return blocks;
}

/**
 * A run of text in one line, and what emphasis it carries.
 *
 * The replies arrive with markdown in them and it was being shown as
 * punctuation. Measured on the newest stored reply (2026-09-04, 637 characters):
 * eighteen `**` and ten backticks, all of them literal asterisks and backticks
 * on screen — 「**Domain**: カフェの店内モバイルオーダー」 and 「`#8B6F47`」.
 *
 * Deliberately narrower than markdown.ts, which renders a whole
 * SPECIFICATION.md to HTML for the editor's preview. Two differences decide it:
 * that one produces an HTML string for `innerHTML` and this produces values a
 * React tree renders as text nodes, and a chat reply is not a document — no
 * headings, no tables, no images, and no links, which are the constructs that
 * make markdown worth a parser. Bold and code are what actually arrive.
 */
export type Span =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'code'; text: string };

/**
 * One line, split into spans.
 *
 * Code first, then bold, for markdown.ts's reason: `**` inside a code span is
 * part of what was quoted, and a span that renders it as bold has stopped
 * saying what it was quoted to say.
 *
 * Unmatched markers stay as text. A reply that writes 「**」 and never closes it
 * is prose with asterisks in it, and swallowing them would delete something the
 * model wrote.
 */
export function inlineSpans(line: string): Span[] {
  const out: Span[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let at = 0;
  for (const m of line.matchAll(pattern)) {
    const start = m.index ?? 0;
    if (start > at) out.push({ kind: 'text', text: line.slice(at, start) });
    out.push(m[1] !== undefined ? { kind: 'code', text: m[1] } : { kind: 'bold', text: m[2] });
    at = start + m[0].length;
  }
  if (at < line.length) out.push({ kind: 'text', text: line.slice(at) });
  return out.length > 0 ? out : [{ kind: 'text', text: line }];
}
