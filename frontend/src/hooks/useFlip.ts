import { useLayoutEffect, useRef, type RefObject } from 'react';
import { prefersReducedMotion, spring } from '../utils/motion';

interface Box { x: number; y: number; w: number; h: number }

interface FlipOptions {
  /** Delay between successive items appearing, in ms. */
  stagger?: number;
  /** No more than this much stagger in total, however many appear. */
  maxStagger?: number;
}

/** Marks a child that is leaving — see `usePresenceList`. */
export const EXITING_ATTR = 'data-flip-exiting';

/**
 * More items than this arriving or leaving at once — a first load, a tab
 * switch — is a change of page rather than a change within it, and is animated
 * as one: the container fades up once, instead of every card fading on its own.
 * Each card holds an iframe, and a dozen iframes each on their own animated
 * layer was the heaviest thing the list did (2026-09-24).
 */
const BULK = 6;

/**
 * Layout animation for a container's children: when the list changes, items
 * travel from where they were to where they are; new ones rise into place;
 * ones flagged as leaving are lifted out of the flow and fade where they stood.
 *
 * Runs when `signature` changes — the caller's description of what is in the
 * list and in what order — and not on every render. It used to measure every
 * child on every render, and the project list re-renders on a six-second poll
 * and on every keystroke in its search box: a forced layout of the whole grid
 * each time, for renders that moved nothing. A resize, which moves things
 * without a render, re-records the positions without animating.
 *
 * Positions are layout offsets inside the container (which is made the offset
 * parent), so scrolling between two changes is not mistaken for movement. The
 * one thing offsets cannot see is a move still in flight — so the transform an
 * interrupted animation had reached is read back and added in, and a second
 * click mid-flight continues from where the card visibly is.
 *
 * Only what is on screen is animated.
 */
export function useFlip(
  ref: RefObject<HTMLElement | null>,
  signature: string,
  { stagger = 24, maxStagger = 160 }: FlipOptions = {},
) {
  const boxes = useRef(new WeakMap<Element, Box>());
  const moves = useRef(new WeakMap<Element, Animation>());
  const mounted = useRef(false);

  // Positions go stale when the container is resized without a render; re-record them.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || typeof ResizeObserver !== 'function') return;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        for (const el of Array.from(root.children) as HTMLElement[]) {
          if (!el.dataset.flipPinned) boxes.current.set(el, { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
        }
      });
    });
    ro.observe(root);
    return () => { ro.disconnect(); cancelAnimationFrame(frame); };
  }, [ref]);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    if (!mounted.current && getComputedStyle(root).position === 'static') root.style.position = 'relative';
    const reduced = prefersReducedMotion();
    const animate = mounted.current && !reduced && typeof root.animate === 'function';
    mounted.current = true;
    const kids = Array.from(root.children) as HTMLElement[];

    const leaving = kids.filter((el) => el.hasAttribute(EXITING_ATTR) && !el.dataset.flipPinned);
    const arriving = kids.filter((el) => !el.hasAttribute(EXITING_ATTR) && !el.dataset.flipPinned && !boxes.current.has(el));
    const bulk = leaving.length + arriving.length > BULK;

    // 1. Lift the leaving ones out first: their going is what moves the rest.
    for (const el of kids) {
      const isLeaving = el.hasAttribute(EXITING_ATTR);
      if (isLeaving && !el.dataset.flipPinned) {
        const was = boxes.current.get(el);
        el.dataset.flipPinned = '1';
        if (!was || !animate || bulk) { el.style.display = 'none'; continue; }
        Object.assign(el.style, {
          position: 'absolute', left: `${was.x}px`, top: `${was.y}px`,
          width: `${was.w}px`, height: `${was.h}px`, margin: '0', pointerEvents: 'none', zIndex: '0',
        });
        moves.current.get(el)?.cancel();
        el.animate(
          [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.94)' }],
          { duration: 160, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' }
        );
      } else if (!isLeaving && el.dataset.flipPinned) {
        // It came back before it was gone: put it back in the flow.
        delete el.dataset.flipPinned;
        for (const a of el.getAnimations()) a.cancel();
        for (const p of ['position', 'left', 'top', 'width', 'height', 'margin', 'pointer-events', 'z-index', 'display']) el.style.removeProperty(p);
        boxes.current.delete(el);
      }
    }

    // 2. Measure everything that stays, and move it from where it was.
    const view = animate ? root.getBoundingClientRect() : null;
    const onScreen = (b: Box) => {
      if (!view) return false;
      const top = view.top + root.clientTop + b.y - root.scrollTop;
      return top + b.h > 0 && top < window.innerHeight;
    };
    const quick = spring('quick');
    let entering = 0;
    for (const el of kids) {
      if (el.dataset.flipPinned) continue;
      const box: Box = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
      const was = boxes.current.get(el);
      boxes.current.set(el, box);
      if (!animate) continue;

      if (!was) {
        if (bulk || !onScreen(box)) continue;
        const delay = Math.min(entering++ * stagger, maxStagger);
        // Opacity and a short rise, no scale: scaling a card rescales its iframe.
        el.animate(
          [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
          { duration: quick.duration, easing: quick.easing, delay, fill: 'backwards' }
        );
        continue;
      }

      // Where it visibly is now: its old place plus whatever a running move had reached.
      const running = moves.current.get(el);
      let tx = 0, ty = 0;
      if (running && running.playState === 'running') {
        const t = getComputedStyle(el).transform;
        if (t && t !== 'none') { const m = new DOMMatrixReadOnly(t); tx = m.m41; ty = m.m42; }
        running.cancel();
      }
      const dx = was.x - box.x + tx;
      const dy = was.y - box.y + ty;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      if (!onScreen(box) && !onScreen({ ...box, x: box.x + dx, y: box.y + dy })) continue;
      moves.current.set(el, el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: quick.duration, easing: quick.easing }
      ));
    }

    // A change of page: the whole list arrives once.
    if (animate && bulk && arriving.length > 0) {
      root.animate(
        [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
        { duration: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
}
