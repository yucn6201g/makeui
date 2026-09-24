/**
 * Machine-checkable audit of whether a generated mock actually works.
 *
 * The prompts already demand working navigation and live controls, but a prompt
 * is a request, not a guarantee — output regularly came back as a static picture
 * with dead buttons. Scoring did not catch it either, because `scoreHtml` rewards
 * visual richness and a beautiful dead page scores just as well as a live one.
 *
 * So the requirements are re-stated here as checks. Each one maps to a rule the
 * prompt already gives, is cheap to evaluate, and is written to avoid false
 * positives: the repair pass costs a full model call, so a wrong finding is
 * expensive. Anything ambiguous is deliberately left unchecked.
 */

import { readProjectFiles } from '../tools/project-transport.js';
import { detectKind } from '../tools/framework-compile.js';
import { FRAMEWORKS, type OutputKind } from '../config/frameworks.js';
import { formControlRules, smallControlFonts, textEntryControlTags } from '../tools/form-controls.js';
import { renderedFrom } from '../tools/artwork.js';
import { unguardedCheckouts } from '../tools/shell-fixes.js';
import { unhandledDispatches } from '../tools/source-consistency.js';

export interface InteractionDefect {
  /** Stable id, so logs can be grouped. */
  id: string;
  /** Sentence handed to the repair pass, phrased as the fix to make. */
  instruction: string;
  /**
   * The same finding, for the person who asked for the screen.
   *
   * `instruction` is addressed to the model that has to act on it: it names
   * directories, component files and the edit to make. The chat reply used to
   * show its first sentence clipped to 90 characters, which for this one read
   *
   *   src/components/icons/ に 5 個のアイコンがありますが、どの画面からも
   *   描画されていません（ChevronIcon.tsx、SearchIcon.tsx、Cl…
   *
   * — an internal path, a file list, and a cut in the middle of a filename.
   *
   * Most instructions do not need this. 「実際にクリックしても何も起きません」 and
   * 「コントラスト比が WCAG AA を下回るテキストがあります」 are already about the
   * product. It is the ones phrased in file paths that need a second wording,
   * and only those carry one — `shortNote` still handles the rest.
   */
  note?: string;
  /**
   * The files whose CONTENT triggered this, when that is knowable by looking.
   *
   * The repair planner is a model call that sees the project's file paths and
   * the defect sentences, and nothing else — not one byte of any file. So for a
   * defect like 「#6366f1 が使われています」 it is being asked which file contains a
   * hex colour, from the filenames. It cannot know, so it guesses, and the guess
   * is the stylesheet.
   *
   * Measured over 14 days: 53 repair passes were handed `default-palette` and it
   * was fixed 0 times. In the four stored documents that still carry the colour
   * it lives in CategoryPieChart.vue, DataGraphIllustration.vue and
   * DealScreen.svelte — never the stylesheet.
   *
   * Which file contains a string is not a judgement. Set here, the planner is
   * skipped for these and the rewrite lands on the file that actually has the
   * fault.
   */
  paths?: string[];
}

/**
 * Deliberately excludes 「準備中」: it is a normal *status* value in Japanese products
 * (an order being prepared, a document awaiting review), and flagging it sent a
 * working cafe-ordering mock into a pointless repair pass. Only unambiguous
 * placeholder wording is matched. A genuinely stubbed screen still trips the
 * screens or dead-controls checks.
 */
const PLACEHOLDER_RE = /(coming soon|近日公開|工事中|準備中です|TODO:)/i;

/** Strip <style> and comments so CSS/prose cannot satisfy a code check. */
function scriptText(html: string): string {
  const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? [];
  return scripts.join('\n');
}

/**
 * The document without its own documentation.
 *
 * SPECIFICATION.md and docs/design-guidelines.md travel inside the document,
 * and they talk about the things the tell-checks look for: the guidelines name
 * `#6366f1` as the palette to avoid, and spell out the filler words not to
 * write. Counting them means every generation is reported for the prose that
 * tells it not to do the thing.
 *
 * This stripped only `<script data-file="….md">` — the transport React projects
 * used before line fences. Everything generated since is fenced, so it stripped
 * nothing at all, and the finding it was written to prevent came back silently.
 * Measured on the v207 round: `default-palette` open on all three frameworks,
 * `filler-copy` on two, `emoji` on one, and not one of those colours or words
 * appears in any source file of any of them. The comment on
 * `auditAiTells` already records this exact failure happening once before —
 * "four of the six runs that ended with open defects were exactly this".
 *
 * Both carriers, for the same reason the transport reader accepts both: stored
 * documents predate the fence.
 */
export function withoutProse(html: string): string {
  return html
    .replace(
      /<script\b[^>]*(?:type=["'](?:text\/markdown|text\/plain)["']|data-file=["'][^"']*\.(?:md|markdown|txt)["'])[^>]*>[\s\S]*?<\/script>/gi,
      ' '
    )
    .replace(/@@@makeui:file\s+\S+\.(?:md|markdown|txt)\s*\n[\s\S]*?@@@makeui:endfile/gi, ' ');
}

function count(haystack: string, re: RegExp): number {
  return (haystack.match(re) ?? []).length;
}

/**
 * Whether the mock puts a sign-in in front of everything else.
 *
 * A password field is the reliable marker — a "ログイン" label alone also appears on
 * marketing pages that merely link to a sign-in that does not exist here.
 */
/**
 * A password field, not a rule about one.
 *
 * This tested the document for `type="password"` anywhere, and in all 75 of the
 * corpus documents that raised `demo-login` the match was a selector in the
 * stylesheet:
 *
 *     input[type="text"], input[type="email"], input[type="password"],
 *     select, textarea { font-family: inherit; … }
 *
 * Every generated project writes that rule. Not one of the 75 had a login,
 * signin or auth screen file at all — so the finding told a sales dashboard to
 * put demo credentials on a login screen that does not exist, and a repair pass
 * went after it.
 *
 * The element is what makes it a gate. A CSS rule has no `<input` in front of
 * it, which is the whole difference.
 */
export function hasLoginGate(text: string): boolean {
  return /<input\b[^>]*type=["'{][^>]*password/i.test(text);
}

/**
 * Demo credentials the reviewer can actually read off the screen.
 *
 * Requires both the constant and visible Japanese labelling: a DEMO_ACCOUNT that
 * only exists in the code satisfies the mock's own auth check while still leaving
 * the reviewer locked out, which is the failure this guards against.
 */
export function hasVisibleDemoCredentials(text: string): boolean {
  return /DEMO_ACCOUNT/.test(text) && /デモアカウント/.test(text);
}

/**
 * Distinct screen elements.
 *
 * This counted regex hits for `data-screen=` OR a `screen` class, and the generated
 * markup carries BOTH on the same <section> — so every screen counted twice. A
 * two-screen login demo measured as four and cleared the minimum of three, which is
 * the exact case the check exists to catch. Elements are counted once each, and the
 * class is matched as a whole entry in the class list so `screen-title` no longer
 * stands in for a screen.
 */
export function countScreens(html: string): number {
  let n = 0;
  for (const m of html.matchAll(/<[a-z][\w-]*\b([^>]*)>/gi)) {
    const attrs = m[1];
    if (/\bdata-screen\s*=/i.test(attrs)) {
      n++;
      continue;
    }
    const cls = /\bclass\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1];
    if (cls && cls.split(/\s+/).includes('screen')) n++;
  }
  return n;
}

/**
 * Whether navigation is actually wired — by any idiom that works.
 *
 * The check required the literal `data-goto=` attribute, so a mock navigating with
 * <a href="#/cart"> or with a click handler calling navigate() was reported broken
 * while working perfectly, and the repair pass could not win: the document was
 * already correct. It enforced one implementation rather than the requirement.
 */
function hasNavWiring(html: string, js: string): boolean {
  if (/data-goto=/.test(html)) return true;
  if (count(html, /<a\b[^>]*href=["']#[\w/-]/gi) >= 2) return true;
  return (
    /\b(?:navigate|showScreen|goTo|setScreen)\s*\(/.test(js) &&
    /addEventListener\(\s*['"]click/.test(js)
  );
}

/**
 * Whether a form is actually typeable.
 *
 * Contact and enquiry forms came back with text boxes a few pixels tall, because
 * nothing in any prompt constrained the size and the model shrank the field to fit
 * its label. The prompts now state the minimums, but this codebase has been through
 * that lesson before: what a prompt asks for, only a check enforces.
 *
 * Deliberately narrow, because a false positive costs a full model call:
 *  - only asked of documents with two or more real text-entry controls;
 *  - `var(--token)` values are resolved before comparing, so a design system that
 *    sets its sizes through tokens is not reported for using them;
 *  - anything that cannot be resolved to a literal is left alone.
 * That means it fires on the two unambiguous cases: no sizing rule at all (browser
 * defaults, which are far too small), and a font-size resolvably below 16px — the
 * threshold at which iOS zooms the page when the field takes focus.
 */
/*
 * `renderedFrom` — which components in a directory something else actually
 * renders — now lives in tools/artwork.ts, with the fixup that draws what a
 * project left undrawn. Three callers ask this question (this audit, the score
 * and that fixup) and a second copy of it would let them disagree about the
 * same file list.
 */

/*
 * The rules that style what the user types into, and which of them are too
 * small, now live in tools/form-controls.ts — unchanged, and shared with the
 * fixup that raises them. Two copies of "which rule styles an input" would let
 * the report and the repair disagree about the same stylesheet.
 */

/**
 * Two different faults share this id, so they must not share an instruction.
 *
 * They did, and the combined text listed five requirements: min-height, padding,
 * textarea height, font-size and column width. A document that satisfied four of
 * them and set `font-size: 14px` was handed all five, spent a full repair call,
 * changed nothing measurable, and was rejected as "no improvement" — every run,
 * because the next generation makes the same reasonable-looking choice. It also
 * cost the run its memory write, since that is gated on a clean audit. An
 * unrepairable finding is worse than no finding.
 *
 * Each branch now states only what it measured, and quotes the value it read, so
 * the repair has one thing to change and can be checked against the same fact.
 */
function auditFormControlSizing(doc: string): InteractionDefect | null {
  const tags = textEntryControlTags(doc);
  if (tags.length < 2) return null;
  const rules = formControlRules(doc, tags);

  const sized = rules.some((r) => /(?:^|;)\s*(?:min-height|height|padding(?:-block|-top|-bottom)?)\s*:/i.test(r.body));
  if (!sized) {
    return {
      id: 'input-sizing',
      instruction:
        'フォームの入力欄に高さの指定がありません。input / select に min-height 44px と ' +
        'padding 12px 14px、textarea に min-height 140px（rows="6" / resize: vertical）を' +
        '指定してください。幅は入力欄をフィールドの 100%、フォーム列自体を 420-560px に' +
        'してください。',
    };
  }

  const found = smallControlFonts(doc);
  const small = new Set(found.map((f) => f.value));
  const sites = [...new Set(found.map((f) => `${f.path ? `${f.path} の ` : ''}\`${f.selector.replace(/\s+/g, ' ')}\``))];
  // The token, and what it resolves to — `var(--font-size-sm)` says nothing
  // about whether it is under the threshold, and the repair has to choose
  // between changing the token and using a different one.
  const tokens = new Set(found.filter((f) => f.token).map((f) => `${f.token} = ${f.px}px`));
  if (small.size > 0) {
    return {
      id: 'input-sizing',
      instruction:
        `入力欄の font-size が ${[...small].join(' / ')} になっています。` +
        '16px 以上にしてください（16px 未満は iOS でフォーカス時にページが拡大されます）。' +
        (sites.length
          ? `\n該当する規則: ${sites.slice(0, 6).join('、')}。`
          : 'text/email/tel/number の input・textarea・select に当たる CSS 規則の font-size を' +
            'すべて 16px 以上にしてください。') +
        (tokens.size
          ? `\nこのうち ${[...tokens].join('、')} です。` +
            'トークンは他の場所でも使われているので、値を変えるのではなく、' +
            '入力欄の規則が 16px 以上のトークンを参照するようにしてください。'
          : '') +
        '\nチェックボックス・ラジオ・ボタン・ラベルはそのままで構いません。' +
        '**この1点以外は変更しないでください。**',
    };
  }
  return null;
}

/**
 * A photo slot that was left as a hole rather than given a placeholder.
 *
 * This rule used to flag placeholders themselves — any element classed
 * `image-placeholder`, or the words 「画像なし」/"No Image" — on the principle that a
 * grey box is an unfinished screen. That principle has been narrowed: a *photograph*
 * has no honest substitute, so a designed placeholder is now the required treatment
 * for product shots, avatars and covers, and flagging it would fight the prompt.
 *
 * What remains a defect is a placeholder that does not do its job: one with no size,
 * which collapses and breaks the layout it was supposed to hold open. That is checked
 * below rather than by matching class names.
 */
const IMAGE_HOLE_RE = /(画像なし|No Image available|画像を読み込めません)/i;

/** Class names the prompts ask for on a photo placeholder. */
const PHOTO_SLOT_RE =
  /class(?:Name)?=["'][^"']*\b(?:image-placeholder|img-placeholder|photo-placeholder|image-slot|photo-frame|product-image|thumb(?:nail)?)\b/i;

/**
 * Whether photo slots are given a size.
 *
 * The whole point of the placeholder is to hold the layout open at the right shape,
 * so the one thing worth measuring is whether it has one. An `aspect-ratio`,
 * `min-height` or explicit `height` on the slot's rule counts; nothing at all means
 * a zero-height box and a collapsed grid.
 */
function photoSlotsAreSized(doc: string): boolean {
  const classes = new Set<string>();
  for (const m of doc.matchAll(/class(?:Name)?=["']([^"']*)["']/gi)) {
    for (const c of m[1].split(/\s+/)) {
      if (/\b(?:image|img|photo|thumb|cover|avatar)/i.test(c)) classes.add(c);
    }
  }
  if (classes.size === 0) return true;
  for (const m of doc.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1];
    if (![...classes].some((c) => new RegExp(`\\.${c}(?![\\w-])`).test(sel))) continue;
    if (/(?:^|;)\s*(?:aspect-ratio|min-height|height|padding-top|padding-bottom)\s*:/i.test(m[2])) return true;
  }
  return false;
}

/**
 * Buttons that nothing can act on.
 *
 * The rule this replaces compared two totals: it fired only when a document had
 * at least 8 buttons *and* fewer than half as many "handlers", where one
 * `addEventListener` counted as three. A page with seven dead buttons passed. So
 * did a page with twelve dead buttons and four listeners bound to something else
 * entirely, because the counts never had to line up with each other. Totals
 * cannot answer a per-element question.
 *
 * Each button is now checked for a route by which a click could reach code:
 *
 *   - an inline `onclick`
 *   - a `data-*` attribute the document's script reads
 *   - an `id` or class named in the script
 *   - `type="submit"`, when the document handles submit
 *   - a `<form>` ancestor, for the same reason
 *
 * A button matching none of them cannot do anything, whatever the totals say. The
 * check is deliberately generous about *how* the wiring is done — this codebase
 * has already reported working navigation as broken once by demanding one
 * specific implementation (`data-goto`), and a rule that dictates technique
 * rather than outcome is a rule that fights correct work.
 */
function unreachableButtons(html: string, js: string): string[] {
  /**
   * A document-level click listener can reach anything, by any selector, and
   * static analysis cannot tell which. The first version of this check tried
   * anyway and reported `<button class="btn btn-primary">詳細を見る</button>` as
   * dead — it is wired through `querySelectorAll('.product-card .btn')`, which
   * no attribute on the button reveals. Clicking it navigates.
   *
   * So delegation ends the check. What remains catchable is the document that
   * wired nothing at all, which is the failure actually worth a repair call.
   */
  if (/(?:document|window|document\.body)\s*\.addEventListener\(\s*['"]click/.test(js)) return [];

  const handlesSubmit = /addEventListener\(\s*['"]submit|onsubmit=/i.test(html + js);

  // Anything the script names, however it names it. Substring matching on the
  // raw script rather than on extracted string literals, because a selector may
  // be built as '.card .btn', `#${id}`, or a class list joined at runtime, and
  // every one of those is a real wiring the audit must not call broken.
  const mentions = (needle: string): boolean => needle.length >= 2 && js.includes(needle);

  const dead: string[] = [];
  for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
    const attrs = m[1];
    const label = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

    if (/\bonclick\s*=/i.test(attrs)) continue;
    if (/\btype\s*=\s*["']submit["']/i.test(attrs) && handlesSubmit) continue;

    const id = /\bid\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (id && mentions(id)) continue;

    const dataNames = [...attrs.matchAll(/\bdata-([\w-]+)\s*=/gi)].map((d) => d[1]);
    if (dataNames.some((n) => mentions(n) || mentions(camel(n)))) continue;

    const dataValues = [...attrs.matchAll(/\bdata-[\w-]+\s*=\s*["']([^"']+)["']/gi)].map((d) => d[1]);
    if (dataValues.some(mentions)) continue;

    const classes = (/\bclass\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? '').split(/\s+/).filter(Boolean);
    if (classes.some(mentions)) continue;

    if (label && mentions(label)) continue;

    dead.push(label || '(ラベルなし)');
  }
  return dead;
}

/** data-go-to ⇒ goTo, matching how the DOM exposes it on `dataset`. */
function camel(attr: string): string {
  return attr.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Audits a single-document HTML mock.
 */
function auditHtml(html: string): InteractionDefect[] {
  const defects: InteractionDefect[] = [];
  const js = scriptText(html);

  const screens = countScreens(html);
  if (screens < 3) {
    defects.push({
      id: 'screens',
      instruction:
        `画面が ${screens} つしかありません。<section class="screen" data-screen="..."> を3つ以上作り、` +
        'ナビゲーションから相互に遷移できるようにしてください。',
    });
  }

  if (!/hashchange/.test(js)) {
    defects.push({
      id: 'router',
      instruction:
        "ルーターがありません。location.hash を読み、'hashchange' を購読して画面を切り替える " +
        'showScreen() を実装し、ブラウザの戻る/進むが機能するようにしてください。',
    });
  }

  // The router must survive an empty hash — the preview always loads without one.
  if (/hashchange/.test(js) && !/(\|\|\s*['"][^'"]*['"]|hash\s*\?|!hash|hash\s*===\s*['"]['"])/.test(js)) {
    defects.push({
      id: 'route-default',
      instruction:
        'hash が空、または未知の値のときに最初の画面へフォールバックする分岐を追加してください。' +
        'プレビューは hash なしで読み込まれるため、これが無いと初期表示が空になります。',
    });
  }

  // Only asked of a document that has screens to move between: an app below the
  // minimum needs the screens built first, and reporting both says the same thing twice.
  if (screens >= 3 && !hasNavWiring(html, js)) {
    defects.push({
      id: 'nav-wiring',
      instruction:
        'ナビゲーション項目に data-goto="<screen>" を付け、クリックで該当画面へ遷移するように' +
        '配線してください。',
    });
  }

  const dead = unreachableButtons(html, js);
  if (dead.length > 0) {
    const shown = dead.slice(0, 6).map((label) => `「${label}」`).join('、');
    defects.push({
      id: 'dead-controls',
      instruction:
        `次のボタンはクリックしても何も起きません: ${shown}` +
        (dead.length > 6 ? ` ほか ${dead.length - 6} 個` : '') +
        '。それぞれに実際の動作（状態変更・画面遷移・モーダル開閉）を配線してください。' +
        '配線の方法はどれでも構いません — onclick 属性、data-goto / data-action 属性と' +
        '委譲リスナー、id を getElementById で取得してのハンドラ登録、フォーム内の submit。' +
        '動作を与えられない要素は削除してください。画面に出ている以上、押せば何かが起きる' +
        'ことが期待されます。',
    });
  }

  const sizing = auditFormControlSizing(html);
  if (sizing) defects.push(sizing);

  if (count(html, /<form\b/gi) > 0 && !/preventDefault/.test(js)) {
    defects.push({
      id: 'form-inert',
      instruction:
        'フォームが送信を処理していません。submit で preventDefault() し、必須項目を検証して' +
        'インラインのエラー表示と成功表示を出し、状態を更新してください。',
    });
  }

  if (/\balert\s*\(|\bconfirm\s*\(/.test(js)) {
    defects.push({
      id: 'native-dialog',
      instruction:
        'alert() / confirm() を UI の代わりに使わないでください。モーダルやトーストとして' +
        '画面内に実装してください。',
    });
  }

  if (PLACEHOLDER_RE.test(html)) {
    defects.push({
      id: 'placeholder',
      instruction:
        '「Coming Soon」「近日公開」などのプレースホルダを実際のコンテンツと動作に置き換えてください。',
    });
  }

  // A login the reviewer cannot get past hides every other screen behind it, so
  // this is checked even though it only applies to some products.
  const shipped = withoutProse(html);
  if (hasLoginGate(shipped) && !hasVisibleDemoCredentials(shipped)) {
    defects.push({
      id: 'demo-login',
      instruction:
        'ログイン画面にデモ用の認証情報がありません。DEMO_ACCOUNT を state に定義し、' +
        'ログイン画面に「デモアカウント」と見出しを付けた枠でメールとパスワードを両方表示し、' +
        '「デモアカウントを入力」ボタンで両フィールドを埋め、その認証情報でログインが通るように' +
        'してください。レビュアーはアカウントを持っていないため、これが無いと先へ進めません。',
    });
  }

  // Drawn artwork, not grey boxes. Only flagged when a hole is explicit or the
  // page has real visual surface (a grid of cards) and no illustration at all.
  const svgs = count(html, /<svg\b/gi);
  if (IMAGE_HOLE_RE.test(html)) {
    defects.push({
      id: 'image-hole',
      instruction:
        '「画像なし」のようなエラー文言が残っています。写真が入る枠は、アスペクト比を持つ' +
        'プレースホルダ（中立色の面 + 小さな写真アイコン + 必要なら名称）として描いてください。',
    });
  } else if (PHOTO_SLOT_RE.test(html) && !photoSlotsAreSized(html)) {
    defects.push({
      id: 'photo-slot-unsized',
      instruction:
        '写真のプレースホルダに寸法がありません。aspect-ratio（一覧タイルは 1:1、カバーやヒーローは ' +
        '4:3 か 16:9）と背景色を指定し、中央に小さな写真アイコンを置いてください。寸法が無いと' +
        '高さ 0 に潰れ、レイアウトが崩れます。',
    });
    /**
     * The threshold used to be `svgs > 0 && svgs < 4`, which made a document with
     * NO artwork invisible while one with three pieces was defective.
     *
     * That inversion put this rule into an unwinnable fight with the emoji rule.
     * Measured on a real run: the document used emoji as its icons and had zero
     * SVGs, so only `emoji` fired. The repair did exactly as asked — removed the
     * emoji, drew three SVGs — and thereby *activated* `imagery-thin`. One defect
     * before, one after, so the repair was rejected for "no improvement" and the
     * emoji shipped. The repair was penalised for doing the right thing.
     *
     * Zero is now counted as thinner than three, which is the only ordering that
     * makes sense, and the guard against flagging a page that genuinely needs no
     * artwork is `countScreens` instead: a multi-screen mock has empty states and
     * content frames to draw, a single sign-in page does not.
     */
  } else if (svgs < 4 && countScreens(html) >= 3) {
    defects.push({
      id: 'imagery-thin',
      note: '図やイラストが少なく、画面が文字と枠だけになっています。',
      instruction:
        `インライン SVG が ${svgs} 個しかありません。アイコンに加えて、空状態の線画、` +
        'コンテンツ枠の図版、データのグラフ、プロダクトのワードマークを SVG で描き足してください。' +
        '絵文字をアイコン代わりに使うのは不可です — 置き換えるなら SVG で描いてください。',
    });
  }

  return defects;
}

/**
 * The ScreenId union, resolved through the constants it is usually built from.
 *
 * Generated projects write the union two ways, and the second is common:
 *
 *   type ScreenId = 'login' | 'feed';                       // literals
 *   export const FEED_SCREEN = 'feed';
 *   type ScreenId = typeof LOGIN_SCREEN | typeof FEED_SCREEN;   // constants
 *
 * A literals-only reader returns nothing for the second form — and a check that
 * finds no screens reports no defects, so it silently stops testing anything.
 * Both forms are read here, and the constant name is kept alongside each id
 * because App.tsx will be branching on the constant, not on the string.
 */
function screenIds(routes: string): { ids: string[]; constOf: Map<string, string> } {
  const constOf = new Map<string, string>();
  const valueOf = new Map<string, string>();
  for (const m of routes.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*['"]([\w-]+)['"]/g)) {
    valueOf.set(m[1], m[2]);
    if (!constOf.has(m[2])) constOf.set(m[2], m[1]);
  }
  /*
   * The union itself, not everything up to the next semicolon.
   *
   * This read `=([\s\S]*?);` and so required a terminating semicolon. Vue
   * projects are written without them, and when the file has no semicolon
   * anywhere the match fails outright and the project reports zero declared
   * screens. Measured across the stored corpus: 47 of the 147 documents that
   * declare a ScreenId union read as zero, and 41 of those are Vue — which is
   * very nearly every Vue project ever generated.
   *
   * Zero is not a harmless miscount. The walk is handed no route list, so its
   * fallback visit to screens nothing opened never runs and `unreachable` is
   * always empty; and `declaredScreens > 1` is false, so the whole reach term
   * is skipped — no eighteen-point award, and no deduction however little of
   * the application opens. The v194 Vue result scored 65 having reached three
   * of its eight screens, and paid nothing for the other five.
   *
   * So the members are matched instead of the terminator. A `|` is required
   * between them, which is what stops the scan at the end of the statement:
   * the `export` on the next line is a perfectly good identifier and a pattern
   * that merely collected tokens would swallow the rest of the file.
   */
  const MEMBER = String.raw`(?:'[^']*'|"[^"]*"|(?:typeof\s+)?[A-Za-z_$][\w$.]*)`;
  const union =
    new RegExp(String.raw`type\s+ScreenId\s*=\s*\|?\s*(${MEMBER}(?:\s*\|\s*${MEMBER})*)`).exec(routes)?.[1] ?? '';
  const ids: string[] = [];
  for (const m of union.matchAll(/['"]([\w-]+)['"]|(?:typeof\s+)?([A-Za-z_$][\w$]*)/g)) {
    const id = m[1] ?? valueOf.get(m[2] ?? '');
    if (id && !ids.includes(id)) ids.push(id);
  }
  return { ids, constOf };
}

/**
 * Extracts the generated project's source blocks as path -> content.
 *
 * Both transports, because both are in circulation: sixteen stored React
 * projects use `<script data-file>` and everything new uses the line fence. The
 * fence exists because a Vue or Svelte component contains its own `<script>` and
 * the old reader cut the file there — see tools/project-transport.ts.
 */
export function reactFiles(html: string): Map<string, string> {
  return readProjectFiles(html);
}

/**
 * Every screen the project says it has.
 *
 * A rendered React app carries no list of its own screens — the union lives in
 * routes.ts and nothing writes it into the DOM. Browser verification needs it to
 * answer "is there a declared screen no control can reach", which is the one
 * runtime defect that cannot be seen by looking at whatever the walk happened to
 * open. Empty for plain HTML output, which declares its screens in the markup
 * with data-screen and needs no help.
 */
/**
 * The screens' own names, from the project's NAV_ITEMS.
 *
 * For the reply. `declaredScreenIds` answers with ids — `catalog-detail`,
 * `borrow-request` — which are right for an audit and wrong for a sentence
 * shown to the person who asked for the product. NAV_ITEMS is where the project
 * writes what it calls them, in the user's language.
 *
 * Only the labelled ones come back, and that is the point rather than a
 * limitation: a screen reached from a list rather than from the nav has no
 * label, and printing its id would be reporting an internal name as a feature.
 */
/**
 * What the project's own specification calls a screen that has no menu label.
 *
 * A screen reached after an action — checkout, a completion — is not in
 * NAV_ITEMS, so `screenLabels` cannot name it, and its id (`checkout-confirm`)
 * is an internal name. SPECIFICATION.md carries a table with the id and the
 * name side by side (「| checkout-confirm | 注文確認 | …」) in nearly every
 * project; the name is the cell after the id. Null when there is no such row.
 */
export function specScreenTitle(html: string, id: string): string | null {
  const spec = [...reactFiles(html)].find(([p]) => /(?:^|\/)SPECIFICATION\.md$/i.test(p))?.[1];
  if (!spec) return null;
  const q = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const row = new RegExp(`\\|\\s*\`?${q}\`?\\s*\\|\\s*([^|\\n]+?)\\s*\\|`).exec(spec);
  const name = row?.[1].trim();
  return name && !/^[-:]+$/.test(name) && !/^[\w-]+$/.test(name) ? name : null;
}

export function screenLabels(html: string): string[] {
  const files = reactFiles(html);
  for (const [path, content] of files) {
    if (!/(?:^|\/)(routes|types-nav)\.tsx?$/.test(path)) continue;

    /*
     * Inside the NAV_ITEMS array and nowhere else.
     *
     * A first version matched every `{ … label: '…' }` object in the file and
     * came back with 「すべて・メンズ・レディース・新着順・価格：低い順」 for a
     * three-screen project — routes.ts is also where the filter and sort menus
     * are declared, and they are objects with labels too. Measured across the
     * stored corpus: 90 of the 91 documents that declare screens have NAV
     * labels, and this is what makes them the screens' labels.
     */
    const nav = /\bNAV_ITEMS\b[^=]*=\s*\[([\s\S]*?)\n?\s*\]/.exec(content);
    if (!nav) return [];

    const out: string[] = [];
    for (const m of nav[1].matchAll(/\blabel\s*:\s*['"`]([^'"`]+)['"`]/g)) {
      const label = m[1].trim();
      if (label && !out.includes(label)) out.push(label);
    }
    return out;
  }
  return [];
}

export function declaredScreenIds(html: string): string[] {
  const files = reactFiles(html);
  for (const [path, content] of files) {
    if (/(?:^|\/)(routes|types-nav)\.tsx?$/.test(path)) return screenIds(content).ids;
  }
  return [];
}

/**
 * Audits a multi-file TypeScript React project.
 */
function auditProject(html: string, outputKind: OutputKind): InteractionDefect[] {
  const fw = FRAMEWORKS[outputKind];
  const defects: InteractionDefect[] = [];
  const files = reactFiles(html);
  const get = (suffix: string): string => {
    for (const [path, content] of files) if (path.endsWith(suffix)) return content;
    return '';
  };
  const all = [...files.values()].join('\n');
  // Same reason as withoutProse(): the specification is required to state the demo
  // credentials, and must not be what satisfies the check that the screen shows them.
  const code = [...files.entries()]
    .filter(([path]) => !/\.(md|markdown|txt)$/i.test(path))
    .map(([, content]) => content)
    .join('\n');

  const screens = [...files.keys()].filter((p) => fw.screenFile.test(p));
  if (screens.length < 3) {
    defects.push({
      id: 'screens',
      instruction:
        `画面コンポーネントが足りません。src/screens/ に <名前>Screen${fw.componentExt} を3つ以上作り、` +
        `src/routes.ts の ScreenId・NAV_ITEMS と App${fw.componentExt} の分岐に接続してください。`,
    });
  }

  /*
   * Decomposition was asked for and never checked.
   *
   * SCREEN_COMPLETENESS tells both build paths that a multi-screen app has
   * 8–16 components, and the scorer awards points for reaching 6 and 12. Both
   * are one-way: the instruction can be ignored and the score simply comes out
   * lower, with nothing telling the repair pass what to do about it. Measured
   * on a real Vue run — 5 screens, a 12KB stylesheet, and `src/components/`
   * absent entirely. It rendered, so no runtime check saw anything wrong; it
   * scored 30 and no defect said why.
   *
   * Only asked once the screens exist. A project still below the screen minimum
   * needs those built first, and reporting both at once spends a repair round
   * on the smaller half of the same problem.
   */
  const components = [...files.keys()].filter(
    (p) => p.startsWith('src/components/') && p.endsWith(fw.componentExt)
  );
  if (screens.length >= 3 && components.length < 6) {
    /*
     * The repetition this document actually has, not a list of things a UI
     * usually has.
     *
     * The instruction named cards, badges, table rows, modals, empty states —
     * a good list, and the same list whatever it was sent to. A repair reading
     * it has to work out which of those this project repeats, from a document
     * it is seeing for the first time, and then find where.
     *
     * The document already says. A class written into three or more screen
     * files is markup that exists three or more times, and across the corpus
     * what comes back is exactly the list above with the guessing removed:
     * `btn-primary` in five screens, `empty-state` in four, `page-header` in
     * four. Naming them turns "extract reusable components" into a list of
     * components to extract.
     */
    const shared = new Map<string, Set<string>>();
    for (const path of screens) {
      const body = files.get(path) ?? '';
      const seen = new Set<string>();
      for (const a of body.matchAll(/class(?:Name)?=["']([^"']+)["']/g))
        for (const c of a[1].split(/\s+/)) if (/^[a-z][\w-]{2,}$/.test(c)) seen.add(c);
      for (const c of seen) {
        if (!shared.has(c)) shared.set(c, new Set());
        shared.get(c)!.add(path.split('/').pop() ?? path);
      }
    }
    const repeated = [...shared.entries()]
      .filter(([, where]) => where.size >= 3)
      .sort((a, b) => b[1].size - a[1].size);
    // `btn` and `btn-primary` in the same four screens are one component, and
    // reporting both spends a line of the instruction saying so twice.
    const distinct = repeated.filter(
      ([name, where]) =>
        !repeated.some(([other, w]) => other !== name && other.startsWith(name) && w.size === where.size)
    );
    const biggest = screens
      .map((path) => ({ path, lines: (files.get(path) ?? '').split('\n').length }))
      .sort((a, b) => b.lines - a.lines)
      .slice(0, 2)
      .filter((f) => f.lines >= 200);

    defects.push({
      id: 'decomposition',
      note: `画面が${screens.length}個ある一方で共通部品が${components.length}個しかなく、画面ごとに作り込まれています。`,
      instruction:
        `画面が ${screens.length} 個ある一方で、src/components/ の再利用可能な部品が ` +
        `${components.length} 個しかありません。カード、バッジ、テーブル行、モーダル、空状態、` +
        'フォーム項目、ツールバー、ページネーションなど、複数画面で使うもの・画面内に直接書くと' +
        `読みにくいものを src/components/ui/ に ${fw.componentExt} として切り出してください。` +
        '複数画面のアプリなら 8〜16 個が目安です。' +
        (distinct.length
          ? '\nこの中で実際に重複しているのは次のマークアップです（同じクラスが複数の画面ファイルに書かれています）: ' +
            distinct
              .slice(0, 6)
              .map(([name, where]) => `${name}（${[...where].sort().join('、')}）`)
              .join('、') +
            '。それぞれを1つのコンポーネントにして、各画面はそれを import してください。'
          : '') +
        (biggest.length
          ? '\n特に ' +
            biggest.map((f) => `${f.path}（${f.lines}行）`).join('、') +
            ' が長すぎます。まずこの画面から切り出してください。'
          : '') +
        '\nすべてを画面ファイルに書くと、画面ごとに見た目が分かれ、同じ部品が少しずつ違う形で繰り返されます。',
    });
  }

  /*
   * The router, found by what it does rather than what it is called.
   *
   * This matched the filename `nav(igation).*`, which is what the contract asks
   * for and not what generation always produces. Measured on a React run that
   * scored 79 with a working hash router in `src/router.ts`: the audit reported
   * `ルーターが見つかりません` and the repair pass was sent to build a second
   * one. Naming is the one thing a generator is entitled to vary, so it is the
   * one thing this must not depend on.
   */
  const routerFiles = [...files.entries()].filter(
    ([path, body]) =>
      !fw.screenFile.test(path) &&
      (/addEventListener\(\s*['"]hashchange/.test(body) ||
        /\bnavigate\b[^\n]*=>|function\s+navigate\b|export\s+function\s+navigate\b/.test(body))
  );
  if (routerFiles.length === 0) {
    defects.push({
      id: 'router',
      instruction:
        'ルーターが見つかりません。hash を購読して現在の画面を返すモジュールを実装してください。',
    });
  } else if (!routerFiles.some(([, body]) => /hashchange/.test(body))) {
    defects.push({
      id: 'router-hash',
      instruction:
        `${routerFiles[0][0]} が 'hashchange' を購読していません。` +
        // Said plainly since the spindle Vue run of 2026-09-15: a router that only writes the hash and
        // watches it with a framework watcher never re-renders, so this is every button, not back/forward.
        'navigate() が location.hash を書き換えるだけの作りだと、画面の状態が更新されず、どのボタンを押しても画面が変わりません。' +
        'location.hash はフレームワークのリアクティブな値ではないので、watch(() => location.hash) や computed では変化を検知できません。' +
        "window.addEventListener('hashchange', …) で現在の画面の状態を更新してください（ブラウザの戻る/進むもこれで機能します）。" +
        '画面側のボタンやリンクの書き方は変えないでください。',
    });
  }

  /*
   * The navigation contract, which the screens are reachable through.
   *
   * Measured on a React run: four screen files, a working router, and no
   * `src/routes.ts` at all — so no ScreenId union, no NAV_ITEMS, and nothing
   * for the shell to render as navigation. The browser walk reached exactly one
   * screen and reported no unreachable ones, because with no declared screen
   * list there was nothing to compare against. Three finished screens shipped
   * that a user cannot get to, and every check said the project was fine.
   */
  if (screens.length >= 3 && !files.has(fw.routesFile)) {
    defects.push({
      id: 'routes-missing',
      note: '画面はありますが、そこへ移動する手段が定義されていません。',
      instruction:
        `${fw.routesFile} がありません。ScreenId のユニオン型と NAV_ITEMS をそこに定義し、` +
        `App${fw.componentExt} のシェルがその NAV_ITEMS を描画するようにしてください。` +
        '画面ファイルが存在していても、そこへ移動する手段が画面上に無ければ到達できません。',
    });
  }

  // The frame always loads with no hash, so a parser without a fallback renders
  // nothing — this is the exact cause of the "画面が空です" error users hit.
  const nav = routerFiles.map(([, body]) => body).join('\n');
  if (nav && !/DEFAULT_ROUTE|screen:\s*['"][\w-]+['"]\s*\}?\s*;?\s*(\n\s*)?\}/.test(nav)) {
    defects.push({
      id: 'route-default',
      instruction:
        'useNavigation.ts に DEFAULT_ROUTE を定義し、hash が空または未知のときに必ずそれを返して' +
        'ください。フレームは hash なしで読み込まれるため、null を返すと画面が空になります。',
    });
  }

  const app = get(`src/App${fw.componentExt}`);
  if (app && !/default:|:\s*return\s*<|\?\?\s*</.test(app) && /switch\s*\(/.test(app)) {
    defects.push({
      id: 'app-fallback',
      note: '知らない画面を開いたときに何も表示されません。',
      instruction:
        `App${fw.componentExt} の画面分岐に既定の分岐を追加し、未知のルートでも最初の画面を描画してください。`,
    });
  }

  /**
   * Every ScreenId must have somewhere to render.
   *
   * The check above only fires on a `switch`, and generated apps overwhelmingly
   * write a chain of `{route.screen === 'x' && <XScreen />}` instead — so a
   * ScreenId with no branch sailed through, the router happily parsed the route,
   * and App returned nothing. That is the "render() は呼ばれましたが画面が空です"
   * error, and it was invisible to every existing check.
   *
   * Compared against the union rather than the nav items: NAV_ITEMS is a menu and
   * legitimately omits detail and auth screens, but any id the router can parse
   * has to be renderable.
   */
  const routes = get('src/routes.ts') || get('app/types-nav.ts');
  if (app && routes) {
    const { ids, constOf } = screenIds(routes);
    /*
     * A fallback, spelled the way the framework spells one.
     *
     * This read `else {`, `default:`, `?? <` and `: <X` — four React
     * spellings — and Vue writes `v-else`, Svelte writes `{:else}`. So the
     * check could not see a fallback in two of the three frameworks it runs
     * against, and it reported the last branch of a correct `v-if` chain as an
     * unrendered route. Nine of the 27 findings in the 597-document corpus
     * were a `v-else` and three were a `{:else}`; not one React document ever
     * raised it, which is what the asymmetry was telling us.
     */
    const hasFallback =
      /\belse\s*\{|default:|\?\?\s*<|:\s*<\w/.test(app) ||
      /\bv-else(?![-\w])/.test(app) ||
      /\{:else\s*\}/.test(app) ||
      // A dispatch function ending in a bare `return NotFoundScreen;` — the
      // whole line is the return, so nothing guards it. Deliberately narrow:
      // allowing `return <` as well would match the main return of every React
      // component and switch the check off for that framework entirely.
      /^\s*return\s+[A-Z][\w$]*\s*;?\s*$/m.test(app);
    // A screen is covered if App mentions the literal OR the constant that stands
    // for it. Checking only the literal reported every constant-based project as
    // fully broken, and — worse — reported constant-based unions as having no
    // screens at all, so the check passed while measuring nothing.
    /*
     * A bare object key is a mention too.
     *
     * `screenMap = { dashboard: DashboardScreen, 'category-detail': … }` covers
     * every id in it, but only the hyphenated ones need quotes — so the check
     * saw `'category-detail'` and missed `dashboard`, and named as unrendered
     * exactly the ids whose spelling happens to be a valid identifier. All 12
     * of the remaining corpus findings were that, and each named a subset of a
     * map that covered the whole union.
     */
    const unrendered = ids.filter((id) => {
      const name = constOf.get(id);
      if (new RegExp(`['"]${id}['"]`).test(app)) return false;
      if (name && new RegExp(`\\b${name}\\b`).test(app)) return false;
      if (/^[A-Za-z_$][\w$]*$/.test(id) && new RegExp(`[{,]\\s*${id}\\s*:`).test(app)) return false;
      return true;
    });
    /*
     * Abstain when App does not dispatch on a literal id at all.
     *
     * The check compares the union against the branches that name an id. A
     * shell that renders `<svelte:component this={SCREENS[route.screen]} />`,
     * or `<component :is>`, or a single screen unconditionally, has no such
     * branches — so every id looked unrendered and the finding named the whole
     * union. That was the other 15 of the 27, and the two shapes are correct
     * code: a map covers every id by construction, and a shell with no
     * conditional renders the same screen whatever the route, which is the one
     * thing that cannot go blank.
     *
     * Reporting nothing here is not a gap. The bug this check exists for is a
     * `route.screen === 'x'` chain that forgot an id, and such a chain names
     * the ids it does handle — so `mentioned` is non-empty and the finding
     * still fires, on exactly the document it was written for.
     */
    const mentioned = ids.length - unrendered.length;
    if (ids.length > 0 && unrendered.length > 0 && mentioned > 0 && !hasFallback) {
      defects.push({
        id: 'route-unrendered',
        note: '移動はできるのに中身が用意されていない画面があります。',
        instruction:
          `ScreenId に ${unrendered.map((i) => `'${i}'`).join(', ')} がありますが、App${fw.componentExt} に対応する` +
          '描画分岐がありません。ルーターはこのルートを解釈できるため、遷移すると画面が真っ白になります。' +
          '各 ScreenId に描画分岐を追加するか、どの分岐にも当たらなかった場合に最初の画面を描画する' +
          'フォールバックを最後に置いてください。',
      });
    }
  }

  // Both of the next two checks read React out of the source, and both were
  // measured firing on a Vue project that was fine.
  //
  // The store check asked for `useReducer` and, not finding it, told a Vue app
  // to write `src/store/AppProvider.tsx` with `useApp()` — React files, into a
  // Vue project that already had a working `src/store/index.ts`. The repair
  // pass would have carried that out. The scorer's copy of this rule was made
  // framework-aware; this copy was missed, so the audit went on reporting a
  // defect that did not exist and the repair it prescribed was destructive.
  if (!fw.storePattern.test(all)) {
    defects.push({
      id: 'store',
      note: '画面をまたいで共有される状態がありません。片方の画面での変更が他の画面に反映されません。',
      instruction:
        `${fw.storeFile} に共有ストア（${fw.storeHint}）を実装し、各画面がそれを介して読み書きする` +
        'ようにしてください。片方の画面での変更が他の画面に反映される必要があります。',
    });
  }

  // The handler check counted `onClick=`, which Vue spells `@click` and Svelte
  // spells `on:click` or `onclick`. Measured on a real Vue run: "10 buttons,
  // 0 handlers" on a project where every button was wired. Counting only the
  // React spelling does not report "no handlers" — it reports "not React".
  const buttons = count(all, /<button\b/gi);
  const onClicks = fw.handlerPatterns.reduce((n, re) => n + count(all, re), 0);
  if (buttons >= 8 && onClicks * 2 < buttons) {
    defects.push({
      id: 'dead-controls',
      instruction:
        `ボタンが ${buttons} 個ある一方でハンドラが ${onClicks} 個しかありません。` +
        'すべての操作要素に実際の動作を割り当ててください。動作を与えられない要素は削除してください。',
    });
  }

  /*
   * Where the calls are, and which of the two repairs each one needs.
   *
   * The instruction said "alert() / confirm() を使わず、モーダルとして実装して
   * ください" and named nothing. Across the corpus all 57 findings are real
   * calls — there is no false positive here — but they are two different jobs
   * wearing one sentence:
   *
   *     alert('必須項目を入力してください')        → an inline field error
   *     confirm('この申請を削除してもよろしいですか') → a modal with two buttons
   *
   * Told to build a modal, a repair building one for a validation message has
   * made the form worse. Each call is listed with the file it sits in and the
   * text it shows, under the repair that fits it.
   */
  const alerts: string[] = [];
  const confirms: string[] = [];
  for (const [path, body] of files) {
    if (/\.(md|markdown|txt)$/i.test(path)) continue;
    for (const m of body.matchAll(/\b(alert|confirm)\s*\(\s*(['"`])([^'"`]{0,60})/g)) {
      const at = `${path} の ${m[1]}('${m[3]}')`;
      (m[1] === 'alert' ? alerts : confirms).push(at);
    }
  }
  if (/\balert\s*\(|\bconfirm\s*\(/.test(all)) {
    defects.push({
      id: 'native-dialog',
      instruction:
        'alert() / confirm() はブラウザのダイアログで、画面の外に出ます。画面内の UI に' +
        '置き換えてください。' +
        (alerts.length
          ? `\n入力の検証やお知らせ（${alerts.slice(0, 5).join('、')}）は、` +
            '対象のフィールドの下にインラインのエラー文として出すか、トーストで表示してください。' +
            'モーダルにしないでください — 入力を止めてしまいます。'
          : '') +
        (confirms.length
          ? `\n取り消せない操作の確認（${confirms.slice(0, 5).join('、')}）は、` +
            '見出し・本文・「キャンセル」と実行の2ボタンを持つモーダルコンポーネントにして、' +
            'Esc と背景クリックで閉じられるようにしてください。'
          : ''),
    });
  }

  // Measured over `all` rather than `code`: the JSX and the stylesheet live in
  // different blocks, and the controls and their CSS have to be seen together.
  // `html`, not the joined bodies: the transport sentinels are what let the
  // finding name the file a rule lives in, and joining strips them.
  const sizing = auditFormControlSizing(html);
  if (sizing) defects.push(sizing);

  /*
   * Read out of the code, and quoted back.
   *
   * Two things were wrong. It tested `all`, which carries SPECIFICATION.md and
   * the design guidelines — and those name the placeholders as things not to
   * write, so 2 of the 11 corpus findings were the document being reported for
   * the prose telling it not to do the thing. Same fault `withoutProse` was
   * written for, in a check that predates it.
   *
   * And it named nothing. The other 9 are one string apiece — 「チェックアウト
   * 機能は準備中です」 in a toast — and the file and the line are known here.
   */
  const stubs: string[] = [];
  for (const [path, body] of files) {
    if (/\.(md|markdown|txt)$/i.test(path)) continue;
    const hit = PLACEHOLDER_RE.exec(body);
    if (!hit) continue;
    const line = body.slice(0, hit.index).split('\n').length;
    const quoted = body
      .slice(Math.max(0, hit.index - 30), hit.index + 40)
      .replace(/\s+/g, ' ')
      .trim();
    stubs.push(`${path}:${line}（…${quoted}…）`);
  }
  if (stubs.length > 0) {
    defects.push({
      id: 'placeholder',
      instruction:
        '「Coming Soon」「準備中です」などのプレースホルダが残っています: ' +
        stubs.slice(0, 5).join('、') +
        '。その機能を実際に動くように実装してください。実装しないのであれば、' +
        'その操作を呼び出しているボタンごと削除してください — ' +
        '押すと「準備中です」と出るボタンは、動かないことを知らせるためだけの操作です。',
    });
  }

  /*
   * Named as files to create, because the repair pass is told the opposite by
   * default.
   *
   * The planner is asked for "the fewest files that actually fix the defect" and
   * the per-file prompt says to keep the component structure exactly as it is —
   * both of which push against a repair whose whole content is new components
   * plus the screens that import them. Measured across five shipped documents:
   * `icons` and `imagery-missing` were reported on every one of them, in all
   * three frameworks, and closed on none. They are the only two defects in the
   * set that cannot be satisfied by editing a file that already exists.
   *
   * So the instruction carries the plan instead of leaving it to be inferred:
   * concrete paths, and the fact that the screens have to change too.
   */
  const icons = renderedFrom(files, 'src/components/icons/', fw.componentExt);
  if (files.size > 0 && icons.used.length === 0) {
    const ext = fw.componentExt;
    defects.push({
      id: 'icons',
      note:
        icons.all.length === 0
          ? 'アイコンが1つも描かれていません。'
          : `アイコンを${icons.all.length}個描いてありますが、どの画面にも表示されていません。`,
      instruction:
        (icons.all.length === 0
          ? 'src/components/icons/ がありません。**新しいファイルを作成してください** — ' +
            `例: src/components/icons/ChevronIcon${ext}、SearchIcon${ext}、CloseIcon${ext}、CheckIcon${ext}。` +
            '1グリフ1コンポーネントで、24x24 の viewBox、fill="none"、stroke="currentColor"、' +
            'stroke-width 1.5、装飾用途には aria-hidden。\n' +
            '**そのうえで、ナビ・ボタン・空状態・ステータス表示のある画面ファイルを編集し、' +
            'これらを import して使用してください。**'
          : // The files are there and nothing renders them. Asking for more
            // files would be asking for the half that is already done.
            `src/components/icons/ に ${icons.all.length} 個のアイコンがありますが、` +
            'どの画面からも描画されていません（' +
            icons.all
              .slice(0, 6)
              .map((p) => p.split('/').pop())
              .join('、') +
            '）。**新しいファイルは作らないでください。** ナビ・ボタン・空状態・ステータス表示の' +
            'ある画面ファイルを編集し、これらを import して要素として描画してください。' +
            'import しただけでは描画されません。') +
        ' ファイルを作るだけでは不十分です。絵文字をアイコンとして使わないでください。',
    });
  }

  if (hasLoginGate(code) && !hasVisibleDemoCredentials(code)) {
    defects.push({
      id: 'demo-login',
      instruction:
        'ログイン画面にデモ用の認証情報がありません。src/data/demoAccount.ts に DEMO_ACCOUNT を' +
        'エクスポートし、ログイン画面に「デモアカウント」と見出しを付けた枠でメールとパスワードを' +
        '両方表示し、「デモアカウントを入力」ボタンで両フィールドを埋め、その認証情報でログインが' +
        '通るようにしてください。レビュアーはアカウントを持っていないため、これが無いと先へ進めません。',
    });
  }

  /**
   * This framework's components, not React's.
   *
   * The filter read `\.tsx$`, so on a Vue or Svelte project it matched nothing
   * whatever the project contained — and `imagery-missing` fired on every run,
   * for ever, including the ones that had just created
   * `illustrations/EmptyState.svelte`, `ContentFrame.svelte` and
   * `Wordmark.svelte`. The defect was unsatisfiable in two of the three
   * frameworks.
   *
   * That is worse than a stray finding, because of what the repair loop does
   * with it. The pass creates the three files, the defect fires again anyway,
   * the count does not fall, the pass is judged "no improvement" and everything
   * it wrote is discarded. Measured on v191 Svelte, and on every Vue and Svelte
   * run of v194 and v195.
   *
   * `static-chart` below reads the same list, so it has never looked at a Vue or
   * Svelte chart either.
   */
  const { all: artFiles, used: artUsed } = renderedFrom(
    files,
    'src/components/illustrations/',
    fw.componentExt
  );

  /**
   * A chart that draws fixed bars is a picture of a chart.
   *
   * The first run under this contract produced exactly that: three <rect> elements
   * with hard-coded heights and a props interface carrying only `size`. It satisfies
   * every structural check — the folder exists, the file exists, it is real SVG —
   * while showing the reviewer numbers that have nothing to do with the app. A
   * data-driven chart necessarily maps over its input, so that is what is measured.
   */
  /*
   * Charts, wherever the project actually put them.
   *
   * This read `artFiles` — `src/components/illustrations/` only — and generated
   * projects put their charts in `src/components/ui/` (151 files across the
   * corpus), `src/components/charts/` (89) and `src/screens/charts/` (36). 125
   * documents have a chart component outside the folder this was looking in, so
   * the check has been measuring a corner of the problem.
   *
   * Two exclusions, both measured:
   *
   *   icons/  — `src/components/icons/BarChart.tsx` is a 24x24 glyph of a bar
   *   chart. Fixed rects are exactly right there, and widening without this
   *   would report every icon set that contains one.
   *
   *   wrappers — a `ChartContainer` that is a title and a `<slot />` has no
   *   geometry to drive. Requiring drawn geometry keeps the finding on the
   *   thing that draws.
   */
  const chartFiles = [...files.keys()].filter(
    (p) =>
      p.endsWith(fw.componentExt) &&
      /chart|graph|sparkline/i.test(p) &&
      !p.startsWith('src/components/icons/')
  );
  for (const path of chartFiles) {
    const src = files.get(path) ?? '';
    // A wrapper passes its content through; there is nothing in it to drive.
    if (/<slot[\s/>]|\{@render\s|\{\s*children\s*\}/.test(src)) continue;
    // And it has to draw something: an <svg>, or bars sized from a style.
    if (!/<svg[\s>]|class=["'][^"']*bar/i.test(src)) continue;
    /*
     * And something has to render it.
     *
     * All 53 corpus findings were a `DataGraphIllustration` that appears
     * exactly once in the whole document — in its own file header. Nothing
     * imports it, nothing renders it, and the reviewer never sees it. Telling a
     * repair to make an invisible file data-driven spends a pass and changes
     * nothing on screen.
     *
     * That an unused illustration is itself worth reporting is true and is a
     * different finding; this one is about what a chart shows.
     */
    const name = path.split('/').pop()?.replace(/\.[^.]+$/, '') ?? '';
    const rendered = [...files.entries()].some(
      ([other, body]) => other !== path && new RegExp(`<${name}(?![\\w$])`).test(body)
    );
    if (!rendered) continue;
    if (!fw.iteration.test(src)) {
      defects.push({
        id: 'static-chart',
        note: 'グラフが固定値で描かれていて、実際のデータを反映していません。',
        instruction:
          `${path} が固定値で描かれたグラフになっています。props で数値の配列を受け取り、` +
          `${outputKind === 'vue' ? 'v-for' : '.map()'}` +
          ' で棒や点を描画し、軸ラベルと値を実データから出してください。' +
          '呼び出し側はストアの実際の数値を渡してください。',
      });
      break;
    }
  }

  if (files.size > 0 && artUsed.length === 0) {
    defects.push({
      id: 'imagery-missing',
      note:
        artFiles.length === 0
          ? '空状態やコンテンツ枠の図版が描かれていません。'
          : `空状態などの図版を${artFiles.length}個描いてありますが、どの画面にも表示されていません。`,
      instruction:
        (artFiles.length === 0
          ? 'src/components/illustrations/ がありません。**新しいファイルを3つ以上作成してください** — ' +
            `例: src/components/illustrations/EmptyState${fw.componentExt}、` +
            `ContentFrame${fw.componentExt}、Wordmark${fw.componentExt}。` +
            // Not `var(--border)` / `var(--text-muted)` by name: this instruction
            // used to dictate those two, and 22 of 34 shipped projects drew
            // artwork in custom properties their own stylesheet never defines —
            // an undefined property on `stroke` computes to none, so the drawing
            // is there and invisible. See fixUndefinedTokens.
            '空状態の線画は 120〜180px の stroke のみ、色はこのプロジェクトの' +
            'スタイルシートが実際に定義しているボーダー色と淡いテキスト色のトークンで' +
            '（定義されていないカスタムプロパティを stroke に指定すると none になり、' +
            '描いても見えません）、' +
            'アイコンを拡大したものにしないでください。\n' +
            '**そのうえで、空状態や画像枠のある画面ファイルを編集して import し、使用してください。**'
          : `src/components/illustrations/ に ${artFiles.length} 個のイラストがありますが、` +
            'どの画面からも描画されていません（' +
            artFiles
              .slice(0, 6)
              .map((p) => p.split('/').pop())
              .join('、') +
            '）。**新しいファイルは作らないでください。** 空状態・画像枠・ヘッダーのある画面ファイルを' +
            '編集し、これらを import して要素として描画してください。' +
            'import しただけでは描画されません。') +
        ' 灰色の枠を画像の代わりに置かないでください。',
    });
  } else if (IMAGE_HOLE_RE.test(all)) {
    defects.push({
      id: 'image-hole',
      instruction:
        '「画像なし」のようなエラー文言が残っています。写真が入る枠は、アスペクト比を持つ' +
        'プレースホルダコンポーネントとして描いてください。',
    });
  } else if (PHOTO_SLOT_RE.test(all) && !photoSlotsAreSized(all)) {
    defects.push({
      id: 'photo-slot-unsized',
      instruction:
        '写真のプレースホルダに寸法がありません。aspect-ratio と背景色を指定し、中央に小さな' +
        '写真アイコンを置いてください。寸法が無いと高さ 0 に潰れます。',
    });
  }

  defects.push(...navigationShapeDefects(files));

  return defects;
}

/**
 * Calls to the router that disagree with how the router is declared.
 *
 * Two real failures, opposite directions, one cause — the navigation function
 * and its call sites are written by different passes, and nothing checked that
 * they agreed.
 *
 * Reported by a user, clicking a product card in a generated storefront:
 *
 *     TypeError: Cannot read properties of undefined (reading 'params')
 *       at hash (…)  at onClick (…)
 *
 * Found in a later run, silently:
 *
 *     const navigate = (screen: ScreenId) => { location.hash = `#/${screen}` }
 *     …
 *     navigate({ screen: 'home' })          // -> '#/[object Object]'
 *
 * The second does not throw — a template literal stringifies anything — so it
 * ships as a route nobody can parse and a screen nobody can reach. The browser
 * walk recorded that screen id as `[object%20Object]`.
 *
 * TypeScript would catch both of these, and does not run here: the preview
 * compiles with Sucrase, which strips the types without checking them. So the
 * one thing that makes these files a program rather than a pile of text has to
 * be checked somewhere, and this is the cheapest place to do it.
 *
 * Deliberately narrow. A parameter that admits both shapes is skipped outright,
 * because then no call site is wrong.
 */
function navigationShapeDefects(files: Map<string, string>): InteractionDefect[] {
  let param = '';
  let declaredIn = '';
  for (const [path, body] of files) {
    const m =
      /(?:export\s+)?(?:function\s+navigate|const\s+navigate\s*(?::[^=]+)?=\s*)\s*\(\s*(\w+)\s*\??\s*:\s*([^),=]+)/.exec(body) ??
      /\bnavigate\s*\(\s*(\w+)\s*\??\s*:\s*([^),=]+)\)\s*(?::\s*\w+\s*)?(?:=>|\{)/.exec(body);
    if (!m) continue;
    param = m[2].trim();
    declaredIn = path;
    break;
  }
  // No declaration found, or one that takes either shape: nothing to disagree with.
  if (!param || param.includes('|')) return [];

  const wantsObject = /\bRoute\b|^\{/.test(param);
  const wantsString = !wantsObject && /ScreenId|string/.test(param);
  if (!wantsObject && !wantsString) return [];

  const wrong: string[] = [];
  for (const [path, body] of files) {
    for (const m of body.matchAll(/\bnavigate\s*\(\s*(.{0,2})/g)) {
      const head = m[1].trimStart().slice(0, 1);
      if (!head) continue;
      const bad = wantsString ? head === '{' : /['"`]/.test(head);
      if (bad && !wrong.includes(path)) wrong.push(path);
    }
  }
  if (wrong.length === 0) return [];

  return [
    {
      id: 'navigate-shape',
      note: '画面遷移の呼び出し方が場所によって食い違っています。',
      instruction:
        `画面遷移の関数は ${declaredIn} で navigate(${param}) と宣言されていますが、` +
        `次のファイルは${wantsString ? 'オブジェクト' : '文字列'}を渡しています: ` +
        `${wrong.slice(0, 4).join('、')}。` +
        (wantsString
          ? '文字列を受ける関数にオブジェクトを渡すと、ハッシュが #/[object Object] になります。' +
            '例外にはならないため気付かれないまま、解釈できないルートとして残り、' +
            'その画面へ到達できなくなります。'
          : 'オブジェクトを受ける関数に文字列を渡すと、関数の中で route.screen や ' +
            'route.params を読んだ時点で例外になり、押した瞬間に画面が落ちます。') +
        '宣言と呼び出しのどちらかに揃えてください。両方受けたい場合は、' +
        '関数側で文字列を受け取ったときに既定のルートへ包むこと。' +
        'なお、この不一致は TypeScript なら検出できますが、プレビューは Sucrase で' +
        '型を落としてコンパイルするため、実行するまで分かりません。',
    },
  ];
}

/**
 * Two ways a project compiles perfectly and is still not a usable mock.
 *
 * Both were measured on real `standard` runs of the same brief, and both were
 * invisible to every existing check because the code is correct — it is the
 * product decision that is wrong.
 *
 *   AUTH GATE. `if (!state.currentUser && route.screen !== 'login') { navigate('login'); return null }`
 *   with `currentUser: null` in the initial state. Every route redirects to the
 *   sign-in screen, so a nine-screen application renders exactly one. Browser
 *   verification reported `screens: [{id:'login'}]` and could go no further:
 *   nothing it can click gets in, because getting in needs credentials typed.
 *   A mock is a thing someone opens and looks at. It starts signed in, and the
 *   sign-in screen is somewhere you can go, not somewhere you begin.
 *
 *   SHELL WITHOUT NAVIGATION. `routes.ts` declared NAV_ITEMS with nine entries
 *   and the shell rendered `<header><h1>title</h1></header><main>{screen}</main>`.
 *   The navigation contract existed, was typed, was exported — and nothing put it
 *   on the screen, so no screen could be reached from any other.
 *
 * Framework-agnostic on purpose: the shell is `App.tsx`, `App.vue` or
 * `App.svelte`, and all three fail this way.
 */
/** A literal newline, kept as a constant so the joins below read cleanly. */
const NEWLINE = '\n';

export function auditShellContract(html: string, outputKind: OutputKind): InteractionDefect[] {
  const files = readProjectFiles(html);
  if (files.size === 0) return [];
  const fw = FRAMEWORKS[outputKind];
  const defects: InteractionDefect[] = [];

  // A path, not a pattern. The regex this replaces was written as a template
  // literal with an escaped dollar, so it never interpolated — it tested for the
  // literal text ${fw.componentExt} and matched nothing, which left the shell
  // empty and silently disabled the auth-gate check below.
  const shellPath = [...files.keys()].find((p) => p === `src/App${fw.componentExt}`);
  const shell = shellPath ? files.get(shellPath) ?? '' : '';
  const routes = files.get(fw.routesFile) ?? '';
  const store = [...files.entries()]
    .filter(([p]) => /store|state|context|provider/i.test(p))
    .map(([, b]) => b)
    .join(NEWLINE);

  /**
   * A sign-in the app starts on. Detected from the shell redirecting to it plus
   * an initial state with nobody signed in — either alone is fine. A shell that
   * renders a login screen among the others is a normal screen; an initial state
   * with a null user and no gate is a project that simply has an optional login.
   */
  const gates = /(?:!|===\s*null|==\s*null|\?\?)/.test(shell) &&
    /\b(currentUser|isAuthenticated|isLoggedIn|authUser|session|user)\b/.test(shell) &&
    /['"`]login['"`]|LoginScreen|SigninScreen|SignInScreen/.test(shell);
  const startsSignedOut =
    /\b(currentUser|authUser|session)\s*:\s*null/.test(store) ||
    /\b(isAuthenticated|isLoggedIn)\s*:\s*false/.test(store);
  if (gates && startsSignedOut) {
    defects.push({
      id: 'auth-gate',
      instruction:
        'アプリ全体がログイン画面で塞がれています。初期状態で未ログインのため、' +
        'どの画面も表示できません。**モックはログイン済みの状態で始めてください**: ' +
        '共有状態の初期値にデモユーザーを入れ、シェルのリダイレクトを外してください。' +
        'ログイン画面は残してよいですが、ヘッダーのサインアウトから「行ける画面」にしてください。' +
        'デモ用の認証情報は画面上に見える形で残し、その値でログインが通るようにしてください。',
    });
  }

  /**
   * NAV_ITEMS declared and never rendered. The list is looked for in the shell
   * and in whatever the shell imports one level down, because a project that put
   * its navigation in a `Sidebar` component is doing the right thing.
   */
  if (/NAV_ITEMS/.test(routes)) {
    const chrome = [...files.entries()]
      .filter(([p]) => p === shellPath || /components\/(ui\/)?(nav|sidebar|header|shell|menu|topbar)/i.test(p))
      .map(([, b]) => b)
      .join(NEWLINE);
    /*
     * A shell that already navigates is not a shell without navigation.
     *
     * The finding's claim is "画面同士が行き来できないため、最初の画面以外に到達
     * できません" — and 58 of the 238 documents that raised it across the corpus
     * had a working `<nav>` in the shell, hand-written instead of iterated from
     * NAV_ITEMS. The list not being used is a contract violation; the sentence
     * describing what it costs the user was false, and a repair round was spent
     * rebuilding navigation the document already had.
     *
     * Coverage is what decides it: as many distinct hash targets in the chrome
     * as NAV_ITEMS has entries means every declared destination is reachable,
     * however the links were written. Fewer, and the finding stands — and if
     * some screens really are cut off, the browser walk reports that too, from
     * the rendered page rather than from the source.
     */
    const entries = (/NAV_ITEMS[^=]*=\s*\[([\s\S]*?)\]/.exec(routes)?.[1] ?? '').split('{').length - 1;
    /*
     * `#/screen`, with the slash required.
     *
     * `href="#"` is a placeholder — a footer full of 利用規約 / プライバシー
     * ポリシー links that go nowhere — and counting those would let three dead
     * links clear a three-entry NAV_ITEMS. `#/` on its own is not a placeholder
     * though: it is the home route, and a two-item nav of `#/` and `#/cart`
     * covers both of its entries.
     */
    const targets = new Set([...chrome.matchAll(/#\/([\w-]*)/g)].map((m) => m[1] || '/'));
    if (!/NAV_ITEMS/.test(chrome) && !(entries > 0 && targets.size >= entries)) {
      /*
       * The keys the list actually carries, and the call the project already
       * navigates with.
       *
       * The instruction used to say "iterate NAV_ITEMS and render a navigation" 
       * and stop there. It survived three repair passes on v144 and was still
       * open on both React and Vue at v194 — and when a model does act on it,
       * the corpus says what it writes: `href={item.hash}`, `item.screen`,
       * `item.href`, `item.icon`, off elements that carry only `id` and `label`.
       * Twelve of the stored documents do exactly that, and every one renders a
       * nav whose links go nowhere. So the two things it gets wrong are named
       * rather than left to be inferred: what is in an element, and how this
       * project changes screens.
       */
      const keys = new Set<string>();
      const literal = /NAV_ITEMS[^=]*=\s*\[([\s\S]*?)\]/.exec(routes)?.[1] ?? '';
      for (const m of literal.matchAll(/(?:^|[{,])\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/g))
        keys.add(m[1] ?? m[2] ?? m[3]);
      /*
       * Whatever this project actually navigates with, named as it is written.
       *
       * Three shapes are in circulation and only one is a bare function: React
       * tends to a `useNavigation` hook, Vue to a composable of the same name,
       * Svelte to a plain `navigate` exported from `lib/navigation.svelte.ts`.
       * Matching only the bare form left the two commonest cases with the
       * generic sentence.
       */
      const navSource = [...files.entries()]
        .filter(([p]) => /\/(navigation|router|routes|store)\b/i.test(p) || /useNavigation/.test(p) || p === shellPath)
        .map(([, b]) => b)
        .join(NEWLINE);
      const direct = /export\s+(?:default\s+)?(?:async\s+)?(?:function\s+|const\s+)(navigate|navigateTo|goTo|setScreen)\b/.exec(navSource)?.[1];
      /*
       * The hook that actually hands back a `navigate`, not the first one
       * declared.
       *
       * Taking the first match named `useApp()` on a project whose
       * `useNavigation()` returns `{ route, navigate, back, canGoBack }` —
       * `useApp` is a store hook there and returns a context with no navigate in
       * it. An instruction naming a call that does not exist is worse than the
       * generic sentence it replaces, so the body has to show the name before it
       * is quoted.
       */
      let hook: string | undefined;
      for (const m of navSource.matchAll(/export\s+(?:default\s+)?(?:function\s+|const\s+)(use[A-Z][\w$]*)\b/g)) {
        if (/\bnavigate\b/.test(navSource.slice(m.index ?? 0, (m.index ?? 0) + 1200))) { hook = m[1]; break; }
      }
      const navCall = direct
        ? `${direct}(item.id) で`
        : hook
          ? `${hook}() が返す navigate に item.id を渡して`
          : '';
      defects.push({
        id: 'shell-without-nav',
        instruction:
          (targets.size > 0
            ? // Partial coverage. Saying "描画されていません" to a shell that has
              // a nav in it describes a different document, and the repair is
              // not the same one: the links exist and some destinations are
              // missing from them.
              `src/routes.ts の NAV_ITEMS は ${entries} 個ありますが、シェル` +
              `（src/App${fw.componentExt}）から辿れるのは ${targets.size} 個だけです。` +
              '残りの画面にはリンクがありません。'
            : `src/routes.ts が NAV_ITEMS を定義しているのに、シェル（src/App${fw.componentExt}）にも` +
              'ナビゲーション部品にも描画されていません。画面同士が行き来できないため、' +
              '最初の画面以外に到達できません。') +
          'NAV_ITEMS を反復して、' +
          '現在の画面に aria-current が付くナビゲーションをシェルに描画してください。' +
          (keys.size
            ? `NAV_ITEMS の各要素が持つプロパティは ${[...keys].join(' と ')} だけです。` +
              'hash・href・screen・icon などは存在しないので参照しないでください' +
              '（参照すると href が undefined になり、リンクが一切動かないナビゲーションになります）。'
            : '') +
          (navCall
            ? `画面の切り替えは、このプロジェクトが既に持っている ${navCall}行ってください。`
            : '画面の切り替えは、各画面が既に使っているのと同じ仕組みで item.id を渡して行ってください。'),
      });
    }
  }

  // A checkout that renders its form over an empty cart — see tools/shell-fixes.ts.
  const unguarded = unguardedCheckouts(files);
  if (unguarded.length > 0) {
    defects.push({
      id: 'flow-unguarded',
      note: 'カートが空でも、チェックアウトの画面が入力フォームのまま開けます。',
      instruction:
        `${unguarded.join('、')} は、カートが空のまま開かれても入力フォームや注文確定ボタンを表示します。` +
        'ナビゲーションから外していても、URL を直接開けばこの状態になります。' +
        'カートが空のときは、フォームの代わりに「カートに商品がありません」のような短い説明と、' +
        '商品一覧へ戻るボタンだけを表示する分岐を、この画面の先頭に追加してください。' +
        'カートに商品があるときの表示と動作は変えないでください。',
      paths: unguarded,
    });
  }

  /*
   * An action no reducer handles — see tools/source-consistency.ts. The names
   * that could be matched without doubt were renamed by the fixups before this
   * runs; what is left needs a decision only the code's meaning can make.
   */
  const { unhandled, handled } = unhandledDispatches(files);
  if (unhandled.length > 0) {
    const senders = [...files.entries()]
      .filter(([, body]) => unhandled.some((t) => body.includes(`'${t}'`) || body.includes(`"${t}"`)))
      .map(([path]) => path);
    defects.push({
      id: 'dispatch-unhandled',
      note: `押しても状態が変わらない操作があります（${unhandled.slice(0, 3).join('、')}）。`,
      instruction:
        `次の action は dispatch されていますが、どの reducer の case も処理しないため無視されます: ${unhandled.join(', ')}。` +
        `reducer が処理する type は ${handled.slice(0, 30).join(', ')} です。` +
        '送る側の type を処理される名前に合わせるか、reducer に case を追加して、この操作が状態を変えるようにしてください。' +
        'payload の形も、その case が読む形に合わせてください。',
      paths: senders,
    });
  }

  return defects;
}

/**
 * Which audit a document gets, decided by what the document IS.
 *
 * This read `outputKind === 'react' ? auditReact : auditHtml`, and the else
 * branch is an audit for a single interactive HTML page — a format this product
 * stopped producing entirely. So a Vue or Svelte project was checked by an audit
 * looking for `data-screen` attributes and inline `onclick` handlers in markup
 * that has neither, and it reported nothing. Two of the three supported
 * frameworks had no interactivity checking at all: no "are there enough
 * screens", no "does the router subscribe to hashchange", no "does an unknown
 * route fall back", no "is there a shared store" — every one of them silent.
 *
 * The question that matters is whether the document is a project, and
 * `detectKind` answers it from the files. `auditHtml` is kept for documents
 * stored before the project formats existed, which is the only thing that can
 * still reach it.
 */
export function auditInteractivity(html: string, _outputKind: OutputKind): InteractionDefect[] {
  try {
    const kind = detectKind(readProjectFiles(html).keys())
    return kind ? auditProject(html, kind) : auditHtml(html);
  } catch {
    // An audit failure must never fail the generation it was meant to improve.
    return [];
  }
}
