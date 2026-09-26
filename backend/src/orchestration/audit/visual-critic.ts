import type { InteractionDefect } from './interaction-audit.js'
import type { ImageInput } from '../../utils/image-input.js'
import { logger } from '../../utils/logger.js'
import { firstJsonObject } from '../../utils/model-json.js'
import { repairable } from '../repair/repair-yield.js'

/**
 * Looks at the rendered page and says what a designer would say about it.
 *
 * ## What it is no longer asked about
 *
 * Accent and artefact followed on 2026-09-14, on a measurement rather than an
 * instruction: repairs left them standing more often than simply asking the
 * critic twice did (71% against 38%, 45% against 24%, both past twenty
 * instances) — see `PERSISTENCE` in repair-yield.ts.
 *
 * Hierarchy, spacing and alignment are gone from the list below, on the
 * operator's instruction, because the repair loop had already stopped acting on
 * them: `repairable()` refuses all three, so over 14 days they were detected 102
 * times, skipped 102 times, and shipped. Asking a vision model for a finding
 * nothing will act on costs a share of 96 calls a fortnight and produces a
 * report that reads like a to-do list nobody is working from.
 *
 * The removal is in two places on purpose. The prompt stops asking, which is
 * where the saving is; and the filter below drops them anyway, keyed off the
 * SAME `repairable()` the loop uses, which is where the drift is prevented.
 * Making one of them repairable again is one edit, in repair-yield.ts, and the
 * critic starts asking for it again on its own.
 *
 * It does not change any score: `scoring.ts` never reads these findings. It
 * changes what is reported as open, which is the point — a defect the pipeline
 * has decided not to fix was being carried to the user as though it might be.
 *
 * The static audits check that things exist; the runtime audit checks that they
 * are filled and that they work. Neither can judge whether the result looks
 * designed — whether the hierarchy reads, whether the density suits the domain,
 * whether it has the anonymous evenness that makes generated work recognisable.
 * That needs eyes, and a screenshot is the only artefact in this pipeline that
 * carries it.
 *
 * Deliberately narrow: it may only report things that are visible in the image
 * and fixable in CSS or markup. A critic that speculates about behaviour it
 * cannot see produces repair instructions the repair pass cannot act on, and a
 * repair pass given an unachievable instruction damages a working document
 * trying to satisfy it.
 */

const SYSTEM = `あなたはUIデザインのアートディレクターです。実装されたUIのスクリーンショットを1枚見て、
デザイナーが差し戻すレベルの欠陥だけを指摘します。

指摘してよいのは、**画像に写っていて、CSSかマークアップで直せるもの**だけです:
- タイポグラフィの段階が機能していない（見出しと本文の差が足りない／大きすぎる）
- 情報密度がその画面の役割に合っていない

指摘してはいけないもの:
- 画像から確認できない挙動やデータの正しさ
- 「もっとリッチに」のような、何を変えればよいか決まらない要望
- 好みの問題（この色よりあの色が好き、など）
- 画像に写っていない画面のこと

各指摘は、**そのまま実装できる具体的な修正**として書いてください。
「余白が変」ではなく「カード間のギャップが16pxと32pxで混在しているので24pxに統一する」。

問題が無ければ、次の一語だけを返してください: OK

問題がある場合は、重要な順に最大4件、次の形式のJSONだけを返してください:
{"issues":[{"id":"<typography|density>","problem":"<何が問題かを利用者向けに一文で。40字以内。修正方法やpx値は書かない>","fix":"<具体的な修正指示>"}]}
例: {"id":"typography","problem":"ページの見出しが本文と同じ大きさで目立ちません","fix":"ページ見出しを 28px・太さ 700 にし、本文 15px との差をつける"}`

interface VisualCritique {
  issues: { id: string; fix: string; problem?: string }[]
}

/**
 * What a finding says to the person who asked for the UI.
 *
 * The critic writes `fix` for the repair model, and the reply showed it as-is —
 * with the suffix this module appends, clipped mid-sentence. Measured on the
 * 2026-09-13 run: 「ページタイトル「蔵書一覧」のフォントサイズを、サイドバーの
 * 「蔵書一覧」ボタンより明確に大きくする（現在、ボタンとタイトルの視覚階層が不足
 * している） 画面の構成や文言は変えず、この…」 — an instruction to a model, cut
 * off, in the list of open findings.
 *
 * So the critic is asked for `problem` as well, and when it leaves it out the
 * note names the category and the head of the fix, never the suffix.
 */
const CATEGORY: Record<string, string> = {
  'visual-typography': '文字の大きさや強弱',
  'visual-density': '情報の密度',
}
const MAX_NOTE = 60

function criticNote(id: string, fix: string, problem?: string): string {
  const clip = (t: string) => (t.length > MAX_NOTE ? `${t.slice(0, MAX_NOTE - 1)}…` : t)
  const own = typeof problem === 'string' ? problem.trim() : ''
  if (own.length >= 6) return clip(own)
  const head = fix.trim().split(/[。（(]/)[0].trim()
  return clip(`${CATEGORY[id] ?? '見た目'}: ${head}`)
}

/**
 * @param screenshotBase64 PNG of the rendered page.
 * @param invoke The pipeline's model caller, passed in so this module stays free
 *   of Bedrock wiring and can be tested with a stub.
 */
export async function critiqueScreenshot(
  screenshotBase64: string,
  context: string,
  invoke: (system: string, user: string, image: ImageInput) => Promise<string>
): Promise<InteractionDefect[]> {
  if (!screenshotBase64) return []
  try {
    const raw = await invoke(
      SYSTEM,
      `この画面のスクリーンショットです。${context}\n\n上の基準で、差し戻すべき欠陥だけを挙げてください。`,
      { format: 'png', mediaType: 'image/png', base64: screenshotBase64 }
    )
    const text = raw.trim()
    if (/^OK\b/i.test(text)) {
      logger.info('Visual critique: no issues')
      return []
    }
    const parsed = firstJsonObject<VisualCritique>(text)
    if (!parsed) {
      logger.warn('Visual critique returned no parsable JSON', { preview: text.slice(0, 200) })
      return []
    }
    /*
     * Sliced to four AFTER the refused ones are dropped, not before.
     *
     * The cap came first and the filter second, so a reply whose first four
     * findings were spacing, hierarchy, alignment and one more left exactly one
     * actionable finding — the cap had already been spent on three the loop
     * refuses. Measured against a five-finding fixture: `visual-accent`
     * disappeared. The cap is meant to bound what a pass is asked to do, so it
     * has to count only what a pass can be asked to do.
     */
    const issues = Array.isArray(parsed.issues) ? parsed.issues : []
    const found = issues
      .filter((i) => typeof i?.fix === 'string' && i.fix.trim().length > 8)
      .map((i) => {
        const id = `visual-${String(i.id || 'issue').replace(/[^a-z-]/gi, '')}`
        return {
          id,
          instruction: `${i.fix.trim()} 画面の構成や文言は変えず、この見た目の問題だけを直してください。`,
          note: criticNote(id, i.fix, i.problem),
        }
      })
    /*
     * And dropped here as well as unasked for above.
     *
     * The prompt is a request, not a constraint — a model told not to mention
     * spacing will mention spacing — and a finding nothing will act on is worse
     * than no finding: it is carried to the user as an open defect that was
     * never going to be attempted. Keyed off `repairable()` so this list and the
     * repair loop's cannot disagree.
     */
    const kept = found.filter((d) => repairable(d.id)).slice(0, 4)
    if (kept.length < found.length) {
      logger.info('Visual critique: dropped findings nothing repairs', {
        dropped: found.filter((d) => !repairable(d.id)).map((d) => d.id),
      })
    }
    logger.info('Visual critique', { issues: kept.map((i) => i.id).join(',') || 'none' })
    return kept
  } catch (e) {
    // A critique is an improvement, never a gate.
    logger.warn('Visual critique failed', { error: String(e) })
    return []
  }
}
