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
 * Layout animation for a container's children: when a render moves them, they
 * travel from where they were to where they are; new ones rise into place;
 * ones flagged as leaving are lifted out of the flow and fade where they stood.
 *
 * Nothing to call: every commit is compared with the one before, so a filter,
 * a sort, a tab, a deletion or a card arriving from the server all animate the
 * same way, without each of them having to announce itself.
 *
 * Positions are layout offsets inside the container (which is made the offset
 * parent), so scrolling between two renders is not mistaken for movement. The
 * one thing offsets cannot see is a move still in flight — so the transform an
 * interrupted animation had reached is read back and added in, and a second
 * click mid-flight continues from where the card visibly is.
 *
 * Only what is on screen is animated. A grid of two hundred projects moves the
 * dozen anyone can see and places the rest.
 */
export function useFlip(ref: RefObject<HTMLElement | null>, { stagger = 24, maxStagger = 220 }: FlipOptions = {}) {
  const boxes = useRef(new WeakMap<Element, Box>());
  const mounted = useRef(false);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    if (getComputedStyle(root).position === 'static') root.style.position = 'relative';
    const reduced = prefersReducedMotion();
    const animate = mounted.current && !reduced && typeof root.animate === 'function';
    mounted.current = true;
    const kids = Array.from(root.children) as HTMLElement[];

    // 1. Lift the leaving ones out first: their going is what moves the rest.
    for (const el of kids) {
      const leaving = el.hasAttribute(EXITING_ATTR);
      if (leaving && !el.dataset.flipPinned) {
        const was = boxes.current.get(el);
        el.dataset.flipPinned = '1';
        if (!was || !animate) { el.style.display = 'none'; continue; }
        Object.assign(el.style, {
          position: 'absolute', left: `${was.x}px`, top: `${was.y}px`,
          width: `${was.w}px`, height: `${was.h}px`, margin: '0', pointerEvents: 'none', zIndex: '0',
        });
        for (const a of el.getAnimations()) a.cancel();
        el.animate(
          [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.92)' }],
          { duration: 170, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' }
        );
      } else if (!leaving && el.dataset.flipPinned) {
        // It came back before it was gone: put it back in the flow.
        delete el.dataset.flipPinned;
        for (const a of el.getAnimations()) a.cancel();
        for (const p of ['position', 'left', 'top', 'width', 'height', 'margin', 'pointer-events', 'z-index', 'display']) el.style.removeProperty(p);
        boxes.current.delete(el);
      }
    }

    // 2. Measure everything that stays, and move it from where it was.
    const view = root.getBoundingClientRect();
    const onScreen = (b: Box) => {
      const top = view.top + root.clientTop + b.y - root.scrollTop;
      return top + b.h > 0 && top < window.innerHeight;
    };
    const smooth = spring('smooth');
    let entering = 0;
    for (const el of kids) {
      if (el.dataset.flipPinned) continue;
      const box: Box = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
      const was = boxes.current.get(el);
      boxes.current.set(el, box);
      if (!animate) continue;

      if (!was) {
        if (!onScreen(box)) continue;
        const delay = Math.min(entering++ * stagger, maxStagger);
        el.animate(
          [{ opacity: 0, transform: 'translateY(10px) scale(0.97)' }, { opacity: 1, transform: 'none' }],
          { duration: smooth.duration, easing: smooth.easing, delay, fill: 'backwards' }
        );
        continue;
      }

      // Where it visibly is now: its old place plus whatever a running move had reached.
      const running = el.getAnimations().filter((a) => (a as Animation & { id: string }).id === 'flip-move');
      let tx = 0, ty = 0;
      if (running.length) {
        const m = new DOMMatrixReadOnly(getComputedStyle(el).transform === 'none' ? undefined : getComputedStyle(el).transform);
        tx = m.m41; ty = m.m42;
        for (const a of running) a.cancel();
      }
      const dx = was.x - box.x + tx;
      const dy = was.y - box.y + ty;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      if (!onScreen(box) && !onScreen({ ...box, x: box.x + dx, y: box.y + dy })) continue;
      const move = el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: smooth.duration, easing: smooth.easing }
      );
      move.id = 'flip-move';
    }
  });
}
