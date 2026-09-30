import { startTransition, useCallback, useEffect, useState } from 'react';

/** A card's footprint in the project grid, roughly: 220px wide plus the gap, and its height. */
const CARD_W = 236;
const CARD_H = 250;

/**
 * Cards drawn with each step: the rows a screen shows, and one more.
 * At least a dozen, so a narrow window still has something to scroll through.
 */
export function chunkForScreen(width = window.innerWidth, height = window.innerHeight): number {
  const cols = Math.max(1, Math.floor(width / CARD_W));
  const rows = Math.ceil(height / CARD_H) + 1;
  return Math.min(60, Math.max(12, cols * rows));
}

/**
 * How many of a long list to draw: a screenful, and more as the end comes near.
 *
 * A tab or a filter drew every card of the new list in one commit — 150 cards,
 * each a subtree with a thumbnail holder and an observer — which profiled at a
 * single task of about 150 ms (2026-09-27), during which the tab's underline
 * stood still and a click waited. Leaving that tab then tore all 150 down in
 * another. Only a screenful can be seen at once, so that is what is drawn; a
 * marker after the last card (`sentinel`) asks for the next screenful when it
 * comes within a screen of the viewport, as a transition.
 *
 * Starts again from one screenful whenever `resetKey` changes identity — the
 * caller passes what the list is a view OF, not the items, so a list that
 * merely gains a project is not cut back.
 */
/** Table rows drawn per step: a few screens of them, which is still one short commit. */
export const ROW_CHUNK = 60;

export function useProgressiveCount(
  total: number,
  resetKey: unknown,
  /** A fixed step, for rows; cards size theirs from the screen. */
  step?: number,
): { count: number; sentinel: (el: Element | null) => void } {
  const [chunk] = useState(() => step ?? (typeof window === 'undefined' ? 24 : chunkForScreen()));
  const [state, setState] = useState({ key: resetKey, count: chunk });
  let count = state.count;
  if (state.key !== resetKey) {
    // Adjusted while rendering, so the new view never draws its whole list first.
    count = chunk;
    setState({ key: resetKey, count });
  }

  const [marker, setMarker] = useState<Element | null>(null);
  const sentinel = useCallback((el: Element | null) => setMarker(el), []);

  useEffect(() => {
    if (count >= total || !marker) return;
    const grow = () =>
      startTransition(() =>
        setState((s) => (s.key === resetKey ? { key: s.key, count: s.count + chunk } : s))
      );
    if (typeof IntersectionObserver === 'undefined') {
      grow();
      return;
    }
    // Observed afresh after each step, so a marker still in range asks again.
    const observer = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) { observer.disconnect(); grow(); } },
      { rootMargin: '100% 0px' }
    );
    observer.observe(marker);
    return () => observer.disconnect();
  }, [count, total, resetKey, marker, chunk]);

  return { count: Math.min(count, total), sentinel };
}
