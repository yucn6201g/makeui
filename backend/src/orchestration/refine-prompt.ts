import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { createBedrockClient } from '../config/bedrock-client.js';
import { getModelConfig } from '../config/agentcore-config.js';
import { firstJsonObject } from '../utils/model-json.js';
import { logger } from '../utils/logger.js';

/**
 * Rewrites a brief into one the build can act on, and says what it added.
 *
 * The pipeline's output tracks the brief closely, which is what makes a thin
 * brief expensive: 「予約システム作って」 leaves the model to invent the screens,
 * the fields, the states and the data, and the repair loop then spends passes
 * on the parts it guessed badly. The cheapest place to fix that is before the
 * generation starts.
 *
 * ## What it asks for, and why those six
 *
 * The list in SYSTEM is not a wish list. Each entry is something the build has
 * to decide, decides badly without being told, and cannot be corrected for
 * afterwards by a repair pass:
 *
 *   - five screens or more, and which reaches which, because a single-screen
 *     brief leaves the router, the store and the list-to-detail route with
 *     nothing to do — and those are most of what an application is
 *   - the cross-screen consequence of an action, which is the difference
 *     between a store and five screens holding their own copies
 *   - the empty, in-flight and failed states, which are otherwise never
 *     generated: a brief describes a screen with data in it, so that is the
 *     only state that gets built, and it is not the state a user meets first
 *   - the volume and range of the data, because "商品一覧" produces twelve
 *     identical invented rows and "12点、3,000円〜28,000円" does not
 *   - the two or three rules that make this product not the generic one in its
 *     category. This is the section that decides whether the output could be
 *     any CRM or is this CRM.
 *
 * The same six the templates in the composer name, on purpose: the templates
 * are what a user is shown a good brief looks like, and a refiner that asked
 * for something else would teach two different lessons about the same thing.
 *
 * ## One worked example
 *
 * SYSTEM carries a full before-and-after. Haiku follows a demonstrated shape
 * far more reliably than a described one, and the example is worth its length:
 * measured on 「図書館の貸出システム作って」, eleven characters, the reply came back
 * with all six sections filled in, including a 15-book borrowing limit and a
 * 14-day due date that nothing in the request mentions.
 *
 * The whole call measures 1,710 input and about 900 output tokens on Haiku —
 * roughly six tenths of a cent, against a generation of about forty. Doubling
 * the editing pass to aim the build better is the right side of that trade by
 * two orders of magnitude.
 *
 * ## Not a silent rewrite
 *
 * It returns a suggestion for the composer to show, never a substitution. The
 * user has to be able to see what was added and decide — a brief that quietly
 * became something else is a UI that arrives with screens nobody asked for, and
 * no way to tell where they came from. The composer puts the text in the box;
 * pressing send is still the user's.
 *
 * ## Always Haiku
 *
 * On the operator's instruction, and the reason survives the instruction: this
 * runs on a keystroke-adjacent action, before any generation is paid for, and
 * an editing pass that costs a meaningful fraction of the build it precedes is
 * not worth having. The model is read from configuration rather than taken as
 * an argument so no caller can raise it — see the note on `resolveModel`, where
 * the same decision is made for the brief-reading router.
 */

/** Long enough to be worth an editing pass, short enough to be one. */
const MAX_INPUT_CHARS = 2000;

/**
 * The refined brief is a brief, not a specification.
 *
 * Raised from 1,200 when the rewrite started naming states, folding behaviour
 * and the rules that make a product specific. Japanese runs a little over a
 * token a character, so 1,200 truncated a brief of about 800 characters — and a
 * truncated suggestion fails in the worst way available: it parses, it reads as
 * finished, and the section that was cut is the one the model never sees.
 */
const MAX_OUTPUT_TOKENS = 2400;

export interface RefinedPrompt {
  /** The rewritten brief, ready to be put in the composer. */
  prompt: string;
  /**
   * What was added or made explicit, one short line each, in the user's
   * language.
   *
   * The point of the feature is not the new text — it is that the user can see
   * what the new text assumes. A rewrite with no account of itself is something
   * to accept or reject blind, and the sensible response to that is to reject
   * it every time.
   */
  notes: string[];
}

const SYSTEM = `あなたはUI生成サービスのプロンプト添削者です。
ユーザーが書いた依頼文を、UIを生成するモデルが迷わず作れる依頼文に書き直します。

読み手は、依頼文から画面を設計し、コンポーネントに分割し、状態を持たせて実装するモデルです。
そのモデルが判断に迷うところだけを埋めてください。埋めるべきは次の6つです。

1. 画面の一覧（5つ以上）
   ユーザーが数を書いていないなら、依頼から自然に必要になる画面を挙げる。
   一覧・詳細・入力・確認・完了のように、利用者が実際に辿る順で並べる。
   一覧から詳細へ、詳細から入力へ、どの画面がどの画面に繋がるかを書く。

2. 各画面に何が並ぶか
   一覧なら何の列か、フォームなら何の入力項目か、ダッシュボードなら何の数値か。
   カード・表・カレンダーのどれで見せるのが自然かまでは書いてよい。

3. 共有する状態と、それを書き換える操作
   どの画面をまたいで持ち回る値か、どの操作がそれを変え、変わった結果がどこに即座に現れるか。
   「カートに入れたらヘッダーの点数が変わる」のような、画面をまたぐ因果を1つは書く。

4. 状態（空・読み込み中・エラー）
   その依頼に実在するものだけ。絞り込みで0件になったとき、まだ1件も登録がないとき、
   送信中、送信に失敗したとき、権限がないとき。どの画面のどの場面かまで書く。
   生成されるUIはたいていデータで埋まった状態しか作られないが、利用者が最初に見るのは空の状態です。

5. 扱うデータの性格
   件数の規模、値の幅（金額なら下限と上限）、日付や氏名が出てくるか。
   「16件」「3,000円〜28,000円」のように具体的に書く。ばらつきのある実在しそうなデータになります。

6. この製品を一般的なものと違わせている決まりごと（2〜3個）
   締切を過ぎたら変更できない、却下には理由が要る、承認したら在庫に反映される、といった業務上の規則。
   ここが一番効きます。これが無いと、どの会社のものでもある画面が出てきます。

してはいけないこと:
- 色・フォント・角丸・余白・影などの見た目の指定を足さない。デザインは生成側の仕事です
- 技術スタックやライブラリ名、CSSの値を足さない
- ユーザーが求めていない機能を足さない。認証・課金・通知・多言語は、依頼にあるときだけ
- ユーザーが書いた要望は一つも落とさない。言い換えてもよいが、削ってはいけない
- 依頼が既に十分に具体的なら、ほとんど書き換えない

書き方:
- 見出しつきの箇条書きにする。散文の段落にしない
- 1行は短く。読み手はモデルであって、文章の巧みさは要らない
- 長さは全角600〜1000字を目安にする

例（依頼文が「社内の備品を管理するやつ」だったとき）:
社内備品の在庫管理システム。総務が在庫を把握し、社員が発注を申請し、承認者が可否を決める。

画面:
- 在庫サマリ: 総点数、在庫僅少の点数、承認待ちの件数。棚別の在庫状況一覧。
- 備品一覧: 品名・棚・現在庫・安全在庫・最終入荷日。棚と在庫状態で絞り込み、品名で検索。行クリックで詳細へ。
- 備品詳細: 在庫の推移、入出庫履歴、この備品の発注申請への導線。
- 発注申請: 品目、数量、希望納期、理由。確認ステップを挟んで申請。
- 承認キュー: 承認者向けの申請一覧と、承認・却下。

共有する状態: 在庫数、申請とその状態。承認したら在庫の入荷予定に反映され、サマリの数値も同時に変わること。

状態: 在庫僅少が0件のとき、承認待ちが空のとき、検索に該当がないとき、申請の送信中。

データ: 備品20点、申請8件。欠品を2点含め、数量・日付・担当者はすべて別の値にする。

外せない点:
- 却下には理由の入力を必須にし、その理由は申請者の画面に表示される
- 安全在庫を下回った品目は、色だけでなく語でも警告する
- 申請中の数量は現在庫には含めず、入荷予定として別に見せる

出力は次のJSONだけ。前後に文章を書かない。
{"prompt":"書き直した依頼文","notes":["補った点を1行で","..."]}

notes はユーザーの言語で、最大4件。何も補っていないなら空配列。`;

/**
 * What the call actually cost, handed back the moment it is known.
 *
 * A callback rather than a field on the return value, because this function
 * returns `null` on three separate paths AFTER the model has been paid — an
 * unparsable reply, a suggestion identical to the input, an empty one. A caller
 * billing from the return value would therefore charge for the useful answers
 * and give the useless ones away, which is the wrong way round: the run that
 * produced nothing is exactly the one worth costing.
 */
export interface RefineUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * @param prompt what the user has typed so far
 * @param onUsage called once with what the model reported, before any return
 * @returns the suggestion, or null when there is nothing useful to say
 */
export async function refinePrompt(
  prompt: string,
  onUsage?: (usage: RefineUsage) => void
): Promise<RefinedPrompt | null> {
  const text = prompt.trim();
  if (!text) return null;

  const config = await getModelConfig();
  const client = createBedrockClient();
  const response = await client.send(new InvokeModelCommand({
    modelId: config.haikuId,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: MAX_OUTPUT_TOKENS,
      system: SYSTEM,
      messages: [{ role: 'user', content: `依頼文:\n${text.slice(0, MAX_INPUT_CHARS)}` }],
    }),
  }));

  const body = JSON.parse(new TextDecoder().decode(response.body));
  const raw: string = body.content?.[0]?.text ?? '';
  const usage = body.usage ?? {};
  // Before every branch below, all of which can return without a suggestion.
  onUsage?.({ inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 });
  const parsed = firstJsonObject<{ prompt?: unknown; notes?: unknown }>(raw);
  if (!parsed || typeof parsed.prompt !== 'string' || !parsed.prompt.trim()) {
    logger.warn('Prompt refinement returned nothing usable', { preview: raw.slice(0, 200) });
    return null;
  }

  const refined = parsed.prompt.trim();
  /*
   * A suggestion identical to the input is not a suggestion.
   *
   * The prompt says to leave a sufficiently specific brief nearly alone, and
   * this is what that instruction looks like when it is followed exactly.
   * Offering the user their own sentence back, with a button to accept it,
   * teaches them the feature does nothing.
   */
  if (refined === text) {
    logger.info('Prompt refinement had nothing to add', { chars: text.length });
    return null;
  }

  const notes = Array.isArray(parsed.notes)
    ? parsed.notes.map((n) => String(n).trim()).filter(Boolean).slice(0, 4)
    : [];

  logger.info('Prompt refined', {
    before: text.length,
    after: refined.length,
    notes: notes.length,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
  });
  return { prompt: refined, notes };
}

