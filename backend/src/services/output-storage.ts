import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { logger } from '../utils/logger.js';

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'ap-northeast-1',
});

const BUCKET_NAME = process.env.OUTPUT_BUCKET_NAME || `makeui-outputs-${process.env.AWS_ACCOUNT_ID || 'unknown'}`;

/**
 * Every finished document, under `outputs/<user>/<date>/<request>.html`.
 *
 * No route reads it and no screen references it — the key it returns reaches
 * `FinalOutput.outputKey` and stops there — so it looks exactly like a write
 * nobody wants, and was removed once for being one. It is not. Two things read
 * this prefix, and neither is production:
 *
 *   `scripts/score-items.mjs` scores a sample of real documents to find which
 *     rubric terms do any work, and reads the preset each one was BUILT for off
 *     the object's own METADATA. `versions/` holds the same documents and
 *     carries no metadata at all, so it cannot answer that question — and
 *     scoring without the preset is the 20-point hole that script's own comment
 *     describes. Delete this and the corpus stops growing the day it happens.
 *   `test/framework-confusion.probe.mjs` pins one object here by key. It is one
 *     of the two probes .gitignore keeps on purpose, because nothing but a model
 *     can show that the repair restructures a Svelte file rather than deleting
 *     the branch.
 *
 * So the prefix is the measurement corpus, and the metadata is the reason it
 * cannot be `versions/`. Which leaves one real problem, unfixed here: the bucket
 * expires `outputs/` after ninety days, so the corpus is a rolling window and
 * the probe's pinned fixture goes on 2026-11-12.
 */
interface SaveOutputParams {
  userId: string;
  requestId: string;
  html: string;
  metadata: Record<string, unknown>;
}

export async function saveOutput(params: SaveOutputParams): Promise<string> {
  const { userId, requestId, html, metadata } = params;
  const date = new Date().toISOString().split('T')[0];
  const key = `outputs/${userId}/${date}/${requestId}.html`;

  try {
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: html,
      ContentType: 'text/html',
      Metadata: {
        userId,
        requestId,
        generatedAt: new Date().toISOString(),
        ...Object.fromEntries(
          Object.entries(metadata).map(([k, v]) => [k, String(v)])
        ),
      },
    });

    await s3Client.send(command);
    logger.info('Output saved to S3', { key, userId, requestId });

    return key;
  } catch (error) {
    logger.error('Failed to save output to S3', { key, error: String(error) });
    throw error;
  }
}

/**
 * Documents that outlive the job that produced them.
 *
 * Version history and a project's preview used to hold the whole document inline
 * in their DynamoDB item, which caps at 400KB. That was survivable while output was
 * 50-100KB of markup, and stopped being survivable the moment a document could
 * carry an embedded image: the size of a *picture* was deciding whether a run
 * appeared in the user's history.
 *
 * The two prefixes are separate from `jobs/` on purpose — that one expires after
 * seven days, which is right for a relay and catastrophic for history.
 */
export function versionDocumentKey(userId: string, versionId: string): string {
  return `versions/${userId}/${versionId}.html`;
}

export function projectDocumentKey(userId: string, projectId: string): string {
  return `projects/${userId}/${projectId}.html`;
}

export async function putDocument(key: string, html: string): Promise<string> {
  await s3Client.send(new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    Body: html,
    ContentType: 'text/html',
  }));
  return key;
}

/** Returns null rather than throwing: a missing document is a blank preview, not a failed request. */
export async function readDocument(key: string): Promise<string | null> {
  try {
    return await getJobPageHtml(key);
  } catch (error) {
    logger.warn('Document not readable from S3', { key, error: String(error) });
    return null;
  }
}

/**
 * Every object under a prefix, for an owner that no longer exists.
 *
 * Deleting a Cognito account used to remove the account and nothing else: the
 * documents stayed under `projects/<sub>/` and `versions/<sub>/` for as long as
 * the bucket did, because neither prefix has an expiry rule — correctly, since
 * they hold history that must not evaporate while its owner is using it. What
 * made it invisible rather than merely untidy is that the admin panel began
 * HIDING rows belonging to no live account, so the orphans stopped being listed
 * at the same time they stopped being deleted.
 *
 * Listed and deleted a page at a time. `DeleteObjects` takes a thousand keys per
 * call, which is also `ListObjectsV2`'s page size, so the two pair exactly and
 * an account with fifty thousand versions costs fifty round trips rather than
 * fifty thousand.
 *
 * Returns how many went. Failures are logged and counted as not deleted rather
 * than thrown: the account is already gone by the time this runs, and a
 * half-finished purge is a smaller problem than a route that reports failure
 * for a deletion that did happen.
 */
export async function deletePrefix(prefix: string): Promise<number> {
  let deleted = 0;
  let token: string | undefined;
  try {
    do {
      const listed = await s3Client.send(new ListObjectsV2Command({
        Bucket: BUCKET_NAME,
        Prefix: prefix,
        ContinuationToken: token,
      }));
      const keys = (listed.Contents ?? []).map((o) => o.Key).filter((k): k is string => Boolean(k));
      if (keys.length > 0) {
        const res = await s3Client.send(new DeleteObjectsCommand({
          Bucket: BUCKET_NAME,
          Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
        }));
        deleted += keys.length - (res.Errors?.length ?? 0);
        for (const e of res.Errors ?? []) {
          logger.warn('Object survived a purge', { key: e.Key, error: e.Message });
        }
      }
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);
  } catch (error) {
    logger.error('Failed to purge an S3 prefix', { prefix, deleted, error: String(error) });
  }
  return deleted;
}

/**
 * The owner ids that appear directly under a prefix.
 *
 * `projects/` and `versions/` are laid out as `<prefix>/<sub>/<id>.html`, so a
 * delimited listing returns one entry per account that has ever stored
 * anything — which is what a sweep needs, and it needs it without reading the
 * objects. Returns null rather than an empty set when the listing fails: an
 * empty answer here means "nobody owns anything", and a sweep acting on that is
 * a sweep that deletes the whole bucket because S3 was briefly unhappy.
 */
export async function ownersUnder(prefix: string): Promise<Set<string> | null> {
  const out = new Set<string>();
  let token: string | undefined;
  try {
    do {
      const listed = await s3Client.send(new ListObjectsV2Command({
        Bucket: BUCKET_NAME,
        Prefix: prefix,
        Delimiter: '/',
        ContinuationToken: token,
      }));
      for (const p of listed.CommonPrefixes ?? []) {
        const owner = (p.Prefix ?? '').slice(prefix.length).replace(/\/$/, '');
        if (owner) out.add(owner);
      }
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);
  } catch (error) {
    logger.warn('Could not list owners under a prefix', { prefix, error: String(error) });
    return null;
  }
  return out;
}

export async function deleteDocument(key: string): Promise<void> {
  try {
    await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
  } catch (error) {
    logger.warn('Failed to delete document from S3', { key, error: String(error) });
  }
}

// ---------------------------------------------------------------
// Job-scoped HTML relay
// Saved as jobs/{jobId}/pages/{pageId}.html, expired after 7 days.
// DynamoDB stores only the S3 key; HTML is fetched on demand.
// ---------------------------------------------------------------

export async function saveJobPageHtml(jobId: string, pageId: string, html: string): Promise<string> {
  const key = `jobs/${jobId}/pages/${pageId}.html`;
  try {
    await s3Client.send(new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: html,
      ContentType: 'text/html',
      Metadata: { jobId, pageId },
    }));
    logger.info('Job page HTML saved to S3', { key });
    return key;
  } catch (error) {
    logger.error('Failed to save job page HTML', { key, error: String(error) });
    throw error;
  }
}

export async function getJobPageHtml(key: string): Promise<string> {
  try {
    const response = await s3Client.send(new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
    }));
    const body = response.Body;
    if (!body) throw new Error('Empty S3 response body');
    // Body is a ReadableStream in Node 22 — collect it
    const chunks: Uint8Array[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf-8');
  } catch (error) {
    logger.error('Failed to read job page HTML from S3', { key, error: String(error) });
    throw error;
  }
}

