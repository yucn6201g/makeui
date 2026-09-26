/**
 * What the finished run says in the chat.
 *
 * The reply is rendered as the assistant's message and nothing else is added to
 * it, so whatever ends up here is the entire answer to 「何が出来たのか」.
 * Measured across 45 stored results, 18 of them were not that:
 *
 *   12  a file plan — 「新規 src/screens/ContactScreen.tsx — new contact form
 *       screen with validation」 and four more lines like it, in English, in a
 *       Japanese thread. True, and about the machine rather than the product.
 *    6  a transported file block, because the preamble is everything before the
 *       document starts and a `SPECIFICATION.md` written ahead of the document
 *       is inside it. One reply was 6,541 characters, most of them a spec.
 *
 * Both are extraction artifacts rather than anything a model chose to say. The
 * generation prompt already asks for three to five Japanese sentences covering
 * what the product is, the design direction and the screens — which is exactly
 * the brief description wanted — and that text is what survives once these two
 * are removed.
 */

import { readProjectFiles } from '../../tools/project/project-transport.js'
import type { RequirementResult } from '../generate/requirements.js'
import { isCriticFinding, repairable } from '../repair/repair-yield.js'

/** A file carried inside the document, in either transport this project uses. */
const MARKDOWN_FILE_BLOCK = /<script\b[^>]*\bdata-file\b[^>]*>[\s\S]*?<\/script>/gi;
const FENCED_FILE_BLOCK = /@@@makeui:file\b[\s\S]*?@@@makeui:endfile[^\n]*\n?/g;
/** An opening sentinel with no close — a preamble cut off mid-block. */
const UNCLOSED_FILE_BLOCK = /(?:@@@makeui:file\b|<script\b[^>]*\bdata-file\b[^>]*>)[\s\S]*$/i;

/**
 * One line of a file plan: an optional outcome mark, 新規 or 編集, then a path.
 *
 * Anchored on the path rather than the verb, because 「編集」 also opens
 * perfectly good prose — 「編集画面を追加しました」 is a description, not a plan.
 */
const FILE_PLAN_LINE = /^\s*(?:[✓×]\s*)?(?:新規|編集)\s+[\w./@-]+\.\w+/;

export function stripTransportedFiles(text: string): string {
  return text
    .replace(MARKDOWN_FILE_BLOCK, '')
    .replace(FENCED_FILE_BLOCK, '')
    .replace(UNCLOSED_FILE_BLOCK, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Whether this is the planner's file list rather than an account of the change.
 *
 * Every non-empty line has to look like a plan line. A reply that opens with a
 * sentence and then lists the files it touched is a fuller answer than either
 * half, and replacing it would lose the sentence.
 */
export function isFilePlan(text: string): boolean {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  return lines.every((l) => FILE_PLAN_LINE.test(l));
}

/** True when a file plan carries an unapplied line, from `describeEditOutcome`. */
function isPartial(text: string): boolean {
  return /^\s*×/m.test(text);
}

/**
 * The reply for an edit, in the user's own words.
 *
 * Deliberately not a rephrasing: turning 「検索ボックスを追加して」 into a past
 * tense sentence is not something that can be done to arbitrary Japanese without
 * a model, and spending a call to restate what the user just typed is the wrong
 * trade. Their own text, listed under one sentence that says what happened to it,
 * says more than a path does and cannot be wrong about the wording.
 *
 * When part of the edit did not land, the file list is kept rather than replaced:
 * it is the only record of which half of the request is missing, and a summary
 * that said 「適用しました」 over an incomplete edit would be worse than a list of
 * paths. The sentence above it says so in words first.
 */
export function describeEditResult(
  parts: { text: string }[],
  instruction: string,
  planText: string
): string {
  const items = (parts.length > 1 ? parts.map((p) => p.text) : [instruction])
    .map((t) => t.trim())
    .filter(Boolean);

  if (isPartial(planText)) {
    return ['一部の変更を適用できませんでした。', '', planText.trim()].join('\n');
  }
  if (items.length === 0) return '変更を適用しました。';
  if (items.length === 1) return `変更を適用しました。\n・${items[0]}`;
  return ['次の変更を適用しました。', ...items.map((t) => `・${t}`)].join('\n');
}

/**
 * The whole reply for an edit: what was asked, and what the source shows of it.
 *
 * The file-plan branch was unreachable. `replyText(plan, '')` returns its
 * fallback for a file plan — that is what it is for — so the caller's
 * `isFilePlan(cleanedPlan)` was only ever handed an empty string, and every
 * per-file edit replied 「変更を適用しました。」 and nothing else. Measured on the
 * verification edit, which had two parts and listed neither. The scaffolding is
 * stripped here without that fallback, so a file plan is still recognised as
 * one and described by the parts it served.
 *
 * Then the checklist, both ways. A miss is listed with where it went wrong when
 * that is known; a clean check says how many checkable parts were confirmed,
 * because 「適用しました」 alone reads the same whether the change is in the
 * project or only a file was written.
 */
export function describeEditReply(
  plan: string | undefined,
  parts: { text: string }[],
  instruction: string,
  checks: RequirementResult[]
): string {
  const cleaned = stripSelfAddressedScaffolding(stripTransportedFiles(plan ?? ''));
  const base = cleaned && !isFilePlan(cleaned)
    ? cleaned
    : describeEditResult(parts, instruction, cleaned);

  const notLanded = checks.filter((r) => r.status === 'unmet');
  const checkable = checks.filter((r) => r.status !== 'unverified').length;
  if (notLanded.length === 0) {
    return checkable > 0
      ? `${base}\n\n指示のうち自動で確認できる${checkable}件は、変更後のソースで確認しました。`
      : base;
  }
  const where = (r: RequirementResult): string => {
    if (r.reason !== 'misplaced') return '';
    const c = r.requirement.check;
    if (c.kind !== 'text') return '';
    return c.where === 'shared'
      ? '（全画面に共通する場所ではなく、一部の画面にだけあります）'
      : `（「${c.where}」画面にはありません）`;
  };
  return [
    base,
    '',
    '次の指示は、変更後のソースで確認できませんでした:',
    ...notLanded.map((r) => `・${r.requirement.text}${where(r)}`),
  ].join('\n');
}

/**
 * The reply to store, given whatever the run produced.
 *
 * `fallback` is used when nothing legible survives — an empty preamble, or a
 * plan that was only ever a file list and has no edit context to describe. It is
 * the caller's one-line 「生成しました」/「変更を適用しました」, which is short but
 * true, where the raw extraction is long and about the wrong subject.
 */
export function replyText(raw: string | undefined, fallback: string): string {
  const cleaned = stripSelfAddressedScaffolding(stripTransportedFiles(raw ?? ''));
  if (!cleaned) return fallback;
  if (isFilePlan(cleaned)) return fallback;
  return cleaned;
}

/** What a finished run measured, as the reply needs it. */
export interface RunOutcome {
  /** Screens the browser opened, and how many the project declares. */
  reached?: number;
  declared?: number;
  /**
   * Of the screens the walk did not reach, the ones the project itself
   * navigates to after something happens — checkout after 「レジへ進む」, a
   * completion after 「注文を確定」. The walk clicks; it does not fill forms or
   * put things in a cart, so these are closed to it by design, and a count that
   * includes them reads as broken screens. One entry per screen: its name from
   * the specification, or '' when the project names it nowhere.
   */
  afterAction?: string[];
  /** Console errors seen during the walk. */
  consoleErrors?: number;
  /** Files in the finished project, and how they divide. */
  files?: number;
  screens?: number;
  components?: number;
  /**
   * What the screens are called, from the project's own NAV_ITEMS.
   *
   * A count is not an account of the work. 「5画面すべてに到達しました」 says the
   * run went well and nothing about what was built, and the reader has just
   * asked for a product — so the screens are named where the project names
   * them. Only the labelled ones: a screen reached from a list rather than from
   * the nav has an id like `catalog-detail` and no label, and printing that
   * would be reporting an internal name as a feature.
   */
  screenNames?: string[];
  /** What is still open, most important first, already phrased for a reader. */
  defects?: { id: string; note: string }[];
  /**
   * The user's own requirements, checked against the finished project.
   *
   * Counts rather than a list: the unmet ones a repair could act on are already
   * among `defects` above and fold with them. What this line adds is the part
   * the defects cannot say — how many were checked and held, and how many could
   * not be checked by machine at all, which is a limit worth stating rather than
   * a success worth implying. See orchestration/generate/requirements.ts.
   */
  requirements?: { total: number; met: number; unmet: number; unverified: number; unmetScreens: string[] };
  /** False when nothing was rendered — 節約 and 高速 do not verify. */
  verified: boolean;
  /**
   * Whether this run ASKED the browser. Separate from `verified`, because
   * "not asked" and "asked and got nothing back" are different things to tell
   * a user — and this line used to tell a 仕上げ user the first when the second
   * had happened: 「このモードでは省略されます」 about a mode that verifies.
   */
  verifyAttempted?: boolean;
  /** What went wrong, when it was asked and nothing came back. */
  verifyFailure?: {
    reason: 'page-frozen' | 'browser';
    frozeOn?: { kind: string; hash: string; label: string };
  };
}

/**
 * How much was built, counted from the document rather than from the plan.
 *
 * The manifest says what was asked for; this says what is there. They differ
 * whenever a file did not come back, which is exactly the case a reader would
 * want the reply to be honest about.
 *
 * Only source files count as a screen or a component. A project that gives each
 * screen its own stylesheet has two files per screen under `src/screens/`, and
 * counting both told a user who asked for three screens
 * 「蔵書一覧・貸出登録・返却期限アラート ほか3画面を作成しました。」 — three screens
 * that do not exist, in the one line the reply says they can check.
 */
const SOURCE_FILE = /\.(tsx|jsx|ts|js|vue)$/i

export function projectFileCounts(html: string): { files: number; screens: number; components: number } {
  const paths = [...readProjectFiles(html).keys()].filter((p) => !/\.(md|markdown|txt)$/i.test(p))
  const sources = paths.filter((p) => SOURCE_FILE.test(p))
  return {
    files: paths.length,
    screens: sources.filter((p) => /^src\/screens\//.test(p)).length,
    components: sources.filter((p) => /^src\/components\//.test(p)).length,
  }
}

/**
 * The run, in facts, under whatever the model said about it.
 *
 * The reply is the model's preamble: what it intended to build, written before
 * it built anything and shown after it finished. Measured on the newest stored
 * reply, it opens 「緻密な設計を確認しました」 and continues 「これから…一気に生成
 * します」 — future tense, about a run that is over. Nothing in it says what
 * came out.
 *
 * Everything needed to say that was already measured and already on the wire in
 * `metadata.verification`: screens reached against screens declared, console
 * errors, the file counts, and the open findings with notes already written in
 * Japanese for a reader. The frontend had no reference to any of it.
 *
 * Deliberately not the score and not the token count. Both have a chip in the
 * meta row under the reply, and `UI generated (Score: 74/100)` was removed from
 * this text once already for being a second copy of one of them in English. What
 * goes here is what a chip cannot hold: which screens, and what is still wrong,
 * in words.
 *
 * When nothing was rendered it says so rather than reporting zeros. 節約 and
 * 高速 skip verification entirely, and 「エラー0件」 from a run that never opened
 * the page is the same false claim the score's 「静的のみ」 mark exists to prevent.
 */
export function describeOutcome(out: RunOutcome): string {
  const lines: string[] = [];

  if (!out.verified && out.verifyAttempted && out.verifyFailure?.reason === 'page-frozen') {
    /*
     * The case this branch was written for. A 仕上げ run whose item rows froze
     * the page was told its mode had skipped verification; what happened was
     * that verification found the worst defect a mock can have and could not
     * say so.
     */
    const on = out.verifyFailure.frozeOn;
    const where = on?.label ? `「${on.label}」を押したところで` : '';
    lines.push(
      `ブラウザで実際に動かして検証しましたが、${where}ページが応答しなくなり、検証を最後まで行えませんでした。` +
        'スコアはソースの検査だけに基づいています。'
    );
  } else if (!out.verified && out.verifyAttempted) {
    lines.push('ブラウザでの検証を試みましたが、完了できませんでした。スコアはソースの検査だけに基づいています。');
  } else if (!out.verified) {
    lines.push('ブラウザ実行による検証は行っていません（このモードでは省略されます）。');
  } else if (out.declared) {
    const after = out.afterAction ?? [];
    const named = after.filter(Boolean);
    const which = named.length === after.length && named.length > 0 ? `（${named.join('・')}）` : '';
    const reached = out.reached ?? 0;
    const missed = out.declared - reached - after.length;
    const reach = out.reached === out.declared
      ? `${out.declared}画面すべてに到達しました`
      : after.length > 0 && missed <= 0
        ? `操作なしで開ける${reached}画面すべてに到達しました。残る${after.length}画面${which}は、カートへの追加や入力の確定など前の操作の後に開く画面で、巡回では入力や確定をしないため開いていません`
        : after.length > 0
          ? `${out.declared}画面中 ${reached}画面に到達しました（ほかに、前の操作の後に開く画面が${after.length}つあります${which}）`
          : `${out.declared}画面中 ${reached}画面に到達しました`;
    const errors = out.consoleErrors
      ? `コンソールエラー ${out.consoleErrors}件`
      : 'コンソールエラーはありません';
    lines.push(`${reach}。${errors}。`);
  }

  /*
   * What was built, before how much of it. The named screens come first because
   * they are the only line in this block a reader can check against what they
   * asked for.
   */
  const named = out.screenNames ?? [];
  if (named.length > 0 && out.screens) {
    const shown = named.slice(0, 6).join('・');
    const rest = out.screens - Math.min(named.length, 6);
    lines.push(rest > 0 ? `${shown} ほか${rest}画面を作成しました。` : `${shown} の${out.screens}画面を作成しました。`);
  }

  if (out.files) {
    const parts = [
      out.screens && named.length === 0 ? `画面${out.screens}` : '',
      out.components ? `コンポーネント${out.components}` : '',
    ].filter(Boolean);
    lines.push(`${out.files}ファイル${parts.length ? `（${parts.join('・')}）` : ''}を生成しました。`);
  }

  /*
   * The requirements line, before the findings.
   *
   * Only when something was checkable: a request that yielded nothing but
   * behaviour requirements has nothing to report as met, and 「0件を確認しました」
   * would read as a failure it is not. Screens are named when missing, because
   * they never reach the repair (see `requirementDefects`) and would otherwise
   * be reported nowhere.
   */
  const req = out.requirements;
  if (req && req.total > 0 && req.total > req.unverified) {
    const checked = req.total - req.unverified;
    const parts = [`依頼の要件のうち、自動で確認できる${checked}件中${req.met}件を満たしています。`];
    if (req.unmetScreens.length > 0) parts.push(`画面「${req.unmetScreens.join('」「')}」は見つかりませんでした。`);
    if (req.unverified > 0) parts.push(`ほかの${req.unverified}件は自動では確認できない要件です。`);
    lines.push(parts.join(''));
  }

  /*
   * Every open finding, not the first three.
   *
   * The reply used to name three and count the rest — 「・ほか5件」 — because
   * eight bullets under the description buried what the person had asked for.
   * The chat now folds this block away under its count (formatReply's
   * `findings`), so the length that justified the cap is no longer on screen,
   * and a fold that opens onto 「ほか5件」 would be a fold with nothing in it.
   *
   * The heading line is the frontend's anchor and is pinned by
   * frontend/test/format-reply.test.mjs: change its wording and that test fails
   * rather than the findings silently unfolding into the reply.
   */
  /*
   * The critic's opinions the run does not repair, apart from the findings it
   * does.
   *
   * Five kinds of design critique are never handed to a repair pass, on
   * measurement (see repair-yield.ts): spacing, alignment and hierarchy are
   * still there at the end of 74–95% of the runs that repaired them, and the
   * critic raises accent and artefact again on the SAME screenshot only 38%
   * and 24% of the time. Listed as 未解決の指摘 they came with a fix button
   * each, and over thirty days they were about 1.5 of the 5.85 findings the
   * average run shipped with — findings the pipeline had already decided it
   * could not act on. They are still shown, under a heading that says what
   * they are. The score is unchanged.
   */
  const all = out.defects ?? [];
  const opinions = all.filter((d) => isCriticFinding(d.id) && !repairable(d.id));
  const open = all.filter((d) => !opinions.includes(d));
  if (open.length > 0) {
    lines.push(`未解決の指摘が${open.length}件あります。`);
    lines.push(...open.map((d) => `・${d.note}`));
  }
  if (opinions.length > 0) {
    lines.push(`デザインについての参考意見が${opinions.length}件あります（自動修正の対象外）。`);
    lines.push(...opinions.map((d) => `・${d.note}`));
  }

  return lines.join('\n');
}

/**
 * The model's account of the run, then the run's own.
 *
 * Two blocks rather than one sentence: the first is what the model chose to say
 * about the design, which the version history's comment calls the part worth
 * reading, and the second is what was measured. Neither can replace the other —
 * a fact list has no design reasoning in it, and the prose has been wrong about
 * what shipped every time a repair was rejected.
 */
export function replyWithOutcome(raw: string | undefined, fallback: string, out: RunOutcome): string {
  const full = replyText(raw, fallback);
  /*
   * The fallback, not the whole preamble.
   *
   * `|| full` put 1,597 characters of Step 0 worksheet back when nothing in it
   * qualified as a description. The outcome block below carries the substance
   * either way, so 「UIを生成しました。」 over facts is a better answer than a
   * design worksheet over the same facts.
   */
  const prose = conciseDescription(full) || fallback;
  const facts = describeOutcome(out);
  return facts ? `${prose}\n\n${facts}` : prose;
}

/**
 * The scaffolding the model was asked to write for itself.
 *
 * The build prompt says 「state your Step 0 choices to yourself (domain, single
 * accent, neutral ramp, type pairing, radius/density)」 — our words, our label —
 * and the model obliges with a heading reading 「**Step 0 — 設計委譲前の確認**」.
 * 設計委譲前の確認 is a note to itself about a handover the reader is not part
 * of, sitting above a list of decisions the reader may well want.
 *
 * So the label goes and the list stays. Stripping the block would remove the
 * accent colour, the neutral ramp and the type scale, which are the most
 * concrete things in the whole reply.
 *
 * The trailing rule goes with it. `---` is where the model drew a line before
 * starting the document; the document is extracted out, and what is left is a
 * horizontal rule with nothing under it.
 *
 * What is deliberately NOT touched is the closing 「これから…生成します」. It is
 * future tense about a run that has finished, which reads oddly — but the
 * sentence usually carries design content too (「5画面をすべてナビから到達可能に
 * し、予約確定でカレンダーに即時反映されるよう共有ステートで管理します」), and a
 * rule that removed it would remove that. The tense is a prompt question, not a
 * text-surgery one, and `describeOutcome` now follows it with what actually
 * happened.
 */
export function stripSelfAddressedScaffolding(text: string): string {
  return text
    // The label alone, on its own line, with or without emphasis around it.
    .replace(/^[ \t]*\**\s*Step\s*0\b[^\n]*\n+/gim, '')
    // A rule with nothing after it — the boundary the document used to be on.
    .replace(/\n+\s*(?:-{3,}|\*{3,}|_{3,})\s*$/, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The description, and only the description.
 *
 * The preamble is everything the model wrote before the document, and it is not
 * all one thing. Measured on the stored replies, the shape is: a sentence or two
 * naming the product and the design direction, then — when the build prompt's
 * 「state your Step 0 choices」 lands — a worksheet of accent, neutrals, type
 * scale, radius and motion. 609 characters where the first 109 answered the
 * question.
 *
 * The worksheet is real content and this is where it stops being shown. It
 * belongs to the design decisions, not to 「何を作ったか」, and the outcome block
 * below it already carries what came out. What is left is the paragraph that
 * describes the UI.
 *
 * A leading acknowledgement goes with it. One reply in four opens
 * 「緻密な設計を確認しました。」 — an answer to the design phase, not to the reader
 * — and the pattern is narrow on purpose: it must not eat 「さくら歯科クリニックの
 * 予約システムを構築します。」, which is the description itself in the same shape.
 */
const ACKNOWLEDGEMENT = /^[^。]{0,24}(?:確認しました|了解しました|承知しました|わかりました|了解です)。/;

/**
 * An opening paragraph that promises the answer instead of being it.
 *
 * 「まず、私の仕様理解と設計方針を確認します。」 is a whole paragraph on its own,
 * and the description arrives three paragraphs later. `conciseDescription` took
 * the first paragraph, found nothing but this after stripping, fell back to it,
 * and the reader was told what the model was about to do rather than what it
 * did — measured on a stored reply of 1,597 characters that came out as those
 * twenty-one.
 *
 * Deliberately narrower than ACKNOWLEDGEMENT above: this one matches the whole
 * paragraph, not a leading clause, because 「〜します。」 is also how a real
 * description opens (「予約システムを構築します。」). What makes these skippable
 * is that the sentence's object is the model's own process — the specification,
 * the approach, the plan — and not the product.
 */
const PREAMBLE_ONLY = /^[^。]{0,40}(?:仕様|設計方針|要件|方針|前提)[^。]{0,30}(?:確認|整理|検討|把握)します。$/;

/** At most this many sentences. Past three it is no longer a summary. */
const DESCRIPTION_SENTENCES = 3;

export function conciseDescription(text: string): string {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

  /*
   * The first paragraph that describes something, rather than the first
   * paragraph. A worksheet of hex codes is skipped the same way an
   * announcement is: neither answers 「何を作ったか」, and both are followed by
   * one that does.
   */
  const first = paragraphs.find((p) => isProse(p) && !PREAMBLE_ONLY.test(p) && !isWorksheet(p)) ?? '';
  if (!first) return '';

  const withoutOpener = first.replace(ACKNOWLEDGEMENT, '').trim();
  // Only if something is left: a reply that is nothing but an acknowledgement
  // still has to say something.
  const body = withoutOpener || first;

  const sentences = body.split(/(?<=。)/).map((t) => t.trim()).filter(Boolean);
  return sentences.slice(0, DESCRIPTION_SENTENCES).join('');
}

/**
 * A paragraph that is a list of decisions rather than prose.
 *
 * The Step 0 worksheet survives its heading being stripped, and what is left is
 * bullets of hex codes and pixel values. Recognised by shape — mostly lines
 * starting with a bullet or a bold label — because its wording changes with
 * every run and its shape does not.
 */
/**
 * A paragraph that could be shown to somebody.
 *
 * Three things are not: a markdown heading, a horizontal rule — the line the
 * model drew before starting the document, which is what the old rule returned
 * for one stored reply — and a one-line transition. 「それでは、本体を構築しま
 * す。」 is fourteen characters and says nothing; 「さくら歯科クリニックの予約シス
 * テムを構築します。」 is twenty-four and is the description itself, so the cut
 * is at twenty with the two cases either side of it.
 */
function isProse(paragraph: string): boolean {
  if (/^#{1,6}\s/.test(paragraph)) return false;
  if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(paragraph.trim())) return false;
  return paragraph.includes('。') && paragraph.replace(/\s+/g, '').length >= 20;
}

function isWorksheet(paragraph: string): boolean {
  const lines = paragraph.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 3) return false;
  const listy = lines.filter((l) => /^([-*•]|\d+\.|\*\*|[①-⑨])/.test(l)).length;
  return listy >= lines.length * 0.6;
}
