import crypto from 'node:crypto';
import {
  BedrockAgentCoreClient,
  RetrieveMemoryRecordsCommand,
  BatchCreateMemoryRecordsCommand,
  BatchDeleteMemoryRecordsCommand,
  ListMemoryRecordsCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { getAgentCoreConfig, getParameter } from '../config/agentcore-config.js';
import { logger } from '../utils/logger.js';

/**
 * AgentCore Memory: what this user's designs actually looked like.
 *
 * The memory resource declares its namespace template as
 * `/strategies/{memoryStrategyId}/actors/{actorId}/`, and records written
 * outside it are invisible to retrieval — so the namespace is built from the
 * strategy id rather than hand-written.
 *
 * A record is a design-decision summary (see `summariseDesignDecisions`), not
 * free text. Treating it as structured data is what makes the three things
 * below possible: rejecting records that carry no decision, collapsing repeats
 * of the same decision, and keeping the store bounded.
 */

const client = new BedrockAgentCoreClient({
  region: process.env.AWS_REGION || 'ap-northeast-1',
});

/** Records handed to the design phase. Each one costs prompt budget. */
const RETRIEVE_LIMIT = 3;
/** Over-fetch, because filtering happens after the search. */
const RETRIEVE_TOPK = 12;
/** Records kept per user. Beyond this the oldest are dropped. */
const KEEP_PER_ACTOR = 20;
/**
 * Below this, a hit is not a preference — it is the nearest of whatever the user
 * happens to have stored.
 *
 * Measured against the live store: the same prompt scores 0.58-0.65, the same
 * domain 0.48-0.52, and an unrelated product 0.37-0.44. Taking the top 3
 * unconditionally meant a coffee shop's design was told the user "prefers" the
 * palette of their expense-report screen, purely because nothing closer existed.
 */
const MIN_SCORE = 0.45;

export interface MemoryResult {
  content: string;
  score: number;
  namespace: string;
}

export interface DesignMemory {
  recordId: string;
  createdAt: number;
  text: string;
  /** The preset in force when this design was made; `none` when there was none. */
  preset: string;
  /**
   * Identity of the *design decision*, independent of which product it was made
   * for. Two records with the same signature say the same thing twice.
   */
  signature: string;
}

async function strategyId(): Promise<string> {
  return getParameter('/makeui/agentcore/memory-strategy-id');
}

function namespaceFor(strategy: string, userId: string): string {
  return `/strategies/${strategy}/actors/${userId}/`;
}

function field(text: string, name: string): string {
  return new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(text)?.[1].trim() ?? '';
}

/**
 * Reject anything that carries no visual decision.
 *
 * Early records were written as `Generated <preset> UI: "<prompt>"` — retrievable,
 * relevant by similarity, and completely useless for designing the next screen.
 * They are still in the store, so the filter lives at the read path rather than
 * only at the write path: nothing that says nothing reaches a prompt again.
 */
function parseDesignMemory(
  recordId: string,
  text: string,
  createdAt: number
): DesignMemory | null {
  const palette = field(text, 'Palette');
  const type = field(text, 'Type');
  const radius = field(text, 'Radius');
  if (!palette && !type && !radius) return null;

  const signature = [palette, type, radius, field(text, 'Elevation')].join('|').toLowerCase();
  return { recordId, createdAt, text, preset: field(text, 'Preset') || 'none', signature };
}

/**
 * Collapse repeats of the same decision.
 *
 * A user who generates five screens for the same product stores five records
 * with the same palette. Retrieved together they fill the prompt budget with one
 * fact repeated five times, pushing out every other preference the user has.
 * `pick` decides which member of a duplicate group survives — the most relevant
 * one when reading, the newest one when pruning.
 */
function dedupe(records: DesignMemory[], pick: (a: DesignMemory, b: DesignMemory) => DesignMemory): DesignMemory[] {
  const best = new Map<string, DesignMemory>();
  const order: string[] = [];
  for (const r of records) {
    const seen = best.get(r.signature);
    if (!seen) {
      best.set(r.signature, r);
      order.push(r.signature);
    } else {
      best.set(r.signature, pick(seen, r));
    }
  }
  return order.map((s) => best.get(s)!);
}

/**
 * The design decisions this user made *freely*, relevant to what they are asking for now.
 *
 * `preset` is not a filter for tidiness — it is what makes a record a preference
 * at all. A palette produced under a binding design system is that system
 * speaking, not the user: every `digital-agency` run records `#0017C1` because
 * the preset mandates it. Retrieval ranks by prompt similarity, so the closest
 * hit for a prompt is usually *the same prompt run under a different preset* —
 * which is how a preset-less run ended up shipping the Digital Agency blue, with
 * the identically-worded `digital-agency` run sitting at rank 1 in its memory.
 * Only records made under the same preset describe a choice that transfers.
 */
export async function retrieveUserPreferences(
  userId: string,
  query: string,
  options: { preset?: string; limit?: number } = {}
): Promise<MemoryResult[]> {
  const { preset, limit = RETRIEVE_LIMIT } = options;
  try {
    const [config, strategy] = await Promise.all([getAgentCoreConfig(), strategyId()]);
    const namespace = namespaceFor(strategy, userId);

    const response = await client.send(
      new RetrieveMemoryRecordsCommand({
        memoryId: config.memoryId,
        namespace,
        searchCriteria: { searchQuery: query, topK: RETRIEVE_TOPK },
      })
    );

    const summaries = response.memoryRecordSummaries ?? [];
    const scoreOf = new Map<string, number>();
    const parsed: DesignMemory[] = [];
    let offPreset = 0;
    let tooWeak = 0;
    for (const r of summaries) {
      const id = r.memoryRecordId ?? '';
      const m = parseDesignMemory(id, r.content?.text ?? '', r.createdAt?.getTime() ?? 0);
      if (!m) continue;
      if (preset && m.preset !== preset) {
        offPreset++;
        continue;
      }
      const score = r.score ?? 0;
      if (score < MIN_SCORE) {
        tooWeak++;
        continue;
      }
      scoreOf.set(id, score);
      parsed.push(m);
    }

    // Search order is relevance order, so keeping the first of each duplicate
    // group keeps the record that best matches this prompt.
    const unique = dedupe(parsed, (a) => a).slice(0, limit);

    logger.info('Retrieved user preferences', {
      userId,
      preset,
      returned: summaries.length,
      offPreset,
      tooWeak,
      usable: parsed.length,
      afterDedupe: unique.length,
    });

    return unique.map((m) => ({
      content: m.text,
      score: scoreOf.get(m.recordId) ?? 0,
      namespace,
    }));
  } catch (error) {
    // A cold user simply has no memory yet; never fail a generation over it.
    logger.warn('Failed to retrieve user preferences', { userId, error: String(error) });
    return [];
  }
}

async function listNamespace(memoryId: string, namespace: string): Promise<
  { recordId: string; text: string; createdAt: number }[]
> {
  const all: { recordId: string; text: string; createdAt: number }[] = [];
  let nextToken: string | undefined;
  do {
    const page = await client.send(
      new ListMemoryRecordsCommand({ memoryId, namespace, maxResults: 100, nextToken })
    );
    for (const r of page.memoryRecordSummaries ?? []) {
      all.push({
        recordId: r.memoryRecordId ?? '',
        text: r.content?.text ?? '',
        createdAt: r.createdAt?.getTime() ?? 0,
      });
    }
    nextToken = page.nextToken;
  } while (nextToken);
  return all;
}

async function deleteRecords(memoryId: string, ids: string[]): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 25) {
    const batch = ids.slice(i, i + 25);
    const res = await client.send(
      new BatchDeleteMemoryRecordsCommand({
        memoryId,
        records: batch.map((memoryRecordId) => ({ memoryRecordId })),
      })
    );
    deleted += (res.successfulRecords ?? []).length;
  }
  return deleted;
}

/**
 * Decide what to remove from one user's memory, given everything in it.
 *
 * Pure so the policy can be tested without the service, and so the one-off
 * cleanup of the existing store applies exactly the rule the write path applies
 * from now on.
 */
function selectForRemoval(
  records: { recordId: string; text: string; createdAt: number }[],
  keep: number = KEEP_PER_ACTOR
): { remove: string[]; reasons: { noDecision: number; duplicate: number; overCap: number } } {
  const parsed: DesignMemory[] = [];
  const noDecision: string[] = [];
  for (const r of records) {
    const m = parseDesignMemory(r.recordId, r.text, r.createdAt);
    if (m) parsed.push(m);
    else noDecision.push(r.recordId);
  }

  const newestFirst = [...parsed].sort((a, b) => b.createdAt - a.createdAt);
  const kept = dedupe(newestFirst, (a, b) => (b.createdAt > a.createdAt ? b : a));
  const keptIds = new Set(kept.map((m) => m.recordId));
  const duplicate = parsed.filter((m) => !keptIds.has(m.recordId)).map((m) => m.recordId);

  // `kept` is already newest-first, so anything past the cap is the oldest.
  const overCap = kept.slice(keep).map((m) => m.recordId);

  return {
    remove: [...noDecision, ...duplicate, ...overCap],
    reasons: { noDecision: noDecision.length, duplicate: duplicate.length, overCap: overCap.length },
  };
}

/**
 * Keep one user's memory bounded and free of noise.
 *
 * Runs after a write rather than on a schedule: the store only grows when
 * someone generates, so that is exactly when it needs trimming, and it means the
 * legacy records clear themselves out as users come back.
 */
async function pruneActorMemory(userId: string): Promise<number> {
  try {
    const [config, strategy] = await Promise.all([getAgentCoreConfig(), strategyId()]);
    const namespace = namespaceFor(strategy, userId);
    const records = await listNamespace(config.memoryId, namespace);
    const { remove, reasons } = selectForRemoval(records);
    // Logged even when there is nothing to do: this runs in the background and
    // swallows its own errors, so silence would be indistinguishable from a
    // permission it quietly lost.
    const deleted = remove.length === 0 ? 0 : await deleteRecords(config.memoryId, remove);
    logger.info('Pruned user memory', { userId, total: records.length, deleted, ...reasons });
    return deleted;
  } catch (error) {
    // Housekeeping must never cost a generation that already succeeded.
    logger.warn('Memory prune failed', { userId, error: String(error) });
    return 0;
  }
}

export async function saveDesignMemory(userId: string, designContext: string): Promise<void> {
  const [config, strategy] = await Promise.all([getAgentCoreConfig(), strategyId()]);

  const response = await client.send(
    new BatchCreateMemoryRecordsCommand({
      memoryId: config.memoryId,
      records: [
        {
          requestIdentifier: crypto.randomUUID(),
          namespaces: [namespaceFor(strategy, userId)],
          content: { text: designContext },
          timestamp: new Date(),
          memoryStrategyId: strategy,
        },
      ],
    })
  );

  const failed = response.failedRecords ?? [];
  if (failed.length > 0) {
    throw new Error(`memory write rejected: ${JSON.stringify(failed[0])}`);
  }
  logger.info('Saved design memory', { userId, chars: designContext.length });

  await pruneActorMemory(userId);
}
