import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { logger } from '../utils/logger.js';

const ssmClient = new SSMClient({ region: process.env.AWS_REGION || 'ap-northeast-1' });

interface CacheEntry {
  value: string;
  expiresAt: number;
}

const parameterCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function getParameter(name: string): Promise<string> {
  const cached = parameterCache.get(name);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  try {
    const command = new GetParameterCommand({
      Name: name,
      WithDecryption: true,
    });
    const response = await ssmClient.send(command);
    const value = response.Parameter?.Value ?? '';

    parameterCache.set(name, {
      value,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    return value;
  } catch (error) {
    logger.error('Failed to retrieve SSM parameter', { name, error: String(error) });
    throw error;
  }
}

/**
 * Every field here is fetched on every call, and a missing parameter throws —
 * so this interface is also the list of AgentCore resources that must exist.
 * Code Interpreter and the Policy Engine were removed from it before their
 * parameters were deleted; the other order would have broken Memory and the
 * KnowledgeBase, which share this call.
 *
 * `browserId` and `workloadIdentityId` were here and read by nobody. Every KB
 * search and every memory operation calls this, so each one was fetching two
 * parameters it had no use for. The Browser is used — `browser-verify.ts` takes
 * its id from AGENTCORE_BROWSER_ID, which the Runtime sets — and the comment
 * that used to sit here said this field was "kept" because the Browser mattered,
 * which was true about the service and false about the field.
 *
 * The SSM parameters stay. Removing a field is safe in a way that removing a
 * parameter is not: this call fetches all of them at once, so a parameter that
 * disappears while any field still names it takes Memory and the KnowledgeBase
 * down with it.
 */
export interface AgentCoreConfig {
  memoryId: string;
  knowledgeBaseId: string;
  dataSourceId: string;
}

export async function getAgentCoreConfig(): Promise<AgentCoreConfig> {
  const [memoryId, knowledgeBaseId, dataSourceId] = await Promise.all([
    getParameter('/makeui/agentcore/memory-id'),
    getParameter('/makeui/agentcore/knowledge-base-id'),
    getParameter('/makeui/agentcore/data-source-id'),
  ]);

  return { memoryId, knowledgeBaseId, dataSourceId };
}

export interface ModelConfig {
  sonnetId: string;
  opusId: string;
  haikuId: string;
  defaultModel: string;
}

/**
 * `mode` used to be fetched here from /makeui/pipeline/mode and returned with the
 * rest — a fifth parameter read on every model resolution, which is every
 * generation, edit, plan and /models call, that no caller has ever looked at.
 */
export async function getModelConfig(): Promise<ModelConfig> {
  const [sonnetId, opusId, haikuId, defaultModel] = await Promise.all([
    getParameter('/makeui/models/sonnet'),
    getParameter('/makeui/models/opus'),
    getParameter('/makeui/models/haiku'),
    getParameter('/makeui/models/default'),
  ]);

  return { sonnetId, opusId, haikuId, defaultModel };
}

export interface PresetConfig {
  presetName: string;
  kbPrefix: string;
}

export async function getPresetConfig(preset?: string): Promise<PresetConfig> {
  const presetName = preset || 'digital-agency';
  /**
   * "none" means the user chose no design system, so there is no corpus to scope
   * to and no parameter to look up. Asking anyway cost an SSM round-trip that could
   * only fail, and `getParameter` logs a failure at ERROR — 150 of those in a week,
   * every one of them the system working as designed. Real errors do not stand out
   * in a log that is mostly false alarms.
   */
  if (presetName === 'none') return { presetName, kbPrefix: '' };
  /*
   * A user's own imported system. There is no SSM parameter for it and no
   * shared corpus to scope to — the whole system is the record in DynamoDB, and
   * looking for `/makeui/presets/system:<uuid>/kb-prefix` could only fail, log
   * an ERROR, and cost a round trip on every build that used one.
   */
  if (presetName.startsWith('system:')) return { presetName, kbPrefix: '' };
  try {
    const kbPrefix = await getParameter(`/makeui/presets/${presetName}/kb-prefix`);
    return { presetName, kbPrefix };
  } catch {
    return { presetName, kbPrefix: `${presetName}/` };
  }
}

export interface GuardrailConfig {
  guardrailId: string;
  guardrailVersion: string;
}

export async function getGuardrailConfig(): Promise<GuardrailConfig> {
  const [guardrailId, guardrailVersion] = await Promise.all([
    getParameter('/makeui/guardrail-id'),
    getParameter('/makeui/guardrail-version'),
  ]);

  return { guardrailId, guardrailVersion };
}

