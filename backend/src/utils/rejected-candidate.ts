import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { logger } from './logger.js'

/**
 * Keeps a repair candidate that broke the app, for a week.
 *
 * A rejected candidate was thrown away with nothing but its log line, and on
 * both live generations of 2026-09-13 that line said React #130 — a component
 * rendered as undefined, with no component named. Which import was wrong could
 * not be found afterwards, because the only document that contained it no longer
 * existed; reproducing it meant paying for another generation and hoping the
 * repair wrote the same mistake.
 *
 * Under `jobs/`, which the bucket expires after seven days: this is for
 * diagnosing a recent run, not an archive. Fire-and-forget — a failed upload
 * must never change what the run does.
 */
const BUCKET = process.env.OUTPUT_BUCKET_NAME || `makeui-outputs-${process.env.AWS_ACCOUNT_ID || 'unknown'}`
let client: S3Client | null = null

export function rejectedCandidateKey(requestId: string, pass: number, kind: string): string {
  const slug = kind.replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
  return `jobs/${requestId}/rejected/pass${pass}-${slug}.html`
}

export function keepRejectedCandidate(requestId: string, pass: number, kind: string, html: string): void {
  const key = rejectedCandidateKey(requestId, pass, kind)
  try {
    client ??= new S3Client({})
    client
      .send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: html, ContentType: 'text/html' }))
      .then(() => logger.info('Kept the rejected repair candidate', { requestId, pass, kind, key }))
      .catch((e) => logger.warn('Could not keep the rejected repair candidate', { requestId, key, error: String(e) }))
  } catch (e) {
    logger.warn('Could not keep the rejected repair candidate', { requestId, key, error: String(e) })
  }
}
