/**
 * What the app does not currently offer, and why.
 *
 * A provisional list, kept in one file so that restoring something is deleting a
 * line rather than finding every place that mentions it. Everything here is
 * still implemented and still tested; it is only withheld from the menus and
 * refused at the door.
 *
 * ## Opus, and 思考モード with it
 *
 * Measured 2026-09-04, and the measurement is the point — the same
 * `AccessDeniedException: not available for this account` came back for three
 * unrelated reasons, and two of them were fixed before the third turned out to
 * be the one that mattered:
 *
 *   - the model agreement had not been accepted. It was, with the operator's
 *     go-ahead, and `agreementAvailability` reached AVAILABLE in sixty seconds.
 *     The invoke stayed refused.
 *   - the runtime role permits `inference-profile/jp.anthropic.*` only, so every
 *     `global.` profile is refused before Bedrock is asked.
 *   - the account's throughput allocation for Opus 4.8 is zero. Every quota row
 *     reads 0.0 against an AWS default of 21,600,000,000 tokens a day, so it is
 *     set to zero rather than left unprovisioned, and the daily rows are
 *     `Adjustable: false`. There is no self-service raise; the error message
 *     says to contact AWS Sales.
 *
 * Across every Opus inference profile in ap-northeast-1: 4.8 and 4.7 refuse on
 * both `jp.` and `global.`, Opus 5 refuses, and only
 * `global.anthropic.claude-opus-4-6-v1` and `-4-5-20251101-v1:0` answer —
 * neither of which has a `jp.` profile, so reaching them would mean sending
 * inference outside Japan. That is a policy decision and not a config fix, so it
 * is not made here.
 *
 * 思考モード was withdrawn alongside it, because its whole description was
 * 「Opus固定」 and a mode delivering Sonnet on every request is the menu lying.
 * There is no such mode any more: a mode no longer chooses a model, so nothing
 * about Opus can make one unusable. What remains is this list, and the picker
 * refusing the entry it names.
 *
 * To restore: empty the list. Nothing else has to change.
 */
import type { ModelId } from './model-config.js';

export const WITHDRAWN_MODELS: readonly ModelId[] = ['opus'];

/**
 * Said to the user when their request named one of these.
 *
 * Deliberately not 「管理者の設定により」, which is what the permitted-set clamp
 * says and would be a lie here: no administrator chose this, and someone acting
 * on it would go looking at a setting that has nothing to do with it.
 */
export const WITHDRAWN_NOTE = '現在 Opus は利用できないため sonnet を使用します';

export const isWithdrawnModel = (id: string): boolean =>
  (WITHDRAWN_MODELS as readonly string[]).includes(id);
