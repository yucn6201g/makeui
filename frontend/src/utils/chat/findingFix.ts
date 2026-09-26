/**
 * What the 「修正を依頼」 button beside an open finding sends.
 *
 * The findings list under a reply was a list of things to read. Acting on one
 * meant copying it into the composer — a person told 「スタイルが各コンポーネント
 * に散っていて、共通化されていません」 had to retype it to ask for the obvious
 * next thing.
 *
 * A function rather than a template literal at the call site, for the same
 * reason `runtimeRepair.ts` is one: two decisions live in the wording.
 *
 *  - The instruction has to bound the change. A finding is a description of a
 *    symptom, and the edit path answers an instruction by rewriting whole
 *    files: measured 2026-09-18 on this project's own storefront, an edit asked
 *    to make product cards clickable rewrote the screen, deleted the working
 *    `ProductCard` component and invented a `product.imageUrl` the data has not
 *    got. So the instruction says what NOT to touch as plainly as what to fix.
 *  - The finding is prose of unbounded length, and it is shown back to the
 *    person as their own message. Two budgets, as there: the model can afford
 *    more of it than the transcript bubble can.
 *
 * One finding per request, which is the pipeline's measurement rather than a
 * preference: a repair call handed eight unrelated instructions 「returned
 * exactly as many defects as it was given」. That is why the repair pass and the
 * edit path are both one file at a time, and why there is no 「まとめて修正」.
 */

/** As much of the finding as is worth sending to the model. */
export const FINDING_FOR_MODEL = 1000;
/** As much as is worth showing in the chat transcript. */
export const FINDING_FOR_TRANSCRIPT = 200;

const clip = (finding: string, max: number): string => {
  const text = finding.trim();
  return text.length <= max ? text : `${text.slice(0, max)}…`;
};

/** The edit instruction, or null when the finding is empty. */
export function findingFixInstruction(finding: string): string | null {
  const text = finding.trim();
  if (!text) return null;
  return (
    '次の指摘を修正してください。\n'
    + '指摘された点だけを直し、ほかの画面・文言・データ・構成はそのままにしてください。\n'
    + '動いている部品を作り直さず、必要な箇所だけを変更してください。\n\n'
    + clip(text, FINDING_FOR_MODEL)
  );
}

/** What the person sees in the thread as their own message. */
export function findingFixMessage(finding: string): string {
  return `次の指摘の修正を依頼しました。\n\n${clip(finding, FINDING_FOR_TRANSCRIPT)}`;
}
