/**
 * The system prompt, split into the part worth caching and the part that is not.
 *
 * Bedrock bills a cached prefix at about a tenth, and writing one at about
 * 1.25×. That arithmetic is the whole of the design here: a breakpoint pays only
 * when the same bytes are sent again, so putting one after a prompt that differs
 * every call is not a smaller bill, it is a larger one.
 *
 * Two rules follow, and both are enforced below rather than left to call sites.
 *
 * The cached part must be a PREFIX. Bedrock matches from the first byte, so a
 * block that varies — a file path, a role, an attached image's description —
 * placed ahead of the invariant contract makes the invariant contract
 * uncacheable. `where` is not enough to know this; only the call site is, which
 * is why the split is a parameter rather than something guessed here.
 *
 * And it must be long enough. The minimum cacheable prefix is around a thousand
 * tokens on the larger models and roughly twice that on Haiku, which is the
 * model most MakeUI runs use. Below it the breakpoint is IGNORED — no error, no
 * warning, and `cacheReadTokens` stays zero forever while the writes are still
 * billed. So a prefix under the floor is sent as a plain string instead, and the
 * floor is deliberately the higher of the two: a breakpoint that works on Sonnet
 * and silently does nothing on Haiku is the worst of the three outcomes,
 * because the measurement it produces is "caching does not help here".
 */

/**
 * Characters, not tokens — this runs before any tokenizer is available.
 *
 * 3.2 characters per token is measured on this codebase's own prompts, which are
 * a mix of English contract prose and Japanese instruction. English alone runs
 * nearer 4 and Japanese nearer 1.5, so the ratio is deliberately the pessimistic
 * end of that range: over-estimating tokens would let a prefix under the floor
 * through, which is the failure that produces no signal.
 */
const CHARS_PER_TOKEN = 3.2;

/** Haiku's floor, applied to every model. See the note above. */
const MIN_CACHEABLE_TOKENS = 2048;

/** Rounded up: a length is a whole number of characters, and `repeat` truncates. */
export const MIN_CACHEABLE_CHARS = Math.ceil(MIN_CACHEABLE_TOKENS * CHARS_PER_TOKEN);

/** A system prompt, and where its invariant prefix ends. */
export interface SystemPrompt {
  /** Invariant for this (framework, preset). Cached when long enough. */
  cached: string;
  /** Whatever varies per call. May be empty. */
  tail?: string;
}

/** Whether a prefix is long enough that Bedrock will actually cache it. */
export function worthCaching(prefix: string): boolean {
  return prefix.length >= MIN_CACHEABLE_CHARS;
}

/**
 * The `system` field of an Anthropic-on-Bedrock request body.
 *
 * A plain string when there is nothing to gain — which is also the shape every
 * call site had before this existed, so an un-split prompt behaves exactly as it
 * did.
 */
export function systemField(prompt: string | SystemPrompt): unknown {
  if (typeof prompt === 'string') return prompt;
  const tail = prompt.tail ?? '';
  if (!worthCaching(prompt.cached)) return prompt.cached + tail;
  const blocks: Record<string, unknown>[] = [
    { type: 'text', text: prompt.cached, cache_control: { type: 'ephemeral' } },
  ];
  if (tail) blocks.push({ type: 'text', text: tail });
  return blocks;
}

/** The whole prompt as one string, for logging and for length checks. */
export function fullText(prompt: string | SystemPrompt): string {
  return typeof prompt === 'string' ? prompt : prompt.cached + (prompt.tail ?? '');
}
