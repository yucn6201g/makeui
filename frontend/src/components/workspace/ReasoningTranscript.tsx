import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatElapsed, splitStream, type PhaseEntry } from '../../utils/chat/phaseTranscript';

interface ReasoningTranscriptProps {
  phases: PhaseEntry[];
  /** False once the run finished, so the active entry stops ticking. */
  isActive: boolean;
  /** Compact variant for the preview overlay, where space is tighter. */
  dense?: boolean;
}

/** Treat the code view as "following" while within this many px of the bottom. */
const STICK_THRESHOLD_PX = 24;

/**
 * The run as a chronological transcript, in the shape a coding agent uses.
 *
 * The display this replaces was a fixed list of step dots with one shared box of
 * live text underneath. It answered "which stage is it in" but not "what did it
 * decide" — the moment a step ended, everything it had reasoned about scrolled
 * away and there was no way back to it.
 *
 * Here each step is its own entry that keeps its own reasoning. Finished steps
 * collapse to a line with their duration and can be reopened; the running one is
 * expanded, and its emitted code scrolls in a bounded pane so the entries above
 * it stay on screen.
 */
export function ReasoningTranscript({ phases, isActive, dense = false }: ReasoningTranscriptProps) {
  // Ticks the running entry's duration. One timer for the whole card.
  const [, setNow] = useState(Date.now());
  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isActive]);

  // Explicit user choices only. Absent means "follow the default": open while
  // running, closed once finished.
  const [overrides, setOverrides] = useState<Record<number, boolean>>({});
  const toggle = useCallback((i: number, fallback: boolean) => {
    setOverrides((prev) => ({ ...prev, [i]: !(prev[i] ?? fallback) }));
  }, []);

  /**
   * Prose captured while it was still inside the transported tail.
   *
   * Only the last few KB of a step's output travels on each poll, so once a step
   * is well into a large document its opening prose has scrolled out of the
   * window. Holding it here keeps the step's reasoning readable for the whole run.
   */
  const proseRef = useRef<string[]>([]);
  /**
   * Whether each step's output has reached the document. Latched, because the
   * `<!DOCTYPE html>` that marks the boundary scrolls out of the transported tail
   * within seconds — without this the panel starts rendering raw markup as if it
   * were the model's reasoning.
   */
  const docStartedRef = useRef<boolean[]>([]);

  if (phases.length === 0) return null;

  return (
    <ol className={`rt${dense ? ' rt--dense' : ''}`}>
      {phases.map((p, i) => {
        const running = isActive && !p.endedAt && i === phases.length - 1;
        const done = Boolean(p.endedAt) || (!isActive && i === phases.length - 1);
        const carried = proseRef.current[i] ?? '';
        const { prose, code, docStarted } = splitStream(
          p.text,
          carried,
          docStartedRef.current[i] ?? false,
          p.chars
        );
        if (prose && prose !== carried) proseRef.current[i] = prose;
        if (docStarted) docStartedRef.current[i] = true;

        const openByDefault = running;
        const open = overrides[i] ?? openByDefault;
        const hasBody = Boolean(prose || code);
        const elapsed = (p.endedAt ?? Date.now()) - p.startedAt;

        return (
          <li key={`${i}-${p.label}`} className={`rt__step rt__step--${running ? 'running' : done ? 'done' : 'idle'}`}>
            <button
              type="button"
              className="rt__row"
              onClick={() => hasBody && toggle(i, openByDefault)}
              aria-expanded={hasBody ? open : undefined}
              disabled={!hasBody}
            >
              <span className="rt__marker" aria-hidden="true" />
              <span className="rt__label">{p.label}</span>
              <span className="rt__meta">
                {/* Tokens, not characters. Characters measured how much text a
                    step emitted, which says nothing about what it cost: a step
                    that reads a large document and writes one line is expensive
                    and looked free. Absent rather than zero when the run
                    reported no figure — see PhaseEntry.tokens. */}
                {p.tokens !== undefined && p.tokens > 0 && (
                  <span className="rt__tokens" title="このステップで消費したトークン数">
                    {p.tokens.toLocaleString()} tok
                  </span>
                )}
                <span className="rt__elapsed">{formatElapsed(elapsed)}</span>
              </span>
              {hasBody && (
                <span className={`rt__caret${open ? ' rt__caret--open' : ''}`} aria-hidden="true">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </span>
              )}
            </button>
            {hasBody && open && (
              /*
                One scroller for the step, not one per half.

                Prose and code were each a bounded, self-scrolling pane, so a step
                that emitted both — reasoning, then the file it decided to write —
                showed two scrollbars stacked inside one card, and following the
                output meant knowing which of them was moving. Reported as
                「スクロールバーが2つあってややこしい」. They are now two blocks inside
                a single pane that scrolls once.
              */
              <Tail className="rt__body" live={running} watch={`${prose.length}:${code.length}`}>
                {prose && <div className="rt__prose">{prose}</div>}
                {code && <div className="rt__code">{code}</div>}
              </Tail>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * A step's output, bounded and self-scrolling.
 *
 * Both halves of a step's body get this, and for the same reason: letting either
 * grow pushes the rest of the transcript off screen. Only the emitted document
 * used to have it, which made the behaviour look like a property of code —
 * 「コンテンツを作成中」 scrolled in place while 「画面構成を設計中」 filled the
 * thread, because that step emits reasoning rather than a document and the prose
 * was rendered as an unbounded paragraph.
 *
 * Pins to the bottom while new text arrives and releases as soon as the reader
 * scrolls up, so following the stream and reading back through it are both
 * possible without a control to switch between them.
 *
 * A `div` for both: `.rt__code` already declares the monospace family and
 * `pre-wrap` that a `<pre>` would have brought, so the element carried no
 * meaning the class was not already carrying.
 */
function Tail({
  className,
  live,
  watch,
  children,
}: {
  className: string;
  live: boolean;
  /** Changes whenever the content does, which is when the pane has to catch up. */
  watch: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX;
  }, []);

  // Layout effect so the jump lands in the same frame as the text, rather than
  // one frame later where it reads as a flicker.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && live && followRef.current) el.scrollTop = el.scrollHeight;
  }, [watch, live]);

  return (
    <div className={className} ref={ref} onScroll={onScroll} data-testid={className.replace('rt__', 'rt-')}>
      {children}
    </div>
  );
}
