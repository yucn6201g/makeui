/**
 * How MakeUI moves.
 *
 * The feel people call iOS-like is mostly two things: motion that follows a
 * spring rather than a fixed curve, and nothing that jumps — a thumb that
 * slides to the chosen segment instead of reappearing there, cards that travel
 * to their new places instead of being redrawn in them, panels that grow out
 * of the button that opened them and shrink back into it.
 *
 * The springs are described the way SwiftUI describes them — a response (the
 * period of the undamped oscillation, in seconds) and a damping fraction (1 is
 * no overshoot) — and turned into a CSS `linear()` easing by sampling the
 * spring's position over time. The same strings are written into index.css as
 * tokens; motion.test.mjs keeps the two identical.
 */

interface Spring {
  /** Period of the undamped oscillation, in seconds. Lower is quicker. */
  response: number;
  /** 1 settles without overshoot; below 1 overshoots a little and comes back. */
  damping: number;
}

/** The springs the app uses. */
export const SPRINGS = {
  /** Things that travel: panels opening, popovers. No overshoot. */
  smooth: { response: 0.42, damping: 1 },
  /** Cards finding their new places — many at once, so over sooner. No overshoot. */
  quick: { response: 0.3, damping: 1 },
  /** Selection thumbs and underlines: quick, with the slightest settle. */
  snappy: { response: 0.36, damping: 0.82 },
  /** Small things that should feel alive: a star being set, a press released. */
  bouncy: { response: 0.4, damping: 0.62 },
} as const satisfies Record<string, Spring>;

type SpringName = keyof typeof SPRINGS;

/** Where a spring released from 0 is at time `t` (seconds), heading for 1. */
export function springPosition({ response, damping }: Spring, t: number): number {
  const w0 = (2 * Math.PI) / response;
  if (damping >= 1) {
    // Critically damped (over-damping is treated as critical: it only slows the tail).
    return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  }
  const wd = w0 * Math.sqrt(1 - damping * damping);
  const decay = Math.exp(-damping * w0 * t);
  return 1 - decay * (Math.cos(wd * t) + ((damping * w0) / wd) * Math.sin(wd * t));
}

/**
 * How long the spring takes to come to rest, in milliseconds: the first moment
 * after which it never again strays more than `tolerance` from 1.
 */
function springDuration(spring: Spring, tolerance = 0.002): number {
  const step = 1 / 240;
  let settledAt = 0;
  for (let t = 0; t < 3; t += step) {
    if (Math.abs(1 - springPosition(spring, t)) > tolerance) settledAt = t + step;
  }
  return Math.round(settledAt * 1000);
}

/**
 * The spring as a CSS `linear()` easing, over its own duration.
 *
 * Sampled evenly. Forty points is past the point where more are visible at any
 * duration these springs have, and short enough to write into a stylesheet.
 */
export function springEasing(spring: Spring, points = 40): { easing: string; duration: number } {
  const duration = springDuration(spring);
  const stops: string[] = [];
  for (let i = 0; i <= points; i++) {
    const t = (i / points) * (duration / 1000);
    const x = i === points ? 1 : springPosition(spring, t);
    stops.push(String(Math.round(x * 10000) / 10000));
  }
  return { easing: `linear(${stops.join(', ')})`, duration };
}

/** Whether this person has asked their system for less motion. */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/*
 * `linear()` shipped in every current engine in 2023; an older one would reject
 * the whole animation, so the fallback is a curve with the same character.
 */
let linearSupport: boolean | null = null;
function supportsLinear(): boolean {
  if (linearSupport === null) {
    linearSupport = typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
      && CSS.supports('transition-timing-function', 'linear(0, 1)');
  }
  return linearSupport;
}

const FALLBACK: Record<SpringName, string> = {
  smooth: 'cubic-bezier(0.22, 1, 0.36, 1)',
  quick: 'cubic-bezier(0.22, 1, 0.36, 1)',
  snappy: 'cubic-bezier(0.3, 1.15, 0.5, 1)',
  bouncy: 'cubic-bezier(0.34, 1.5, 0.64, 1)',
};

const cache = new Map<SpringName, { easing: string; duration: number }>();

/** Timing for a Web Animations call that moves on the named spring. */
export function spring(name: SpringName): { easing: string; duration: number } {
  let hit = cache.get(name);
  if (!hit) {
    const exact = springEasing(SPRINGS[name]);
    hit = supportsLinear() ? exact : { easing: FALLBACK[name], duration: exact.duration };
    cache.set(name, hit);
  }
  return hit;
}

/**
 * How far a control sinks when pressed.
 *
 * A fixed factor shrinks a card by eleven pixels and an icon by one, so the
 * factor is derived from a travel instead: every edge comes in about two and a
 * half pixels, within the range where a large surface still reads as pressed
 * and a small one does not vanish into itself.
 */
export function pressScale(width: number, height: number): number {
  const side = Math.max(width, height, 1);
  const s = 1 - 5 / side;
  return Math.round(Math.min(0.985, Math.max(0.94, s)) * 1000) / 1000;
}
