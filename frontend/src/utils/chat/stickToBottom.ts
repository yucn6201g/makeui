/**
 * Keep the chat thread on its newest content while the reader is there.
 *
 * The thread used to scroll to the end only when a message was added or the
 * run's phase label changed. The activity card grows at other moments: a step's
 * text arrives on the poll AFTER its label, and opens a body a couple of hundred
 * pixels tall; the plan card's phases were not in that effect's list at all. The
 * scroll happened, the card grew under it, and the newest output sat below the
 * fold — reported as the chat not following the generation "sometimes".
 *
 * So it follows the content, not a list of state variables that happen to
 * change it: whenever the thread's content changes size, a reader who was at the
 * bottom is kept at the bottom. A reader who scrolled up is left where they are.
 *
 * The one subtlety is our own smooth scroll. Its intermediate scroll events are
 * far from the bottom, and read naively they say "the reader scrolled up", after
 * which nothing follows — and content that grew during the animation leaves it
 * short of the end. So while a scroll we started is in flight its events do not
 * count; it ends when it reaches the bottom, when the browser says it ended, when
 * the reader takes the wheel, or after a bound.
 */

/** Within this distance of the end counts as "at the bottom". */
export const STICK_PX = 80;
/** Longest a smooth scroll we started is allowed to hold the reader's intent. */
export const PROGRAMMATIC_MS = 1500;

interface ScrollableLike {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
  scrollTo(options: { top: number; behavior: 'smooth' | 'instant' }): void;
}

export function createStickToBottom(el: ScrollableLike, now: () => number = Date.now) {
  let stuck = true;
  let programmaticUntil = 0;
  const distance = () => el.scrollHeight - el.scrollTop - el.clientHeight;

  return {
    get stuck() {
      return stuck;
    },
    /** Go to the end and follow from there — a new message, a new step, the button. */
    scrollToEnd(smooth = true) {
      stuck = true;
      programmaticUntil = smooth ? now() + PROGRAMMATIC_MS : 0;
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
    },
    /** A scroll event, from whichever source. */
    onScroll() {
      if (programmaticUntil) {
        if (distance() > STICK_PX && now() < programmaticUntil) return;
        programmaticUntil = 0;
      }
      stuck = distance() <= STICK_PX;
    },
    /** The browser reports the scroll finished. */
    onScrollEnd() {
      programmaticUntil = 0;
      stuck = distance() <= STICK_PX;
    },
    /** Wheel, touch or keyboard: whatever moves next is the reader's doing. */
    onUserIntent() {
      programmaticUntil = 0;
    },
    /** The content changed size. Follow it if the reader is at the end. */
    contentChanged() {
      if (stuck && distance() > 1) el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
    },
  };
}

export type StickToBottom = ReturnType<typeof createStickToBottom>;
