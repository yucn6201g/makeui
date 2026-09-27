import { useEffect, useReducer, useRef, useState, useLayoutEffect } from 'react';
import { prefersReducedMotion } from '../utils/motion/motion';

/** How long something takes to leave. Kept short: leaving is never the point. */
const EXIT_MS = 180;

/** More leaving and arriving than this at once is a change of list, not of items (as useFlip's BULK). */
const BULK_CHANGE = 6;

/**
 * Something that is shown and hidden, kept on screen long enough to leave.
 *
 * `open` is what the component wants; `mounted` is whether to render it, and
 * stays true for `exitMs` after `open` goes false so that a closing animation
 * (index.css, `[data-state="closing"]`) has something to play on. Opening again
 * during the exit simply keeps it.
 *
 * The switch to "closing" is made while rendering, not in an effect: an effect
 * would run after a commit in which the element had already been removed, and
 * the panel would blink out for a frame before its exit began.
 */
export function usePresence(open: boolean, exitMs = EXIT_MS) {
  const [lingering, setLingering] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    setLingering(!open && !prefersReducedMotion());
  }
  useEffect(() => {
    if (!lingering) return;
    const timer = setTimeout(() => setLingering(false), exitMs);
    return () => clearTimeout(timer);
  }, [lingering, exitMs]);
  const mounted = open || lingering;
  return { mounted, closing: !open && lingering, state: (open ? 'open' : 'closing') as 'open' | 'closing' };
}

interface PresenceEntry<T> {
  item: T;
  key: string;
  /** No longer in the list, and on its way out. */
  exiting: boolean;
}

/**
 * A list whose removed items stay for `exitMs`, flagged, where they were.
 *
 * Kept in their old place in the order — after the item that preceded them —
 * because React moves a node whose position among its siblings changes, and a
 * moved iframe reloads: a project card's thumbnail would go blank on its way
 * out. `useFlip` takes the flagged ones out of the flow and fades them.
 */
export function usePresenceList<T>(items: T[], keyOf: (item: T) => string, exitMs = EXIT_MS): PresenceEntry<T>[] {
  const committed = useRef<PresenceEntry<T>[]>([]);
  const gone = useRef(new Set<string>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const reduced = prefersReducedMotion();

  const out: PresenceEntry<T>[] = items.map((item) => ({ item, key: keyOf(item), exiting: false }));
  if (!reduced) {
    const present = new Set(out.map((e) => e.key));
    const prev = committed.current;
    /*
     * A change of the whole list — a tab, a filter, a page of results — has no
     * one card to watch leave: useFlip hides a bulk exit at once anyway. Kept
     * mounted for the exit, the old cards (each with a frame running its app)
     * were torn down one timer at a time, a commit of the whole grid per card.
     * Measured with 120 cards a tab: about 0.9 s of blocked main thread per
     * switch (2026-09-27). So a bulk change drops them in the same render.
     */
    const was = new Set(prev.map((e) => e.key));
    const newlyLeaving = prev.filter((e) => !e.exiting && !present.has(e.key) && !gone.current.has(e.key)).length;
    const arriving = out.filter((e) => !was.has(e.key)).length;
    if (newlyLeaving + arriving > BULK_CHANGE) {
      for (const e of prev) if (!present.has(e.key)) gone.current.add(e.key);
    }
    prev.forEach((entry, i) => {
      if (present.has(entry.key) || gone.current.has(entry.key)) return;
      // After the nearest earlier entry that is still in the list being built.
      let at = 0;
      for (let j = i - 1; j >= 0; j--) {
        const k = out.findIndex((e) => e.key === prev[j].key);
        if (k !== -1) { at = k + 1; break; }
      }
      out.splice(at, 0, { item: entry.item, key: entry.key, exiting: true });
    });
  }

  useLayoutEffect(() => {
    committed.current = out;
    const live = new Set(out.map((e) => e.key));
    // Everything that starts leaving in this commit leaves on one timer: one re-render, not one per card.
    const starting: string[] = [];
    for (const entry of out) {
      if (!entry.exiting) {
        // Back before it finished leaving: forget its place on the timer (which others may share).
        timers.current.delete(entry.key);
        gone.current.delete(entry.key);
        continue;
      }
      if (!timers.current.has(entry.key)) starting.push(entry.key);
    }
    if (starting.length) {
      const timer = setTimeout(() => {
        for (const key of starting) {
          if (timers.current.get(key) !== timer) continue;
          timers.current.delete(key);
          gone.current.add(key);
        }
        bump();
      }, exitMs);
      for (const key of starting) timers.current.set(key, timer);
    }
    // A key that has left the list entirely no longer needs remembering.
    for (const key of gone.current) if (!live.has(key)) gone.current.delete(key);
  });

  useEffect(() => () => {
    for (const t of timers.current.values()) clearTimeout(t);
    timers.current.clear();
  }, []);

  return out;
}
