import { useLayoutEffect, useRef } from 'react';
import { prefersReducedMotion } from '../utils/motion';

/**
 * The thumb of a segmented control, or the underline of a tab row, as one
 * element that travels to whichever item is chosen.
 *
 * Drawn behind the items rather than on the chosen one, which is what lets it
 * move: an active item that paints its own background can only reappear
 * somewhere else. The parent gets `motion-track` (positioned, and its items
 * lifted above the thumb) and the chosen item keeps its `--on`/`--active` class
 * for its text colour, while the motion section of index.css takes the fill
 * away from it and gives it to this.
 *
 * Positioned from layout offsets, not from bounding boxes: the item under the
 * pointer is being scaled by the press feedback at the moment it is chosen, and
 * a measured box would carry that scale into the thumb.
 */
export type IndicatorVariant = 'pill' | 'underline' | 'rail';

interface SlidingIndicatorProps {
  /** Whatever identifies the chosen item. The thumb moves when this changes. */
  active: unknown;
  variant?: IndicatorVariant;
  /** How the chosen item is found among the parent's descendants. */
  selector?: string;
  className?: string;
}

const CHOSEN = '[aria-selected="true"], [aria-pressed="true"]';

/** `el`'s layout box inside `track`, unaffected by transforms or scrolling. */
function boxWithin(el: HTMLElement, track: HTMLElement) {
  let x = 0, y = 0;
  let node: HTMLElement | null = el;
  while (node && node !== track) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  if (node !== track) {
    // Not an offset descendant — fall back to boxes, which is right unless scaled.
    const a = el.getBoundingClientRect(), b = track.getBoundingClientRect();
    return { x: a.left - b.left - track.clientLeft + track.scrollLeft, y: a.top - b.top - track.clientTop + track.scrollTop, w: a.width, h: a.height };
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

export function SlidingIndicator({ active, variant = 'pill', selector = CHOSEN, className }: SlidingIndicatorProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);

  useLayoutEffect(() => {
    const thumb = ref.current;
    const track = thumb?.parentElement;
    if (!thumb || !track) return;

    const place = () => {
      const target = track.querySelector<HTMLElement>(selector);
      if (!target || target.offsetWidth === 0) {
        thumb.style.opacity = '0';
        placed.current = false;
        return;
      }
      const { x, y, w, h } = boxWithin(target, track);
      const jump = !placed.current || prefersReducedMotion();
      if (jump) thumb.style.transition = 'none';
      thumb.style.width = `${w}px`;
      thumb.style.height = `${h}px`;
      thumb.style.transform = `translate(${x}px, ${y}px)`;
      thumb.style.opacity = '1';
      if (jump) {
        // Commit the position before transitions come back, or they animate from 0,0.
        void thumb.offsetWidth;
        thumb.style.transition = '';
      }
      placed.current = true;
    };

    place();
    /*
     * A count arriving in a tab, a font finishing loading, the window being
     * resized: the chosen item changes size without anything being chosen, and
     * the thumb follows it.
     */
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => place()) : null;
    if (ro) {
      ro.observe(track);
      for (const child of Array.from(track.children)) if (child !== thumb) ro.observe(child);
    }
    return () => ro?.disconnect();
  }, [active, selector]);

  return (
    <span
      ref={ref}
      className={`motion-indicator motion-indicator--${variant}${className ? ` ${className}` : ''}`}
      aria-hidden="true"
    />
  );
}
