import type { PlanRevision } from './graph.js'

/**
 * A proposal amended, rather than a proposal thrown away.
 *
 * Plan mode answered every message on a project with no document by running the
 * whole design phase — four specialists, about 42,000 tokens measured over 110
 * generations — on the message alone. So 「画面をもう1つ増やして」 after a
 * proposal was planned as if it were the brief: the proposal the user was
 * amending was not sent, and the new one was a plan for "add a screen" to
 * nothing, at the cost of a generation's design phase.
 *
 * What an amendment needs is the specification it amends and the change. One
 * call reads both and writes two things: the changes, stated so the build can
 * act on them, and the proposal rewritten with them in. The changes go at the
 * TOP of the specification, above everything they override, because the build
 * reads the specification from the start and a long one is cut from the end.
 */

/** The heading every amendment block carries, so the next one can stack above it. */
export const REVISIONS_HEADING = '## 利用者の追加指示で確定した変更'

const REVISIONS_NOTE =
  '（この節は下の設計仕様より優先します。矛盾する箇所はこちらに従ってください。複数ある場合は上が新しい指示です）'

const MARK_REVISIONS = '<<<REVISIONS>>>'
const MARK_PLAN = '<<<PLAN>>>'

/** How much of the specification the reviser reads — the same bound the writer uses. */
const SPEC_READ_CHARS = 20_000

export function reviserSystem(planFormat: string): string {
  return `あなたは、承認前のUI設計の提案に、利用者の追加指示を反映します。
入力は、元の依頼・現在の提案・その裏にある設計仕様・追加指示です。

出力は次の2つの節だけです。前置きや説明は書かないでください。

${MARK_REVISIONS}
追加指示によって設計仕様のどこがどう変わるかを、実装者がそのまま作れる具体さで箇条書きにします。
- 画面を足すなら: 画面名、何が表示されるか（項目・列・ボタン）、どこから遷移するか、ナビに載せるか
- 画面を削るなら: どの画面を削り、そこへの導線をどう変えるか
- 操作を変えるなら: どこの何を押すと、どの状態がどう変わるか
- 見た目を変えるなら: 色（16進数）・書体・余白・角丸など、具体的な値
変わらない部分は書きません。1,500字以内。

${MARK_PLAN}
変更を反映した提案の全文を、下の「提案の書式」どおりに書き直します。

提案の書式:
${planFormat}`
}

export function reviserInput(revision: PlanRevision, instruction: string): string {
  return [
    `元の依頼: "${revision.prompt}"`,
    `追加指示: "${instruction}"`,
    '',
    '現在の提案:',
    revision.plan.slice(0, 6000),
    '',
    '設計仕様:',
    revision.spec.slice(0, SPEC_READ_CHARS),
  ].join('\n')
}

export interface RevisedPlan {
  /** The specification with this amendment on top, for /generate. */
  spec: string
  /** The amendment itself. Empty when the reply carried none. */
  revisions: string
  /** The rewritten proposal. Empty when the reply did not carry one. */
  plan: string
  /** Whether `plan` can be shown as it is. */
  rewrote: boolean
}

/**
 * Splits the reply and stacks the amendment on the specification.
 *
 * Without the markers the whole reply is taken as the amendment — the change is
 * the part that must not be lost — and the caller writes the proposal itself.
 */
export function applyRevision(revision: PlanRevision, instruction: string, reply: string): RevisedPlan {
  const text = reply.replace(/```[a-z]*\n?/gi, '').trim()
  const r = text.indexOf(MARK_REVISIONS)
  const p = text.indexOf(MARK_PLAN)
  let revisions: string
  let plan = ''
  if (r !== -1 && p !== -1 && p > r) {
    revisions = text.slice(r + MARK_REVISIONS.length, p).trim()
    plan = text.slice(p + MARK_PLAN.length).trim()
  } else if (r === -1 && p !== -1) {
    revisions = text.slice(0, p).trim()
    plan = text.slice(p + MARK_PLAN.length).trim()
  } else {
    revisions = text.replace(MARK_REVISIONS, '').trim()
  }
  // Two of the format's headings at least: a proposal, not an acknowledgement.
  const rewrote = (plan.match(/^##\s/gm)?.length ?? 0) >= 2
  const block = [
    `${REVISIONS_HEADING}${REVISIONS_NOTE}`,
    `追加指示: 「${instruction}」`,
    revisions || `（変更点の整理に失敗したため、追加指示をそのまま優先してください）`,
  ].join('\n')
  return { spec: `${block}\n\n${revision.spec}`, revisions, plan: rewrote ? plan : '', rewrote }
}

export async function revisePlan(
  revision: PlanRevision,
  instruction: string,
  invoke: (system: string, user: string) => Promise<string>,
  planFormat: string
): Promise<RevisedPlan> {
  const reply = await invoke(reviserSystem(planFormat), reviserInput(revision, instruction))
  return applyRevision(revision, instruction, reply)
}
