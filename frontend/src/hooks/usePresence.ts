import { useEffect, useReducer, useRef, useState, useLayoutEffect } from 'react';
import { prefersReducedMotion } from '../utils/motion/motion';

/** How long something takes to leave. Kept short: leaving is never the point. */
const EXIT_MS = 180;

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
    for (const entry of out) {
      if (!entry.exiting) {
        // Back before it finished leaving: stop the clock on it.
        const t = timers.current.get(entry.key);
        if (t) { clearTimeout(t); timers.current.delete(entry.key); }
        gone.current.delete(entry.key);
        continue;
      }
      if (timers.current.has(entry.key)) continue;
      timers.current.set(entry.key, setTimeout(() => {
        timers.current.delete(entry.key);
        gone.current.add(entry.key);
        bump();
      }, exitMs));
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
