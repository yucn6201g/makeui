import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { createBedrockClient } from '../config/bedrock-client.js';
import { getModelConfig } from '../config/agentcore-config.js';
import { firstJsonObject } from '../utils/model-json.js';
import { logger } from '../utils/logger.js';
import { recordTokens, recordUnreportedCall } from '../services/token-ledger.js';
import { reactFiles, declaredScreenIds, type InteractionDefect } from './interaction-audit.js';
import { unreachableControls } from '../tools/keyboard-reach.js';
import type { OutputKind } from '../config/frameworks.js';

/**
 * What the user asked for, as a list the finished project can be checked against.
 *
 * Nothing in the pipeline looked at the request after the build. The audits
 * check a fixed rubric — icons, contrast, dead buttons — that is the same for
 * every product, and the repair loop spends 40% of a generation's cost chasing
 * it. A requirement the user stated and the build dropped was invisible to both:
 * on the verification run 「満席」 and the cancellation deadline landed and arrow-
 * key navigation did not, and nothing reported the difference. On the edit path
 * it was worse: `describeEditOutcome` counts a file as applied when it was
 * WRITTEN, so an instruction whose change never appeared was reported as done.
 *
 * ## Extracted by a model, checked by grep
 *
 * The extraction is a Haiku call, not a parser, because the requests are prose.
 * A structured brief can be read with regular expressions and a sentence cannot —
 * and even the structured ones defeat them: the templates contain 「革新的」「シー
 * ムレス」のような語は使わない, where the quotes are the words to AVOID, and
 * 「次へ」だけにしない, where the quote is insufficient rather than required. A
 * model reads negation; a pattern reads quotation marks.
 *
 * The checking is not a model call. Each requirement comes back with a kind that
 * says how it can be verified mechanically — a string that must appear, a string
 * that must not, a key the source must handle, a screen that must exist — and
 * everything that cannot be verified that way is marked `behaviour` and reported
 * as unverified rather than guessed at. A requirement is never called met because
 * a model said so.
 *
 * ## Fail open
 *
 * Every failure returns an empty list, and an empty list changes nothing: no
 * block in the build prompt, no defects, no line in the reply. This must never
 * be the reason a generation fails.
 */

/** How a requirement can be verified against the project's source. */
export type RequirementCheck =
  /**
   * A string the UI must show, verbatim — and, when the request said where,
   * there: `shared` for the chrome every screen shares (header, footer, sidebar),
   * or a screen's name.
   *
   * Presence alone was measured passing the wrong edit. Asked for 「フッターに
   * 『開館時間 9:00〜19:00』と表示」 alongside a change to the 貸出登録 screen, the
   * edit put the hours inside that one screen, the string was in the source, and
   * the check reported the instruction as landed.
   */
  | { kind: 'text'; value: string; where?: string }
  /** A string the UI must not contain. */
  | { kind: 'absent'; value: string }
  /** Keyboard handling: at least one of these `KeyboardEvent.key` values. */
  | { kind: 'key'; keys: string[] }
  /** A screen that must exist. Reported, never repaired — see `requirementDefects`. */
  | { kind: 'screen'; name: string }
  /** Anything else. Reported as unverified. */
  | { kind: 'behaviour' };

export interface Requirement {
  /** The requirement in the user's terms, one sentence. */
  text: string;
  check: RequirementCheck;
}

export type RequirementStatus = 'met' | 'unmet' | 'unverified';

export interface RequirementResult {
  requirement: Requirement;
  status: RequirementStatus;
  /**
   * For `absent`: the files still containing the string. For a `text` with a
   * place: the files the repair should change — see `requirementDefects`.
   */
  paths?: string[];
  /**
   * Why a placed `text` is unmet: nowhere at all, or somewhere other than where
   * the request put it. Only ever `misplaced` when the place could be resolved
   * to files; an unresolvable place is checked as presence, never guessed.
   */
  reason?: 'missing' | 'misplaced';
}

/** Where every screen is mounted, and what a place-less shared element lives in. */
const APP_FILE = /^src\/App\.(tsx|jsx|vue)$/;
const SCREEN_FILE = /^src\/(screens|pages|views)\/[\w-]+\.(tsx|jsx|vue)$/;
/** The value of `where` that means "on every screen" rather than a screen's name. */
export const SHARED = 'shared';

/** More than this and the list stops being a checklist and becomes a restatement. */
const MAX_REQUIREMENTS = 12;

/** A request longer than this is a specification; the head says what it asks. */
const MAX_INPUT_CHARS = 4000;

/**
 * Below this a string matches everything. 「×」 is a real requirement — 「埋まっ
 * ている枠は×で示す」 — and a useless search, so it goes to `behaviour`.
 */
const MIN_VALUE = 2;
const MAX_VALUE = 40;

/**
 * The key names a check may use. Anything else the model returns is dropped
 * rather than searched for: `"left arrow"` would never match and would read as
 * an unmet requirement the build had in fact satisfied.
 */
const KNOWN_KEYS = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'Enter', 'Escape', 'Tab', ' ', 'Home', 'End', 'PageUp', 'PageDown', 'Delete', 'Backspace',
]);
/**
 * And the letter of a shortcut — `k` for Ctrl+K.
 *
 * Not in the list above, so the verification run's 「Ctrl+K で検索欄にフォーカス」
 * was dropped to behaviour and reported as uncheckable, though the build had
 * written `e.key === 'k'`. One letter or digit, lower-cased: `KeyboardEvent.key`
 * is `k` with Ctrl held and `K` with Shift, and the check accepts either.
 */
const LETTER_KEY = /^[a-z0-9]$/i;

const SYSTEM = `あなたはUI生成サービスの要件抽出係です。
ユーザーの依頼文から要件を抜き出し、それぞれについて「生成されたUIのソースコードを機械的に検査して確かめられるか」を判定します。

出力は次のJSONだけ。前後に文章を書かない。
{"requirements":[{"text":"要件を一文で","check":{...}}]}

check は次のどれか一つ:
- {"kind":"text","value":"語"}
  画面に、その語が**そのままの文字列で**表示されることを依頼が求めている。
  例: 「埋まっている枠は満席と表示する」 → {"kind":"text","value":"満席"}
  例: 「ボタンのラベルを『予約を確定』にして」 → {"kind":"text","value":"予約を確定"}
  依頼が**表示する場所**を書いているときだけ "where" を足す。書いていなければ付けない。
  ヘッダー・フッター・サイドバーなど全画面に共通する場所 → "where":"shared"
  画面の名前を挙げている → "where":"その画面名"
  例: 「フッターに『開館時間 9:00〜19:00』と表示」 → {"kind":"text","value":"開館時間 9:00〜19:00","where":"shared"}
  例: 「貸出登録画面のボタンを『貸出を確定する』に」 → {"kind":"text","value":"貸出を確定する","where":"貸出登録"}
- {"kind":"absent","value":"語"}
  画面にその語を**出してはいけない**、または**消してほしい**と依頼が求めている。
  例: 「"革新的"のような空疎な語は使わない」 → {"kind":"absent","value":"革新的"}
  例: 「"I need to create"という文言を消して」 → {"kind":"absent","value":"I need to create"}
- {"kind":"key","keys":["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"]}
  キーボード操作。keys には KeyboardEvent.key の値だけを入れる
  （ArrowLeft ArrowRight ArrowUp ArrowDown Enter Escape Tab Home End PageUp PageDown Delete Backspace、スペースは " "）。
  例: 「矢印キーで日付を移動できる」 → ["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"]
  例: 「Escで閉じる」 → ["Escape"]
  Ctrl+K や ⌘K のような修飾キー付きのショートカットは、文字キーだけを小文字1文字で入れる。
  例: 「Ctrl+K で検索欄にフォーカス」 → ["k"]
- {"kind":"screen","name":"画面名"}
  依頼が**画面の名前を挙げて**その画面を求めている。プロダクト名やシステム全体の名前は screen にしない。
- {"kind":"behaviour"}
  上のどれでも確かめられない要件。振る舞い、条件、計算、見た目、配置、件数など。

規則:
- 依頼に**書かれていること**だけ。推測で足さない。一般的なUIの良し悪しは含めない。
- text と absent の value は、ユーザーが**その文字列そのもの**について述べているときだけ。
  「一覧」「ボタン」のような一般名詞、「利用率がどう計算されるか」のような概念、
  「完了したことが分かるように」のような言い換え可能な指示は behaviour にする。
- 否定に注意する。「〜は使わない」「〜だけにしない」「〜ではなく」は、その語を必須にしない。
  「〜だけにしない」は behaviour。
- 1文字の語（「×」など）は text にしない。behaviour にする。
- 重複させない。最大12件。確かめられるもの（text・absent・key）を先に、screen を最後に並べる。`;

/**
 * The model's reply, cleaned into requirements that can be trusted to mean what
 * their kind says.
 *
 * Exported for the test, which is the reason it is a separate step: every rule
 * about what a model may return is here, and none of them needs a model to check.
 */
export function parseRequirements(raw: string): Requirement[] {
  const parsed = firstJsonObject<{ requirements?: unknown }>(raw);
  const list = Array.isArray(parsed?.requirements) ? parsed.requirements : [];
  const out: Requirement[] = [];
  const seen = new Set<string>();

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const text = String((item as { text?: unknown }).text ?? '').trim().slice(0, 200);
    const c = (item as { check?: unknown }).check as Record<string, unknown> | undefined;
    if (!text || !c || typeof c !== 'object') continue;

    let check: RequirementCheck | null = null;
    if (c.kind === 'text' || c.kind === 'absent') {
      // Quotation marks the model left on are not part of what is searched for.
      const value = String(c.value ?? '').trim().replace(/^[「『"'`]+|[」』"'`]+$/g, '');
      // A place is kept only on text, and only when it is short enough to be one.
      const where = c.kind === 'text' && typeof c.where === 'string' ? c.where.trim() : '';
      check = value.length < MIN_VALUE || value.length > MAX_VALUE
        // Too short to search for, or too long to be a label: still a
        // requirement, just not one grep can settle.
        ? { kind: 'behaviour' }
        : c.kind === 'text' && where && where.length <= MAX_VALUE
          ? { kind: 'text', value, where }
          : { kind: c.kind, value };
    } else if (c.kind === 'key') {
      const keys = (Array.isArray(c.keys) ? c.keys : [])
        .map(String)
        .map((k) => (LETTER_KEY.test(k) ? k.toLowerCase() : k))
        .filter((k) => KNOWN_KEYS.has(k) || LETTER_KEY.test(k));
      check = keys.length > 0 ? { kind: 'key', keys: [...new Set(keys)] } : { kind: 'behaviour' };
    } else if (c.kind === 'screen') {
      const name = String(c.name ?? '').trim();
      check = name.length >= 1 && name.length <= MAX_VALUE ? { kind: 'screen', name } : { kind: 'behaviour' };
    } else if (c.kind === 'behaviour') {
      check = { kind: 'behaviour' };
    }
    if (!check) continue;

    const key = check.kind === 'behaviour' ? `behaviour:${text}`
      : check.kind === 'key' ? `key:${check.keys.join(',')}`
        : check.kind === 'screen' ? `screen:${check.name}`
          : `${check.kind}:${check.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, check });
    if (out.length >= MAX_REQUIREMENTS) break;
  }
  return out;
}

/**
 * One Haiku call: the request, as a checklist.
 *
 * Always Haiku, for the refiner's reason — it runs on every generation and every
 * edit, and a check that costs a meaningful fraction of what it checks is not
 * worth having. Measured on the refiner's comparable call: about six tenths of a
 * cent against a generation of about sixty.
 *
 * Recorded against the run's ledger, like the router's classify call, which is
 * the precedent for a fixed-Haiku call inside a run.
 */
export async function extractRequirements(request: string): Promise<Requirement[]> {
  const text = request.trim();
  if (!text) return [];
  try {
    const config = await getModelConfig();
    const response = await createBedrockClient().send(new InvokeModelCommand({
      modelId: config.haikuId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 1500,
        system: SYSTEM,
        messages: [{ role: 'user', content: `依頼文:\n${text.slice(0, MAX_INPUT_CHARS)}` }],
      }),
    }));
    const body = JSON.parse(new TextDecoder().decode(response.body));
    recordTokens(body.usage?.input_tokens ?? 0, body.usage?.output_tokens ?? 0, 'requirements:extract');
    const requirements = parseRequirements(body.content?.[0]?.text ?? '');
    logger.info('Requirements extracted', {
      total: requirements.length,
      byKind: countByKind(requirements),
    });
    return requirements;
  } catch (e) {
    // A call that threw may still have spent its input; counted, never billed as zero.
    recordUnreportedCall('requirements:extract');
    logger.warn('Requirement extraction failed; continuing without a checklist', { error: String(e) });
    return [];
  }
}

function countByKind(requirements: Requirement[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of requirements) out[r.check.kind] = (out[r.check.kind] ?? 0) + 1;
  return out;
}

/**
 * The project's source, without the files that only describe it.
 *
 * SPECIFICATION.md and docs/ are excluded, and this is the whole of the
 * difference between checking a requirement and checking that it was repeated:
 * the build restates the brief in its specification, so 「満席」 appears there
 * whether or not a single screen shows it.
 */
function uiSources(html: string): [string, string][] {
  const files = [...reactFiles(html)].filter(([path]) => !/\.md$/i.test(path) && !path.startsWith('docs/'));
  // A single-document project has no transported files; the document is the UI.
  return files.length > 0 ? files : [['index.html', html]];
}

/** ASCII values compare case-insensitively; a Japanese label has no case to ignore. */
function contains(body: string, value: string): boolean {
  return /^[\x20-\x7e]+$/.test(value) ? body.toLowerCase().includes(value.toLowerCase()) : body.includes(value);
}

/**
 * Tab is not a key an application handles — it is one it must not.
 *
 * 「商品カードはTabキーで辿れる」 was checked by looking for the string `'Tab'` in
 * an onKeyDown, found none, and reported the requirement unmet. The build had in
 * fact done nothing wrong by not writing one: Tab traversal is a property of the
 * DOM, provided by using a focusable element or by putting a `tabindex` on one
 * that is not. Code that branches on `e.key === 'Tab'` is code that has taken
 * the browser's focus order away from the user, which is the opposite of what
 * the requirement asks for — and it is what the instruction this check produced
 * told the build and the repair pass to write, in those words.
 *
 * So Tab is checked as what it is: whether every element that responds to a
 * click can be reached without a mouse. `tools/keyboard-reach.ts` decides that,
 * and the same module supplies the deterministic repair, so a requirement that
 * used to cost a model call now usually never appears.
 *
 * The two shapes it deliberately allows — a modal backdrop and a panel that only
 * stops the backdrop's handler — are documented there.
 */
function tabTraversable(files: [string, string][]): boolean {
  for (const [path, body] of files) {
    const kind: OutputKind | null = /\.vue$/.test(path)
      ? 'vue'
      : /\.(tsx|jsx)$/.test(path) || /\.html?$/.test(path)
        ? 'react'
        : null;
    if (!kind) continue;
    const source = kind === 'vue' ? (/<template>([\s\S]*)<\/template>/.exec(body)?.[1] ?? '') : body;
    if (unreachableControls(source, kind).length > 0) return false;
  }
  return true;
}

/**
 * A key name as the code would compare it — quoted — so `Enter` does not match
 * `onMouseEnter` and `Escape` does not match a comment about escaping HTML.
 */
function handlesKey(body: string, key: string): boolean {
  if (key === ' ') return /(['"`]) \1|['"`]Space(?:bar)?['"`]/.test(body);
  // A letter either case, or its `code` spelling — `'k'`, `'K'`, `'KeyK'`.
  if (LETTER_KEY.test(key)) {
    const code = /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : `Digit${key}`;
    return new RegExp(`['"\`](?:${key}|${code})['"\`]`, 'i').test(body);
  }
  return new RegExp(`['"\`]${key}['"\`]`).test(body);
}

/**
 * The screen file a screen's name refers to, from the project's own NAV_ITEMS.
 *
 * `{ id: 'checkout', label: '貸出登録' }` names the screen the user calls 貸出登録,
 * and `src/screens/CheckoutScreen.tsx` is the file that renders `checkout`. When
 * either half is missing the answer is undefined and the caller checks presence
 * only — a place that cannot be resolved is not evidence of a misplacement.
 */
function screenFileFor(files: [string, string][], name: string): string | undefined {
  const core = name.replace(/(画面|ページ)$/, '');
  const routes = files.find(([p]) => /(?:^|\/)(routes|types-nav)\.tsx?$/.test(p))?.[1] ?? '';
  const nav = /\bNAV_ITEMS\b[^=]*=\s*\[([\s\S]*?)\n?\s*\]/.exec(routes)?.[1] ?? '';
  for (const item of nav.matchAll(/\{([^{}]*)\}/g)) {
    const id = /\bid\s*:\s*['"`]([\w-]+)['"`]/.exec(item[1])?.[1];
    const label = /\blabel\s*:\s*['"`]([^'"`]+)['"`]/.exec(item[1])?.[1]?.trim();
    if (!id || !label || (label !== name && label !== core && label.replace(/(画面|ページ)$/, '') !== core)) continue;
    const want = id.replace(/[-_]/g, '').toLowerCase();
    return files
      .map(([p]) => p)
      .find((p) => SCREEN_FILE.test(p) &&
        p.slice(p.lastIndexOf('/') + 1).replace(/\.\w+$/, '').replace(/(Screen|Page|View)$/, '').toLowerCase() === want);
  }
  return undefined;
}

/**
 * A `text` requirement that says where.
 *
 * A FLOOR, like every check here: it reports `misplaced` only when the string is
 * confined to screens the request did not name. A string in any file that is
 * not a screen — the App shell, a Footer component, a constants module — is
 * accepted wherever it is, because a screen may render a component and nothing
 * here follows imports. The failure it exists for is the measured one, and that
 * one is unambiguous: the text written into a single screen's own file.
 */
function checkPlacedText(files: [string, string][], requirement: Requirement, value: string, where: string): RequirementResult {
  const holders = files.filter(([, b]) => contains(b, value)).map(([p]) => p);
  const screens = files.map(([p]) => p).filter((p) => SCREEN_FILE.test(p));
  const app = files.map(([p]) => p).find((p) => APP_FILE.test(p));

  if (where === SHARED) {
    if (!app || screens.length === 0) return { requirement, status: holders.length > 0 ? 'met' : 'unmet' };
    if (holders.length === 0) return { requirement, status: 'unmet', reason: 'missing', paths: [app] };
    if (holders.some((p) => !SCREEN_FILE.test(p))) return { requirement, status: 'met' };
    if (screens.every((p) => holders.includes(p))) return { requirement, status: 'met' };
    return { requirement, status: 'unmet', reason: 'misplaced', paths: [app, ...holders] };
  }

  const target = screenFileFor(files, where);
  if (!target) return { requirement, status: holders.length > 0 ? 'met' : 'unmet' };
  if (holders.length === 0) return { requirement, status: 'unmet', reason: 'missing', paths: [target] };
  if (holders.includes(target) || holders.some((p) => !SCREEN_FILE.test(p))) return { requirement, status: 'met' };
  return { requirement, status: 'unmet', reason: 'misplaced', paths: [target] };
}

export function checkRequirements(html: string, requirements: Requirement[]): RequirementResult[] {
  if (requirements.length === 0) return [];
  const files = uiSources(html);
  return screensByCount(html, requirements.map((requirement): RequirementResult => {
    const c = requirement.check;
    switch (c.kind) {
      case 'text':
        if (c.where) return checkPlacedText(files, requirement, c.value, c.where);
        return { requirement, status: files.some(([, b]) => contains(b, c.value)) ? 'met' : 'unmet' };
      case 'absent': {
        const paths = files.filter(([, b]) => contains(b, c.value)).map(([p]) => p);
        return paths.length === 0 ? { requirement, status: 'met' } : { requirement, status: 'unmet', paths };
      }
      case 'key': {
        // At least one: the failure this exists for was no arrow handling at all,
        // and a grid that moves left and right but not up is a design choice.
        // Tab is asked of the DOM rather than of the source — see `tabTraversable`.
        const handled = c.keys.some((k) => k !== 'Tab' && files.some(([, b]) => handlesKey(b, k)));
        const tabbed = c.keys.includes('Tab') && tabTraversable(files);
        return { requirement, status: handled || tabbed ? 'met' : 'unmet' };
      }
      case 'screen': {
        const core = c.name.replace(/(画面|ページ)$/, '');
        return { requirement, status: files.some(([, b]) => b.includes(c.name) || (core.length >= 2 && b.includes(core))) ? 'met' : 'unmet' };
      }
      default:
        return { requirement, status: 'unverified' };
    }
  }));
}

/**
 * A screen not found by its name, when the project has room for it under another.
 *
 * The name check reads the source for 「商品詳細」, and a screen built as
 * `product-detail` with a heading of 「商品情報」 does not contain it. Measured on
 * the inventory generation of 2026-09-13: three screens asked for, three built
 * and reachable (`inventory-list`, `product-detail`, `transaction-register`),
 * and the reply said 「画面「商品詳細」「入出庫登録」は見つかりませんでした」 —
 * a claim that two screens were missing from a project that had all three.
 *
 * Which Japanese name an English route id stands for is not something grep can
 * settle, so the claim is withdrawn rather than guessed: when the project
 * declares at least as many screens beyond the ones found by name as there are
 * names not found, those names are unverified. When it declares fewer, at least
 * some really are missing, and all of the unfound stay unmet — which ones is
 * again not something the source can say.
 */
function screensByCount(html: string, results: RequirementResult[]): RequirementResult[] {
  const screens = results.filter((r) => r.requirement.check.kind === 'screen');
  const unfound = screens.filter((r) => r.status === 'unmet');
  if (unfound.length === 0) return results;
  const declared = declaredScreenIds(html).length;
  const foundByName = screens.length - unfound.length;
  if (declared - foundByName < unfound.length) return results;
  return results.map((r) => (unfound.includes(r) ? { requirement: r.requirement, status: 'unverified' as const } : r));
}

/**
 * The unmet requirements a repair pass can act on.
 *
 * `screen` is deliberately not one of them. A screen checked by name can be built
 * under another — 「予約内容の入力」 as 「予約入力」 — and a false "missing"
 * handed to a repair pass is an instruction to build a duplicate screen. Screens
 * already land 79 times in 80 when a brief names them; they are reported, and
 * the repair loop keeps its hands off.
 */
export function requirementDefects(results: RequirementResult[]): InteractionDefect[] {
  const out: InteractionDefect[] = [];
  for (const r of results) {
    if (r.status !== 'unmet') continue;
    const c = r.requirement.check;
    const note = `依頼された要件が反映されていません: ${r.requirement.text}`;
    if (c.kind === 'text' && r.reason === 'misplaced') {
      const [target, ...confined] = r.paths ?? [];
      out.push({
        id: 'requirement-unmet',
        note,
        instruction: c.where === SHARED
          ? `依頼では「${c.value}」を全画面に共通する場所（ヘッダー・フッターなど）に表示することが求められていますが、` +
            `次の画面のファイルにしかありません: ${confined.join(', ')}（要件: ${r.requirement.text}）。` +
            `${target} の共通レイアウトに一度だけ置き、各画面に個別に書いた同じ表示は取り除いてください。` +
            '言い換えず、この文字列のまま表示してください。'
          : `依頼では「${c.value}」を「${c.where}」画面に表示することが求められていますが、その画面（${target}）にはありません` +
            `（要件: ${r.requirement.text}）。${target} に表示してください。言い換えず、この文字列のまま表示してください。`,
        // Resolved from the project's own structure, so the planner is skipped.
        paths: r.paths,
      });
    } else if (c.kind === 'text') {
      const place = c.where === SHARED
        ? '全画面に共通する場所（ヘッダー・フッターなど）'
        : c.where ? `「${c.where}」画面` : 'この要件が当てはまる画面';
      out.push({
        id: 'requirement-unmet',
        note,
        instruction:
          `依頼では「${c.value}」を画面にそのまま表示することが求められていますが、ソースのどこにもありません` +
          `（要件: ${r.requirement.text}）。${place}に実装してください。` +
          '言い換えず、この文字列のまま表示してください。',
        ...(r.paths?.length ? { paths: r.paths } : {}),
      });
    } else if (c.kind === 'absent') {
      out.push({
        id: 'requirement-unmet',
        note,
        instruction:
          `依頼では「${c.value}」を画面に出さないことが求められていますが、次のファイルに残っています` +
          `（要件: ${r.requirement.text}）。取り除くか、要件に沿った表現に置き換えてください。`,
        // Located, so the planner is skipped: which file contains a string is not
        // a judgement.
        paths: r.paths,
      });
    } else if (c.kind === 'key') {
      // Tab has its own instruction, because writing a Tab handler is the
      // defect — see `tabTraversable`.
      const others = c.keys.filter((k) => k !== 'Tab');
      out.push({
        id: 'requirement-unmet',
        note,
        instruction: others.length === 0
          ? 'クリックで反応する要素の一部が、キーボードで辿れません' +
            `（要件: ${r.requirement.text}）。` +
            'div や tr にクリック処理を書いている箇所に tabindex="0" を付け、' +
            'Enter と Space で同じ動作をする onKeyDown を足してください。' +
            '**Tab キー自体を処理しないでください** — Tab の移動はブラウザの仕事で、' +
            '横取りすると要件と逆の結果になります。'
          : `依頼ではキーボード操作（${others.map((k) => (k === ' ' ? 'Space' : k)).join('・')}）が求められていますが、` +
            `ソースにそのキーを処理するコードがありません（要件: ${r.requirement.text}）。` +
            '該当するウィジェットのコンテナに onKeyDown を付け、e.key で分岐して実装してください。',
      });
    }
  }
  return out;
}

/**
 * The checkable requirements, stated to the build before it writes anything.
 *
 * Prevention rather than repair: a requirement the build is told will be checked
 * is cheaper to honour on the first pass than to repair across thirteen files on
 * the second. Only the mechanically checkable ones — the behaviour requirements
 * are already in the request the build receives verbatim, and restating them
 * here would only lengthen the prompt.
 */
export function requirementsBlock(requirements: Requirement[]): string {
  const lines = checkableLines(requirements, 'build');
  if (lines.length === 0) return '';
  return `\n\nREQUIREMENTS THE USER STATED — each of these is checked mechanically against your source code after the build, and a miss is sent back for repair:\n${lines.join('\n')}`;
}

/**
 * The same checklist, stated to the design phase.
 *
 * The build was the first thing told, and the build is told to follow the
 * specification closely — so a requirement the specialists never heard of had
 * to survive a specification written without it, and then win against that
 * specification in the build's prompt. The extraction runs concurrently with
 * the design phase for wall-clock reasons, which meant the phase that decides
 * the screens, the copy and the controls was the one phase that could not see
 * the list. It now waits the few seconds the Haiku call takes.
 *
 * Screens are stated here too, by the name the user used: a screen designed as
 * 「商品詳細」 is built as 「商品詳細」, and a screen built under another name is
 * the one the checker cannot find.
 */
export function designRequirementsBlock(requirements: Requirement[]): string {
  const lines = checkableLines(requirements, 'design');
  if (lines.length === 0) return '';
  return `\n\nREQUIREMENTS THE USER STATED — the finished project is checked against each of these mechanically. The specification must carry every one: the exact strings in the content and copy, in the place named; the keys on the control that handles them; each named screen under that exact name.\n${lines.join('\n')}`;
}

function checkableLines(requirements: Requirement[], audience: 'build' | 'design'): string[] {
  const lines: string[] = [];
  for (const r of requirements) {
    const c = r.check;
    if (c.kind === 'text') {
      const place = c.where === SHARED
        ? audience === 'build'
          ? ' in the layout every screen shares (App), not inside one screen'
          : ' in the chrome every screen shares (header, footer or sidebar), not inside one screen'
        : c.where ? ` on the 「${c.where}」 screen` : '';
      lines.push(`- Show the text 「${c.value}」 verbatim${place}. (${r.text})`);
    }
    else if (c.kind === 'absent') lines.push(`- Never show the text 「${c.value}」. (${r.text})`);
    else if (c.kind === 'key') {
      // Tab is stated as what is checked: focus order, not a handler. Telling a
      // build to "handle Tab in onKeyDown" is telling it to break Tab.
      const others = c.keys.filter((k) => k !== 'Tab');
      if (c.keys.includes('Tab')) {
        lines.push(audience === 'build'
          ? `- Make every element that responds to a click reachable by Tab: use a button or an anchor, or put tabindex="0" and an Enter/Space onKeyDown on it. Do NOT handle the Tab key itself. (${r.text})`
          : `- Say which elements the keyboard reaches in order, and what Enter does on each. (${r.text})`);
      }
      if (others.length > 0) {
        const keys = others.map((k) => (k === ' ' ? 'Space' : k)).join(', ');
        lines.push(audience === 'build'
          ? `- Handle the key(s) ${keys} in onKeyDown. (${r.text})`
          : `- Name the control that handles the key(s) ${keys}, and what each key does. (${r.text})`);
      }
    }
    /*
     * A screen, by the user's name for it. The checker finds a screen by that
     * name in the source; told nothing, the build titled 「商品詳細」 as 「商品情報」
     * and the reply said the screen was missing from a project that had it.
     */
    else if (c.kind === 'screen') {
      lines.push(audience === 'build'
        ? `- Provide the screen 「${c.name}」, with that exact name as its heading and as its NAV_ITEMS label. (${r.text})`
        : `- Design the screen 「${c.name}」 under that exact name. (${r.text})`);
    }
  }
  return lines;
}

/** Counts for the reply and the log. */
export function summarizeRequirements(results: RequirementResult[]): {
  total: number; met: number; unmet: number; unverified: number; unmetScreens: string[];
} {
  return {
    total: results.length,
    met: results.filter((r) => r.status === 'met').length,
    unmet: results.filter((r) => r.status === 'unmet').length,
    unverified: results.filter((r) => r.status === 'unverified').length,
    unmetScreens: results
      .filter((r) => r.status === 'unmet' && r.requirement.check.kind === 'screen')
      .map((r) => (r.requirement.check as { name: string }).name),
  };
}
