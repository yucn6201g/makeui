import { prefersReducedMotion, pressScale, spring } from './motion';

/**
 * Everything that can be pressed sinks a little under the finger and springs
 * back when let go.
 *
 * One listener on the document rather than a class on every control: there
 * are a few hundred buttons in this app, spread over twenty components, and a
 * control added next month should behave like the rest without anyone
 * remembering to opt it in.
 *
 * Animates the `scale` property, not `transform`. The two compose, so a
 * control that is positioned or rotated by its transform — a chevron, a
 * centred badge, a card mid-way through a layout move — keeps it.
 */
const hasSelector = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('selector(:has(a))');
const PRESSABLE = [
  'button',
  '[role="button"]',
  '[role="tab"]',
  '[role="checkbox"][tabindex]',
  '[role="option"]',
  'summary',
  'a[href]',
  // A checkbox's label is what gets pressed. Left out where `:has` would throw.
  ...(hasSelector ? ['label:has(> input[type="checkbox"])'] : []),
].join(', ');

const DOWN_MS = 110;

let installed = false;

export function installPressFeedback(doc: Document = document): void {
  if (installed || typeof doc.addEventListener !== 'function') return;
  installed = true;

  doc.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0 || prefersReducedMotion()) return;
    const el = (e.target as Element | null)?.closest?.(PRESSABLE) as HTMLElement | null;
    if (!el || typeof el.animate !== 'function') return;
    if (el.matches(':disabled, [aria-disabled="true"]') || el.closest('[data-no-press]')) return;

    const { width, height } = el.getBoundingClientRect();
    const to = pressScale(width, height);
    for (const a of el.getAnimations()) if ((a as Animation).id === 'press') a.cancel();
    const down = el.animate([{ scale: '1' }, { scale: String(to) }], {
      duration: DOWN_MS, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'forwards',
    });
    down.id = 'press';

    const release = () => {
      doc.removeEventListener('pointerup', release, true);
      doc.removeEventListener('pointercancel', release, true);
      // From wherever the press had got to, so a quick tap does not snap.
      const from = getComputedStyle(el).scale;
      down.cancel();
      const { easing, duration } = spring('bouncy');
      const up = el.animate([{ scale: from === 'none' ? String(to) : from }, { scale: '1' }], { duration, easing });
      up.id = 'press';
    };
    doc.addEventListener('pointerup', release, true);
    doc.addEventListener('pointercancel', release, true);
  }, { capture: true, passive: true });
}
