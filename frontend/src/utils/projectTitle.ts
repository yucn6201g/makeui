/**
 * A name for a project that never got one.
 *
 * A project is created as 「Untitled」 because at that moment nobody knows what
 * it is — not the user, who has not written the brief yet, and not us. After a
 * generation both facts are available, and leaving the tab called Untitled makes
 * the user say what they built a second time. One account had thirteen projects
 * and the names were mostly Untitled, which is the report this exists to answer:
 * the list became unreadable not because naming is hard but because it happened
 * at the only moment there was nothing to say.
 *
 * ## Read, never invented
 *
 * The title is taken from the document the model just wrote — the heading of
 * its SPECIFICATION.md, then its `<title>` — and only then from the request the
 * user typed. No
 * model call: naming a project is not worth a round trip, and a generated name
 * that disagrees with the generated page would be worse than Untitled.
 *
 * Returns null rather than a guess. A document with a placeholder title and no
 * heading, from a request of two words, has not told us anything, and 「新しい
 * プロジェクト」 is Untitled with more syllables.
 */

/**
 * The product name, as the project's own specification states it.
 *
 * `SPECIFICATION.md` is required at the project root by the build contract and
 * opens with an H1 naming the product. It is the most reliable name in the
 * document and the only one that is about the product rather than a screen.
 */
const SPEC_HEADING = /@@@makeui:file SPECIFICATION\.md\s*\n#\s*(.+)/;

/** As long as a tab can show. Longer is a sentence, and the list shows names. */
const MAX_TITLE = 32;

/**
 * Names that mean "this was not named".
 *
 * The scaffolds emit some of these themselves — `<title>Document</title>` is
 * what an empty HTML file gets from every editor — so accepting them would
 * rename Untitled to Document, which is a worse name for being less honest
 * about being one. Matched case-insensitively after trimming.
 */
const PLACEHOLDER = new Set([
  'document', 'untitled', 'untitled document', 'app', 'my app', 'react app',
  'vite app', 'vite + react', 'vite + react + ts', 'vue app', 'svelte app',
  'makeui app', 'makeui', 'index', 'home', 'page', 'title',
  'ホーム', 'トップ', 'トップページ', 'ページ', 'アプリ', 'タイトル', '無題',
  /*
   * Found by running this over the 148 documents in S3 rather than guessed.
   * 'StoreName' is the model's own filler left in the specification heading;
   * 'Dashboard' and 'ダッシュボード' name a category rather than a product, which
   * is the same failure as 'App' in a longer word.
   */
  'storename', 'store name', 'dashboard', 'ダッシュボード',
]);

/** Entities the models actually emit. A full decoder would be a dependency. */
const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ',
};

function clean(raw: string): string {
  return raw
    .replace(/&[a-z]+;|&#\d+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Everything after a separator is the site, not the page.
 *
 * `商品一覧 | ハコブネ` is one page of a product; the product is the project.
 * Titles are written the other way round about as often, so the longer half
 * wins rather than a fixed side — with a tie going to the first, which is where
 * a page title puts its subject.
 */
function mainPart(title: string): string {
  const parts = title.split(/\s+[|｜–—－]\s+|\s+-\s+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return title;
  return parts.reduce((best, p) => (p.length > best.length ? p : best), parts[0]);
}

function usable(candidate: string): string | null {
  const text = mainPart(clean(candidate));
  if (!text) return null;
  if (PLACEHOLDER.has(text.toLowerCase())) return null;
  // A heading that is a whole sentence is a headline, not a name.
  if (text.length > 60) return null;
  return text.slice(0, MAX_TITLE);
}

/** Whether this project is still carrying the name it was created with. */
export function isUnnamed(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n === '' || n === 'untitled' || n === '無題';
}

/**
 * A title for the project, read from what was generated.
 *
 * @param document the generated output, whatever shape it arrived in — the
 *   `<title>` is in it either way, and searching the whole string avoids
 *   depending on how the transport happens to be split this month
 * @param request what the user asked for, used only when the document says
 *   nothing about itself
 */
export function titleFromResult(document: string, request?: string): string | null {
  /*
   * SPECIFICATION.md's heading, first, because it is the only place in a MakeUI
   * project that names the PRODUCT.
   *
   * Measured against the 148 documents in S3: a `<title>` is present in 46% of
   * them and this heading in 61%, and between them they cover 97%. The first
   * `<h1>` is present in 95% and is nearly always a SCREEN heading — the sample
   * holds 「予約日時を選択してください」, 「新作アイテム」 and 「シーズンセール開催中」,
   * an instruction and two banners. Naming a dental clinic's booking system
   * 「予約日時を選択してください」 is worse than leaving it Untitled, so the h1 is
   * not a source at all and the request is the fallback instead.
   *
   * Not passed through `mainPart`: that splits a page title from its site, and
   * this heading is already the whole name. 「LOOM — レディースアパレルストア」 is
   * the product, and keeping the longer half would throw the brand away.
   */
  const spec = SPEC_HEADING.exec(document)?.[1];
  if (spec) {
    const heading = clean(spec);
    if (heading && !PLACEHOLDER.has(heading.toLowerCase()) && heading.length <= 60) {
      return heading.slice(0, MAX_TITLE);
    }
  }

  const titleTag = /<title[^>]*>([^<]*)<\/title>/i.exec(document)?.[1];
  if (titleTag) {
    const t = usable(titleTag);
    if (t) return t;
  }

  /*
   * And failing that, what was asked for.
   *
   * The first line, because a brief's first line is its subject — every one of
   * the templates opens with 「レディースアパレルのオンラインストア。」 and nothing
   * else in the brief says it as briefly. The trailing 「。」 goes: a name is not
   * a sentence.
   */
  const first = (request ?? '').split('\n').map((l) => l.trim()).find(Boolean);
  if (first) {
    const t = usable(first.replace(/[。.､、,]+$/, ''));
    if (t) return t;
  }
  return null;
}
