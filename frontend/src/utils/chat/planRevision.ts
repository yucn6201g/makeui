import type { PlanRevision } from '../../hooks/usePlan';

/**
 * The proposal a plan-mode message is answering, if it is answering one.
 *
 * A message sent in plan mode right after a proposal — 「画面をもう1つ増やして」
 * — is a change to that proposal. It used to be planned as a brief of its own:
 * the proposal was not sent, the design phase ran again from nothing, and the
 * result was a plan for "add a screen" to no product, at the cost of a
 * generation's design phase (about 42,000 tokens).
 *
 * Only when the proposal is the last thing the assistant said. Anything after
 * it — a build, an edit, an error — means the conversation moved on, and an old
 * proposal is not what the user is talking about.
 */
export function proposalBeingAnswered(
  messages: readonly { role: string; proposal?: { plan: string; spec: string; prompt: string } }[]
): PlanRevision | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const p = m.proposal;
    return p && p.spec.trim() ? { spec: p.spec, plan: p.plan, prompt: p.prompt } : undefined;
  }
  return undefined;
}
