import {
  BedrockAgentRuntimeClient,
  RetrieveCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { getAgentCoreConfig, getPresetConfig } from '../config/agentcore-config.js';
import { logger } from '../utils/logger.js';

const client = new BedrockAgentRuntimeClient({
  region: process.env.AWS_REGION || 'ap-northeast-1',
});

export interface KBSearchResult {
  content: string;
  score: number;
  sourceUri: string;
}

export interface SearchOptions {
  preset?: string;
  maxResults?: number;
}

export async function searchDesignSystem(
  query: string,
  options: SearchOptions = {}
): Promise<KBSearchResult[]> {
  const config = await getAgentCoreConfig();
  const presetConfig = await getPresetConfig(options.preset);
  const maxResults = options.maxResults ?? 5;

  /**
   * No preset means no corpus to search.
   *
   * This has to be explicit. Without it a "no design system" request would
   * retrieve every preset's documents at once and hand the design phase a
   * contradictory pile of conventions it never asked for.
   */
  if (!presetConfig.kbPrefix) {
    logger.info('Skipped design system search — no preset bound', { query });
    return [];
  }

  try {
    const command = new RetrieveCommand({
      knowledgeBaseId: config.knowledgeBaseId,
      retrievalQuery: { text: query },
      retrievalConfiguration: {
        vectorSearchConfiguration: {
          numberOfResults: maxResults,
          /**
           * Scoped by an explicit `preset` attribute, not by a substring of the
           * source URI.
           *
           * The URI form was `stringContains` on `x-amz-bedrock-kb-source-uri`,
           * which S3 Vectors rejects outright: `STRING_CONTAINS operation type
           * is not supported for S3 Vectors`. Only `equals` and `listContains`
           * are available there — `startsWith` and `in` are refused too.
           *
           * `equals` on a real metadata attribute is supported by both stores,
           * which is what keeps the switch reversible: the same code runs
           * against the OpenSearch collection and the S3 Vectors index, and
           * flipping the SSM parameter back needs no deploy.
           *
           * The attribute comes from a `<file>.metadata.json` sidecar in the
           * source bucket. It is also simply more correct than matching a path
           * substring — `product/` is a prefix of nothing else today, but that
           * is a property of the folder names rather than a guarantee.
           */
          filter: {
            equals: {
              key: 'preset',
              value: presetConfig.kbPrefix.replace(/\/$/, ''),
            },
          },
        },
      },
    });

    const response = await client.send(command);
    const results: KBSearchResult[] = (response.retrievalResults ?? []).map((r: any) => ({
      content: r.content?.text ?? '',
      score: r.score ?? 0,
      sourceUri: r.location?.s3Location?.uri ?? '',
    }));

    logger.info('Searched design system KB', {
      query,
      preset: presetConfig.presetName,
      resultCount: results.length,
    });
    return results;
  } catch (error) {
    logger.error('Failed to search design system', { query, error: String(error) });
    return [];
  }
}

export async function searchSharedBestPractices(
  query: string,
  maxResults: number = 5
): Promise<KBSearchResult[]> {
  const config = await getAgentCoreConfig();

  try {
    const command = new RetrieveCommand({
      knowledgeBaseId: config.knowledgeBaseId,
      retrievalQuery: { text: query },
      retrievalConfiguration: {
        vectorSearchConfiguration: {
          numberOfResults: maxResults,
          // Same reason as in searchDesignSystem: S3 Vectors supports only
          // `equals` and `listContains`, so scoping is by the `preset`
          // attribute the sidecar files carry, not by a URI substring.
          filter: {
            equals: {
              key: 'preset',
              value: 'shared',
            },
          },
        },
      },
    });

    const response = await client.send(command);
    const results: KBSearchResult[] = (response.retrievalResults ?? []).map((r: any) => ({
      content: r.content?.text ?? '',
      score: r.score ?? 0,
      sourceUri: r.location?.s3Location?.uri ?? '',
    }));

    logger.info('Searched shared best practices', { query, resultCount: results.length });
    return results;
  } catch (error) {
    logger.error('Failed to search shared best practices', { query, error: String(error) });
    return [];
  }
}

