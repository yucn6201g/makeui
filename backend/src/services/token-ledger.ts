import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from '../utils/logger.js';

/**
 * What a run actually spent, as reported by the models rather than guessed.
 *
 * The pipeline used to estimate: `Math.ceil(text.length / 4)` at a handful of
 * places, counting the *output document* and almost nothing else. Two failures
 * followed from that, and both matter now that the build modes exist to control
 * cost:
 *
 *   1. The four-agent design phase was not counted at all. `runDesignSwarm`
 *      returns a string, so the graph's usage metrics were discarded inside it.
 *      That is six model calls with large inputs, invisible.
 *   2. The repair passes counted the length of the document they produced and
 *      none of the input — which for a per-file repair is the whole project,
 *      once per file.
 *
 * So the stages 節約 and 高速 remove were the stages that were never billed, and
 * the usage a user saw barely moved between the cheapest mode and the dearest.
 * Measured: economy 65,943 "output tokens" against standard's 59,810 — the cheap
 * run appeared to cost *more*, because what was being measured was the size of
 * the HTML, not the work.
 *
 * The ledger is per-run and lives in AsyncLocalStorage rather than in a module
 * variable: the worker Lambda can have two jobs in one process, and a shared
 * counter would bill each of them for the other. Nothing has to be threaded
 * through the call sites, which is the reason the estimates were spread around
 * in the first place.
 */
/** One stage's share of a run. */
export interface StageUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from the prompt cache, billed at ~0.1x. */
  cacheReadTokens: number;
  /** Tokens written to the prompt cache, billed at ~1.25x for the 5-minute TTL. */
  cacheWriteTokens: number;
}

export interface TokenLedger {
  inputTokens: number;
  outputTokens: number;
  /** Model calls that reported real usage. */
  calls: number;
  /** Calls that returned no usage figures, so the total is a floor rather than a sum. */
  unreported: number;
  /**
   * The same totals, split by the stage that spent them.
   *
   * The run total answers "what did this cost" and nothing else, and the next
   * question is always "where did it go" — which nothing could answer, because
   * the job records that carry per-poll totals expire and the ledger kept one
   * number. Every estimate of where the input goes has been arithmetic over the
   * file count.
   *
   * It also carries the two cache columns, which are the only way to tell a
   * prompt cache that is working from one that is silently not: a prefix under
   * the model's minimum, or a byte that moved, produces no error and no warning
   * — just `cacheReadTokens: 0` forever.
   */
  stages: Record<string, StageUsage>;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * Told after every recorded call, so a job can publish its running total.
   *
   * The progress transcript prices each step by differencing the total at step
   * boundaries, and the total reached the job record only when a step streamed
   * text or opened. A step of non-streaming calls — the per-file repairs, the
   * critic — therefore priced at nothing, and the last step of a run, which no
   * later step closes, never did.
   */
  onRecord?: () => void;
}

const storage = new AsyncLocalStorage<TokenLedger>();

export function newLedger(): TokenLedger {
  return {
    inputTokens: 0,
    outputTokens: 0,
    calls: 0,
    unreported: 0,
    stages: {},
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

/** Runs `fn` with a fresh ledger that every nested model call reports into. */
export async function withTokenLedger<T>(fn: (ledger: TokenLedger) => Promise<T>): Promise<T> {
  const ledger = newLedger();
  return storage.run(ledger, () => fn(ledger));
}

/**
 * Adds one call's real usage.
 *
 * Silent outside a ledger scope on purpose: `scoreHtml` and the other exported
 * helpers are called from tests and from the API Lambda, and neither should have
 * to establish a billing context to run a pure function.
 */
export function recordTokens(
  inputTokens: number,
  outputTokens: number,
  where = 'unattributed',
  cache?: { read?: number; write?: number }
): void {
  const ledger = storage.getStore();
  if (!ledger) return;
  const read = cache?.read ?? 0;
  const write = cache?.write ?? 0;
  ledger.inputTokens += inputTokens;
  ledger.outputTokens += outputTokens;
  ledger.cacheReadTokens += read;
  ledger.cacheWriteTokens += write;
  ledger.calls += 1;
  const stage = (ledger.stages[where] ??= {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  stage.calls += 1;
  stage.inputTokens += inputTokens;
  stage.outputTokens += outputTokens;
  stage.cacheReadTokens += read;
  stage.cacheWriteTokens += write;
  try {
    ledger.onRecord?.();
  } catch {
    // A progress figure is never worth failing the call it describes.
  }
}

/**
 * What a run spent, per stage, as one log line.
 *
 * Written at the end of a run rather than per call: thirty-odd calls of
 * bookkeeping is a log nobody reads, and the question this exists for — which
 * stage holds the input, and is the cache being read — is a question about the
 * run, not about any one call.
 */
export function logLedger(ledger: TokenLedger, context: Record<string, unknown> = {}): void {
  const total = ledger.inputTokens + ledger.outputTokens;
  const stages = Object.entries(ledger.stages)
    .sort((a, b) => b[1].inputTokens + b[1].outputTokens - (a[1].inputTokens + a[1].outputTokens))
    .map(([name, s]) => ({
      stage: name,
      calls: s.calls,
      in: s.inputTokens,
      out: s.outputTokens,
      cacheRead: s.cacheReadTokens,
      cacheWrite: s.cacheWriteTokens,
      pct: total > 0 ? Math.round(((s.inputTokens + s.outputTokens) / total) * 100) : 0,
    }));
  /**
   * What was actually processed, which stopped being `total` the day caching
   * shipped.
   *
   * `input_tokens` counts the input that was NOT served from cache — the two
   * cache counters are separate, and `total` is input + output. So the moment a
   * breakpoint starts working, tokens leave `total` without leaving the request,
   * and a run compared against a pre-caching baseline reads as an improvement it
   * did not make. Measured on the first run after: 227,332 total against 275,267
   * processed, a 48,000-token difference that is entirely bookkeeping.
   *
   * Both are logged. `total` keeps its meaning so the seventeen runs recorded
   * before this stay comparable with each other; `processed` is the one to
   * compare across the change.
   */
  const processed = total + ledger.cacheReadTokens + ledger.cacheWriteTokens
  logger.info('Token ledger', {
    ...context,
    total,
    processed,
    input: ledger.inputTokens,
    output: ledger.outputTokens,
    calls: ledger.calls,
    unreported: ledger.unreported,
    cacheRead: ledger.cacheReadTokens,
    cacheWrite: ledger.cacheWriteTokens,
    stages,
  });
}

/**
 * What this run has spent so far, or null outside a ledger scope.
 *
 * Exposed so the progress writer can stamp each poll with the running total.
 * The transcript then shows what a step cost by differencing the totals at its
 * boundaries — which is the only way to attribute spend to a step without
 * threading a counter through every call site, the very thing this ledger exists
 * to avoid.
 *
 * Returns a copy: the caller must not be able to alter the run's billing by
 * holding on to it.
 */
export function currentUsage(): { inputTokens: number; outputTokens: number; unreported: number } | null {
  const ledger = storage.getStore();
  if (!ledger) return null;
  return {
    inputTokens: ledger.inputTokens,
    outputTokens: ledger.outputTokens,
    unreported: ledger.unreported,
  };
}

/**
 * Notes a call that produced no usage figures.
 *
 * Counted rather than estimated. A guess mixed into a total of real numbers is
 * worse than a gap, because nothing downstream can tell which is which — and the
 * gap being visible is what would have caught the missing design phase years
 * earlier than a user's cost report did.
 */
export function recordUnreportedCall(where: string): void {
  const ledger = storage.getStore();
  if (!ledger) return;
  ledger.unreported += 1;
  logger.info('Model call reported no token usage', { where });
}

/**
 * Pulls usage out of whatever a Strands SDK result happens to be.
 *
 * The SDK reports through several shapes depending on the primitive used — an
 * Agent result carries `metrics.accumulatedUsage`, a Graph or Swarm result
 * carries `usage` — and the field names are camelCase there against the
 * snake_case Bedrock uses on the wire. Returns null when nothing is recognised,
 * so the caller records a gap instead of a zero.
 */
export function usageFromStrandsResult(result: unknown): { inputTokens: number; outputTokens: number } | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, any>;
  const accumulated = r.metrics?.accumulatedUsage;
  if (accumulated && typeof accumulated.inputTokens === 'number') {
    return { inputTokens: accumulated.inputTokens, outputTokens: accumulated.outputTokens ?? 0 };
  }
  if (r.usage && typeof r.usage.inputTokens === 'number') {
    return { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens ?? 0 };
  }
  return null;
}
