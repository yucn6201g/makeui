import { generatingCaption } from '../../utils/chat/generatingCaption';
import type { PhaseEntry } from '../../utils/chat/phaseTranscript';

interface GeneratingCanvasProps {
  phases: PhaseEntry[];
  /** Modify runs say something different from first generations. */
  mode?: 'generate' | 'modify';
}

/**
 * The preview while there is nothing to preview yet.
 *
 * A spinner would say "wait"; this says "a screen is being built", which is what
 * is actually happening. So the placeholder is a wireframe of the thing being
 * made — a bar, a nav, a hero, cards, rows — assembling itself in the order a
 * layout gets decided, with a sheen passing over it to keep it alive during the
 * minutes a real run takes.
 *
 * The blocks are deliberately generic. They are not a prediction of the layout:
 * the run has not decided one yet, and a skeleton that mimicked a specific
 * result would be wrong most of the time and would read as a promise the output
 * then broke.
 *
 * Everything here is decoration and is hidden from assistive technology; the
 * caption carries the state, and it is a live region so a screen reader hears
 * the step change rather than a silent animation.
 */
export function GeneratingCanvas({ phases, mode = 'generate' }: GeneratingCanvasProps) {
  const { title, detail } = generatingCaption(phases);
  const heading = mode === 'modify' && phases.length === 0 ? 'UIを修正しています' : title;

  return (
    <div className="generating" data-testid="generating-canvas">
      <div className="generating__canvas" aria-hidden="true">
        {/* The order is the order a layout is decided in, so the stagger reads
            as construction rather than as a random shimmer. */}
        <div className="generating__bar" style={{ ['--i' as string]: 0 }}>
          <span className="generating__dot" />
          <span className="generating__dot" />
          <span className="generating__dot" />
          <span className="generating__bar-title" />
        </div>

        <div className="generating__body">
          <div className="generating__nav">
            {[0, 1, 2, 3].map((n) => (
              <span key={n} className="generating__nav-row" style={{ ['--i' as string]: 1 + n * 0.15 }} />
            ))}
          </div>

          <div className="generating__main">
            <div className="generating__hero" style={{ ['--i' as string]: 1.2 }} />
            <div className="generating__cards">
              {[0, 1, 2].map((n) => (
                <div key={n} className="generating__card" style={{ ['--i' as string]: 1.8 + n * 0.18 }}>
                  <span className="generating__card-thumb" />
                  <span className="generating__line generating__line--80" />
                  <span className="generating__line generating__line--55" />
                </div>
              ))}
            </div>
            <div className="generating__rows">
              {[0, 1, 2].map((n) => (
                <div key={n} className="generating__row" style={{ ['--i' as string]: 2.6 + n * 0.15 }}>
                  <span className="generating__line generating__line--40" />
                  <span className="generating__line generating__line--20" />
                </div>
              ))}
            </div>
          </div>
        </div>

        <span className="generating__sheen" />
      </div>

      <p className="generating__caption" role="status" aria-live="polite">
        <span className="generating__spinner" aria-hidden="true" />
        <span className="generating__caption-title">{heading}</span>
        {detail && <span className="generating__caption-detail">{detail}</span>}
      </p>
    </div>
  );
}
