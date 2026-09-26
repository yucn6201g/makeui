import type { PhaseEntry } from './phaseTranscript';

/**
 * What the preview says while it is being built.
 *
 * The preview pane used to show the same idle placeholder during a run as it did
 * before one started — 「プレビューがここに表示されます / 左のチャットからUIを
 * 生成してください」 — so the one moment the user is most certainly watching it was
 * also the moment it told them to go and do the thing they had just done. The
 * only sign anything was happening lived in the other pane.
 *
 * The caption is the run's own phase label rather than a fixed string, because
 * the run already publishes one and it is the honest answer to "what is it doing
 * right now". A generic 「生成中…」 would be a downgrade from information the
 * server is already sending.
 *
 * Split into a function of its own so it can be tested without a DOM: the
 * component around it is presentation, and this is the only part with a decision
 * in it.
 */
interface GeneratingCaption {
  /** The line in the preview. */
  title: string;
  /** Smaller line under it, or empty when there is nothing honest to add. */
  detail: string;
}

const FALLBACK_TITLE = 'UIを生成しています';

/**
 * A step that has not produced anything yet has nothing to report, and saying
 * so is better than naming a step that has not started.
 */
const QUEUED_DETAIL = 'まもなく開始します';

export function generatingCaption(phases: PhaseEntry[] | undefined | null): GeneratingCaption {
  const list = Array.isArray(phases) ? phases : [];
  if (list.length === 0) return { title: FALLBACK_TITLE, detail: QUEUED_DETAIL };

  // The live step is the last one the server reported.
  const current = list[list.length - 1];
  const title = (current?.label ?? '').trim() || FALLBACK_TITLE;

  /*
   * "3 / 5" would be a lie: the number of steps is decided by the router at run
   * time and the list only grows as they start, so the total is not known until
   * the run is over. Counting only what has finished is a fact.
   */
  const done = Math.max(0, list.length - 1);
  const detail = done > 0 ? `${done}個のステップが完了` : QUEUED_DETAIL;

  return { title, detail };
}
