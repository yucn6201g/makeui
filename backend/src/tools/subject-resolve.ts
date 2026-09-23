import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'
import { createBedrockClient } from '../config/bedrock-client.js'
import { getModelConfig } from '../config/agentcore-config.js'
import { firstJsonObject } from '../utils/model-json.js'
import { recordTokens, recordUnreportedCall } from '../services/token-ledger.js'
import { logger } from '../utils/logger.js'
import { SUBJECT_CATEGORY } from './subject-terms.js'

/**
 * What an item is a picture OF, when its name does not contain the word.
 *
 * The photograph picker matches an item's name against a term list, which is a
 * substring test: 「北海道産 無塩バター 200g」 finds `butter`, and 「カプチーノ」
 * finds nothing at all — although the library holds sixteen photographs of
 * coffee. Measured in production over three weeks: of 84 photograph slots, 42
 * were left blank, and the blanked names were 「アメリカーノ」「カプチーノ」, five
 * novels, 「USB-C ハブ」, and a page of news headlines. The library contains
 * `coffee` and `book`. The vocabulary did not.
 *
 * A term list cannot fix this. Novels are not called "本", coffee drinks are not
 * called "コーヒー", and every shop invents names nobody has written down yet —
 * the list would need a line per product name in the world.
 *
 * So the unresolved names are read once per run by Haiku, against the closed
 * list of subjects the library actually holds. Three properties make this safe
 * to put in a generation:
 *
 *   - It answers with a subject FROM THE LIST or with null, and anything not in
 *     the list is discarded here. A hallucinated subject cannot reach the page;
 *     the worst case is a name resolving to nothing, which is what it did before.
 *   - It is one call for every unresolved name on the page, not one per name.
 *   - It fails open. No config, no model, malformed JSON, a timeout — the map
 *     comes back empty and every caller behaves exactly as it did before.
 *
 * Haiku for the reason the requirement extractor and the router use it: this
 * runs on every generation and every edit, and a helper that costs a meaningful
 * share of what it helps is not worth having. About a tenth of a cent against a
 * generation of tens of cents.
 */

const SUBJECTS = Object.keys(SUBJECT_CATEGORY)
const SUBJECT_SET = new Set(SUBJECTS)

/** Names asked about once already, kept for the life of the container. */
const resolved = new Map<string, string | null>()

/** More names than this on one page and the tail is decoration, not a catalogue. */
const MAX_LABELS = 40
const MAX_LABEL_CHARS = 80

const SYSTEM = `あなたは、UIに並ぶ品目の名前を「写真の被写体」に対応づけます。

被写体は次の一覧のいずれかだけです（この中の語以外は使えません）:
${SUBJECTS.join(', ')}

規則:
- **その品目そのものが写っている写真になる場合だけ**、被写体を1つ選びます。
  例: 「カプチーノ」→ coffee、「騎士団長殺し」(小説)→ book、「USB-C ハブ」→ cable
- 別の製品の写真になるなら null にします。
  例: 「ワイヤレスマイク」に headphones は不可（別の製品です）。同じ分野というだけでは選びません。
- 実物ではないもの（ニュースの見出し、記事のタイトル、抽象的な概念、サービス名、
  プラン名、機能名）は null にします。写真にできないものを無理に対応づけないでください。
- 確信が持てないときも null にします。間違った写真より、写真が無いほうがましです。

出力は JSON オブジェクトのみ。キーは渡された品目名そのまま、値は被写体名か null。
{"カプチーノ":"coffee","AI企業の時価総額が過去最高":null}`

export type SubjectResolver = (labels: string[], brief?: string) => Promise<Map<string, string | null>>

/**
 * Resolve names the term list could not.
 *
 * Returns only what it is confident about; a name absent from the map is a name
 * that stays unresolved, which the caller already knows how to handle.
 */
export async function resolveSubjects(labels: string[], brief = ''): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  const ask: string[] = []
  for (const raw of labels) {
    const label = raw.trim().slice(0, MAX_LABEL_CHARS)
    if (!label) continue
    if (resolved.has(label)) {
      out.set(label, resolved.get(label)!)
      continue
    }
    if (!ask.includes(label)) ask.push(label)
  }
  if (ask.length === 0) return out

  const asked = ask.slice(0, MAX_LABELS)
  try {
    const config = await getModelConfig()
    const response = await createBedrockClient().send(new InvokeModelCommand({
      modelId: config.haikuId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 1200,
        system: SYSTEM,
        messages: [{
          role: 'user',
          content:
            `${brief ? `この画面が扱う分野: ${brief.slice(0, 300)}\n\n` : ''}品目名:\n` +
            asked.map((l) => `- ${l}`).join('\n'),
        }],
      }),
    }))
    const body = JSON.parse(new TextDecoder().decode(response.body))
    recordTokens(body.usage?.input_tokens ?? 0, body.usage?.output_tokens ?? 0, 'images:subject-resolve')
    const parsed = firstJsonObject<Record<string, unknown>>(body.content?.[0]?.text ?? '')
    let accepted = 0
    for (const label of asked) {
      const value = parsed?.[label]
      /**
       * Only a subject the library is indexed by counts. A model asked for one
       * of 115 words will occasionally answer with a 116th — `espresso`,
       * `novel` — and a subject nothing is filed under would send the picker
       * looking for photographs that do not exist.
       */
      const subject = typeof value === 'string' && SUBJECT_SET.has(value) ? value : null
      resolved.set(label, subject)
      out.set(label, subject)
      if (subject) accepted++
    }
    logger.info('Resolved item names to photograph subjects', {
      asked: asked.length,
      resolved: accepted,
      sample: asked.slice(0, 6).map((l) => `${l}→${out.get(l) ?? '-'}`),
    })
  } catch (e) {
    // A call that threw may still have spent its input; counted, never billed as zero.
    recordUnreportedCall('images:subject-resolve')
    logger.warn('Subject resolution failed; names stay unmatched', { error: String(e) })
  }
  return out
}
