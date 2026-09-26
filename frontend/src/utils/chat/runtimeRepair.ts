/**
 * What the 修復する button actually sends.
 *
 * The preview frame already catches the error that stops a generated app before
 * it renders, and the banner used to be the end of it: a message, and nothing to
 * do with it. The button turns that message into the next edit.
 *
 * Two decisions live here, which is why this is a function and not an inline
 * template literal:
 *
 *  - The instruction has to say that the fix is the cause, not the symptom. Left
 *    to itself a repair pass will happily delete the screen that threw and
 *    report success — the app then starts, and the feature the user asked for is
 *    gone. Measured on the corpus: the repair prompt that only named the error
 *    got a removed component back more often than a written one.
 *  - The detail is a browser stack. It is unbounded, it is mostly frames from
 *    the bundle, and the first lines are the only ones that identify anything.
 *    Two different budgets: the model can afford more of it than the transcript
 *    bubble, which a person has to read past.
 */

/** As much of the stack as is worth sending to the model. */
export const DETAIL_FOR_MODEL = 2000;
/** As much as is worth showing in the chat transcript. */
export const DETAIL_FOR_TRANSCRIPT = 400;

const clip = (detail: string, max: number) => {
  const text = detail.trim();
  return text.length <= max ? text : `${text.slice(0, max)}…`;
};

/** The edit instruction, or null when there is no error text to act on. */
export function runtimeRepairInstruction(detail: string): string | null {
  const text = detail.trim();
  if (!text) return null;
  return (
    '生成されたアプリが起動時にエラーで停止しています。以下のエラーを解消してください。\n'
    + '画面や機能を削って回避するのではなく、原因を直してください。\n\n'
    + clip(text, DETAIL_FOR_MODEL)
  );
}

/** What the user sees in the transcript as their own message. */
export function runtimeRepairMessage(detail: string): string {
  return `起動エラーの修復を依頼しました。\n\n${clip(detail, DETAIL_FOR_TRANSCRIPT)}`;
}
