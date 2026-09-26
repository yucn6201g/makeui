import { flushSync } from 'react-dom';
import { prefersReducedMotion } from './motion';

/** Which way a navigation goes: deeper into a project, or back out to the list. */
type NavDirection = 'forward' | 'back';

type StartViewTransition = (update: () => void) => { finished: Promise<void> };

/**
 * Moving between the project list and a project, as a push and a pop.
 *
 * The two screens are different component trees, so nothing on either side can
 * animate the other; the View Transitions API snapshots the old screen, lets
 * the new one render, and animates between the two images — index.css slides
 * them the way a navigation stack does, in the direction of travel.
 *
 * Where the API is missing, or the person has asked for less motion, the
 * update simply happens.
 */
export function navigate(update: () => void, direction: NavDirection): void {
  const start = (document as Document & { startViewTransition?: StartViewTransition }).startViewTransition;
  if (typeof start !== 'function' || prefersReducedMotion()) {
    update();
    return;
  }
  const html = document.documentElement;
  html.dataset.nav = direction;
  const transition = start.call(document, () => flushSync(update));
  transition.finished.finally(() => {
    if (html.dataset.nav === direction) delete html.dataset.nav;
  });
}
