/**
 * Whether a stored score is on the scale in use today.
 *
 * Scores sit one row under another — in the admin version list and down a chat
 * thread — and a change to the rubric or to what the browser measures moves the
 * number for the same document. On 2026-09-13 the walk stopped reporting working
 * buttons as dead (31 stored outputs replayed: 45 dead actions -> 4, up to
 * twelve points a document), so a score from before it reads as a regression
 * next to one from after, and nothing said so.
 *
 * Mirrors `SCORE_RUBRIC` in backend/src/orchestration/audit/scoring.ts; a backend test
 * reads this file and fails when the two disagree.
 */
export const CURRENT_SCORE_RUBRIC = 5;

/**
 * True when a score is on an older scale. Absent means recorded before the
 * field existed, which is by construction older.
 *
 * `scoreVerified === false` is not marked in the version list: an edit is scored
 * without a browser, and the 2026-09-13 change was to what a browser measures.
 */
export function isOlderScoreScale(v: { scoreRubric?: number; scoreVerified?: boolean }): boolean {
  if (v.scoreVerified === false) return false;
  return (v.scoreRubric ?? 0) < CURRENT_SCORE_RUBRIC;
}

/** The same question for a chat message, whose scale travels in `scoreParts`. */
export function isOlderRubric(rubric: number | undefined): boolean {
  return (rubric ?? 1) < CURRENT_SCORE_RUBRIC;
}
