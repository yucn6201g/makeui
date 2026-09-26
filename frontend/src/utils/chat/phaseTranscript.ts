/**
 * The run, reconstructed as a transcript of steps.
 *
 * The server reports only the *current* phase label plus a tail of what that phase
 * is writing, because the full document is far too large to carry on every poll.
 * That is enough to show what is happening right now, but not enough to show what
 * happened — and reading a long run means being able to look back at the step that
 * just scrolled past.
 *
 * So the client keeps the history the server does not: each time the phase label
 * changes, the previous entry is closed and a new one opened. What accumulates is
 * an ordered record of the run with each step's own reasoning attached to it.
 */

export interface PhaseEntry {
  /** Human-readable step name as the server labelled it. */
  label: string;
  /** Trailing slice of what this step wrote. */
  text: string;
  /**
   * Characters this step had produced when last observed.
   *
   * Kept even though the transcript now shows tokens instead, because this is
   * not only a display value: `splitStream` compares it against `TAIL_CHARS` to
   * decide whether a tail that shows no document boundary is nevertheless code.
   * Tokens cannot answer that — the question is literally how many characters
   * have scrolled past the transport window.
   */
  chars: number;
  /**
   * Tokens this step spent, derived by differencing the run's running total
   * across the step's boundaries.
   *
   * Undefined when the server sent no figure, which is different from zero: a
   * step that reported nothing shows nothing, rather than claiming to be free.
   */
  tokens?: number;
  /** The run's cumulative total when this step opened; the baseline for `tokens`. */
  tokensAtStart?: number;
  startedAt: number;
  /** Set when a later phase superseded this one. */
  endedAt?: number;
}

/**
 * Fold one poll result into the transcript.
 *
 * Returns the same array when nothing changed, so React can skip the re-render —
 * polls arrive every two seconds and most of them carry no new text.
 */
/**
 * What has been spent since a baseline, or undefined when that is not yet a
 * meaningful question.
 *
 * A difference of zero returns undefined rather than 0, for two reasons that
 * happen to agree. Nothing displays a zero — a step showing "0 tok" would claim
 * to be free when the truth is that its calls have not reported yet. And an
 * entry whose value flips `undefined → 0` on the first poll after it opens is a
 * change React would re-render for, on every step of every run, to show nothing
 * different.
 *
 * Negative differences clamp: a retried job writing an older total should not
 * produce "-800 tok".
 */
function spentSince(runTokens: number | undefined, baseline: number | undefined): number | undefined {
  if (runTokens === undefined || baseline === undefined) return undefined;
  const diff = runTokens - baseline;
  return diff > 0 ? diff : undefined;
}

export function appendPhase(
  prev: PhaseEntry[],
  label: string,
  text: string,
  chars: number,
  /**
   * The run's cumulative token total as of this poll, or undefined if the server
   * did not report one. Cumulative rather than per-step because that is what the
   * ledger can state honestly: it counts model calls for the whole run and does
   * not know which label was current when each one happened.
   */
  runTokens?: number,
  now: number = Date.now()
): PhaseEntry[] {
  if (!label) return prev;
  const last = prev[prev.length - 1];

  if (last && last.label === label) {
    // The baseline is claimed on the first poll that carries a figure, not when
    // the step opened: a step can open before any model call has reported, and
    // taking the total from the previous step then would credit this one with
    // the previous one's spend.
    const tokensAtStart = last.tokensAtStart ?? runTokens;
    const tokens = spentSince(runTokens, tokensAtStart) ?? last.tokens;
    // `tokensAtStart` belongs in this comparison even though it is never shown.
    // The poll that first carries a figure usually changes nothing else — same
    // text, same chars, and a difference of zero against itself — so leaving it
    // out returned `prev` and threw the baseline away, and the step then
    // measured from whatever total the NEXT step happened to start at.
    if (
      last.text === text &&
      last.chars === chars &&
      last.tokens === tokens &&
      last.tokensAtStart === tokensAtStart
    ) {
      return prev;
    }
    return [...prev.slice(0, -1), { ...last, text, chars, tokens, tokensAtStart }];
  }

  /**
   * A step's final figure is settled as it closes.
   *
   * The last poll of a step often arrives after the step's own model calls have
   * reported but before the label changes, so closing here — with the total that
   * was current at the moment of the change — is what makes the number stop
   * moving rather than keep absorbing the next step's spend.
   */
  const closed = last
    ? [
        ...prev.slice(0, -1),
        {
          ...last,
          endedAt: now,
          tokens: spentSince(runTokens, last.tokensAtStart) ?? last.tokens,
        },
      ]
    : [];
  return [...closed, { label, text, chars, tokensAtStart: runTokens, tokens: undefined, startedAt: now }];
}

/** Close the final entry when the run ends, so its duration stops climbing. */
export function closeTranscript(prev: PhaseEntry[], now: number = Date.now()): PhaseEntry[] {
  const last = prev[prev.length - 1];
  if (!last || last.endedAt) return prev;
  return [...prev.slice(0, -1), { ...last, endedAt: now }];
}

/** Where the prose plan ends and the emitted document begins. */
const DOC_START = /<!DOCTYPE html|<html[\s>]/i;

/**
 * Models wrap output in markdown fences even when told not to. The backend strips
 * them from the stored result, but the live stream is raw.
 */
export function stripFences(text: string): string {
  return text.replace(/^[ \t]*```[a-zA-Z]*[ \t]*$/gm, '').replace(/```[a-zA-Z]*/g, '');
}

interface SplitStream {
  /** Prose the model wrote before the document — its thinking for this step. */
  prose: string;
  /** The document itself, once it starts. */
  code: string;
  /** True once the document has begun, so the caller can latch it. */
  docStarted: boolean;
}

/**
 * How many trailing characters the server transports. Must match
 * STREAM_TAIL_CHARS in backend/src/services/job-service.ts.
 */
export const TAIL_CHARS = 6000;

/**
 * Separate a step's output into reasoning and emitted code.
 *
 * The hard part is that only a tail is transported. A step writes a few lines of
 * prose and then tens of thousands of characters of document, so within seconds
 * the `<!DOCTYPE html>` that marks the boundary has scrolled out of the window —
 * and a naive search then finds no document and renders raw markup as reasoning.
 *
 * Two things prevent that. `docStarted` latches once the boundary has been seen,
 * so later tails are known to be code. And when the total output already exceeds
 * the tail width, the prose (which is short and comes first) is necessarily gone,
 * so the tail is code whether or not we ever caught the boundary — this covers a
 * step whose first observed poll already arrived mid-document.
 */
export function splitStream(
  text: string,
  carriedProse: string,
  docStarted: boolean,
  chars: number
): SplitStream {
  const at = text.search(DOC_START);
  if (at !== -1) {
    return {
      prose: at > 0 ? stripFences(text.slice(0, at)).trim() || carriedProse : carriedProse,
      code: stripFences(text.slice(at)),
      docStarted: true,
    };
  }
  if (docStarted || chars > TAIL_CHARS) {
    return { prose: carriedProse, code: stripFences(text), docStarted: true };
  }
  return { prose: stripFences(text).trim() || carriedProse, code: '', docStarted: false };
}

export function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}秒`;
  return `${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒`;
}

/**
 * The transcript, small enough to keep on a message.
 *
 * A live entry holds up to TAIL_CHARS (6,000) of whatever the step was writing,
 * because that is what the running view scrolls. Storing that is a different
 * question: eight steps at six thousand characters is around 50KB per reply,
 * the thread is saved as one DynamoDB item, and the save path answers an
 * oversized item by halving the message list until it fits. So keeping the full
 * tails would quietly trade conversation history for code excerpts — and of the
 * two, the conversation is the one nobody can reconstruct.
 *
 * What survives is what the finished transcript actually shows: the steps, in
 * order, with their durations and token counts, and enough of the text to
 * recognise the step by. The head rather than the tail, because the prose a
 * step opens with is its reasoning and the end of the buffer is mid-token code.
 */
const STORED_TEXT_CHARS = 700;

/**
 * A stored transcript, read back.
 *
 * The round trip is JSON through DynamoDB and back, so what returns is
 * `unknown`: the thread could have been written by an older client, truncated by
 * the server's size handling, or simply be from a shape that has since changed.
 * Casting it would put whatever came back into `ReasoningTranscript`, which then
 * reads `.text` and `.startedAt` off it.
 *
 * Entries that do not carry the fields the transcript actually renders are
 * dropped rather than repaired — a step with no label and no timing is not a
 * step anyone can read, and inventing values for it would show a run that did
 * not happen.
 */
export function readStoredPhases(value: unknown): PhaseEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const phases = value.filter((p): p is PhaseEntry => {
    if (!p || typeof p !== 'object') return false;
    const e = p as Record<string, unknown>;
    return typeof e.label === 'string'
      && typeof e.text === 'string'
      && typeof e.chars === 'number'
      && typeof e.startedAt === 'number';
  });
  return phases.length > 0 ? phases : undefined;
}

export function trimPhasesForStorage(phases: PhaseEntry[]): PhaseEntry[] {
  return phases.map((p) =>
    p.text.length <= STORED_TEXT_CHARS ? p : { ...p, text: `${p.text.slice(0, STORED_TEXT_CHARS)}…` }
  );
}
