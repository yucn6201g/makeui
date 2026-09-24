import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { recordUsage } from '../services/token-usage.js';
import { saveVersion } from '../services/version-history.js';
import { saveJobPageHtml } from '../services/output-storage.js';
import { generateUI, planUI, scoreHtml } from '../orchestration/graph.js';
import { SCORE_RUBRIC } from '../orchestration/scoring.js';

type ChecklistCounts = { total: number; met: number; unmet: number; unverified: number };
/** What a version row stores of a checklist: met out of the ones a check could settle. */
function checklistOf(req: ChecklistCounts | undefined): { requirementsMet?: number; requirementsChecked?: number } {
  if (!req) return {};
  const checked = req.total - req.unverified;
  return checked > 0 ? { requirementsMet: req.met, requirementsChecked: checked } : {};
}
import type { ModelChoice } from '../config/model-config.js';
import { normalizeEffort } from '../config/effort.js';
import { isOutputKind, DEFAULT_OUTPUT_KIND, type OutputKind } from '../config/frameworks.js';
import { detectKind } from '../tools/framework-compile.js';
import { readProjectFiles } from '../tools/project-transport.js';

/** The framework a produced document actually is, read from its files. */
const detectKindOf = (html: string): OutputKind =>
  detectKind(readProjectFiles(html).keys()) ?? DEFAULT_OUTPUT_KIND;

/** A stored job may carry no format, or one from before the field existed. */
const normalizeKind = (v: unknown): OutputKind => (isOutputKind(v) ? v : DEFAULT_OUTPUT_KIND);
import { updateJobStatus } from '../services/job-service.js';
import { recordProjectRun } from '../services/project-service.js';
import { logger } from '../utils/logger.js';
import { describeFailure } from '../utils/failure-message.js';

/**
 * The single implementation of "run a queued job to completion".
 *
 * Two hosts call this: the worker Lambda (via the `__job` event shape) and the
 * AgentCore Runtime (via `POST /invocations`). Keeping one copy is the point —
 * the previous split let the worker drift two days behind the API for every
 * backend deploy, silently disabling streaming, presets and React output.
 */

const s3Client = new S3Client({ region: process.env.AWS_REGION || 'ap-northeast-1' });
const OUTPUT_BUCKET_NAME = process.env.OUTPUT_BUCKET_NAME || `makeui-outputs-${process.env.AWS_ACCOUNT_ID || 'unknown'}`;

// Strands-SDK-dependent modules are imported lazily so the Lambda bundle, which
// deliberately omits them, still loads for job types that never touch them.
const getModifyUI = () => import('../orchestration/meta-orchestrator.js').then((m) => m.modifyUI);

export interface JobRequest {
  jobId: string;
  userId: string;
  /**
   * The group this run belongs to, resolved when the request was authenticated.
   *
   * Carried rather than looked up: the group's month is written on every
   * recorded request, and asking Cognito here would put a directory call on the
   * end of every generation to answer something the token already said.
   */
  group?: string | null;
  jobType?: string;
  input: Record<string, any>;
}

/**
 * Payloads above this size travel through S3 rather than the invoke body.
 *
 * In BYTES, and measured as bytes. The ceiling being protected is the 256KB
 * async Lambda invoke used by the worker fallback, which counts the serialised
 * payload — so comparing a character count against it was only ever right for
 * ASCII. A 200,000-character Japanese document is about 600KB, so it stayed
 * inline, the invoke was rejected, and the job never started: a failure that
 * appears only on the fallback path, and only for documents in Japanese.
 *
 * 180,000 rather than 200,000 to leave room for the rest of the payload
 * (instruction, preset, ids) inside the same 256KB.
 */
const HTML_S3_THRESHOLD = 180_000;

const payloadBytes = (s: string): number => Buffer.byteLength(s, 'utf8');

async function fetchAndDelete(key: string): Promise<string> {
  const s3Res = await s3Client.send(new GetObjectCommand({ Bucket: OUTPUT_BUCKET_NAME, Key: key }));
  const body = (await (s3Res.Body as any)?.transformToString()) ?? '';
  s3Client.send(new DeleteObjectCommand({ Bucket: OUTPUT_BUCKET_NAME, Key: key })).catch(() => {});
  return body;
}

async function resolveJobHtml(input: Record<string, unknown>): Promise<string> {
  if (input.htmlS3Key && typeof input.htmlS3Key === 'string') return fetchAndDelete(input.htmlS3Key);
  return (input.html as string) ?? '';
}

/**
 * The specification a plan revision amends, which can outgrow an async payload
 * the way a document can — so it travels the same way.
 */
export async function uploadSpecIfNeeded(jobId: string, spec: string): Promise<{ revisionSpec?: string; revisionSpecS3Key?: string }> {
  if (payloadBytes(spec) <= HTML_S3_THRESHOLD) return { revisionSpec: spec };
  const key = `temp/${jobId}.spec.txt`;
  await s3Client.send(new PutObjectCommand({ Bucket: OUTPUT_BUCKET_NAME, Key: key, Body: spec, ContentType: 'text/plain; charset=utf-8' }));
  return { revisionSpecS3Key: key };
}

/**
 * An approved plan, for /generate — the same specification, the same ceiling
 * (120,000 characters, up to ~360KB of UTF-8 when it is mostly Japanese), and
 * the same 256KB async-invoke limit on the worker-Lambda fallback. It was sent
 * inline, so a long approved plan failed exactly when the Runtime was down.
 */
export async function uploadPlanIfNeeded(jobId: string, plan: string): Promise<{ approvedPlan?: string; approvedPlanS3Key?: string }> {
  if (payloadBytes(plan) <= HTML_S3_THRESHOLD) return { approvedPlan: plan };
  const key = `temp/${jobId}.plan.txt`;
  await s3Client.send(new PutObjectCommand({ Bucket: OUTPUT_BUCKET_NAME, Key: key, Body: plan, ContentType: 'text/plain; charset=utf-8' }));
  logger.info('Large approved plan stored in S3 for async payload', { jobId, bytes: payloadBytes(plan) });
  return { approvedPlanS3Key: key };
}

async function resolveJobPlan(input: Record<string, unknown>): Promise<string | undefined> {
  const plan = typeof input.approvedPlanS3Key === 'string'
    ? await fetchAndDelete(input.approvedPlanS3Key)
    : typeof input.approvedPlan === 'string' ? input.approvedPlan : '';
  return plan.trim() ? plan : undefined;
}

/**
 * Whose partition a run's project records go to: the owner the API resolved for
 * a shared project, or the caller's own. Only the API sets `projectOwnerId` —
 * it strips a client's copy before dispatch — and only with a projectId.
 */
function projectPartition(input: Record<string, unknown>, userId: string): string {
  return input.projectId && typeof input.projectOwnerId === 'string' && input.projectOwnerId ? input.projectOwnerId : userId;
}

async function resolveJobRevision(input: Record<string, unknown>): Promise<{ spec: string; plan: string; prompt: string } | undefined> {
  if (typeof input.revisionPrompt !== 'string' || typeof input.revisionPlan !== 'string') return undefined;
  const spec = typeof input.revisionSpecS3Key === 'string'
    ? await fetchAndDelete(input.revisionSpecS3Key)
    : typeof input.revisionSpec === 'string' ? input.revisionSpec : '';
  return spec ? { spec, plan: input.revisionPlan, prompt: input.revisionPrompt } : undefined;
}

/**
 * The reference image, wherever it travelled.
 *
 * An attached image is up to 5MB of base64 — twenty times the 256KB ceiling on an
 * async Lambda invoke. Inline, it therefore worked only while the AgentCore Runtime
 * was reachable and vanished on the worker-Lambda fallback, which is the path taken
 * exactly when the Runtime is having a bad day. It rides through S3 for the same
 * reason the document does.
 */
async function resolveJobImage(input: Record<string, unknown>): Promise<string | undefined> {
  if (input.imageS3Key && typeof input.imageS3Key === 'string') return fetchAndDelete(input.imageS3Key);
  return typeof input.image === 'string' ? input.image : undefined;
}

/**
 * The supplied pictures, from wherever they travelled.
 *
 * Returns [] rather than throwing when the S3 object cannot be read or does not
 * parse. The run is still worth doing without them — the design phase falls back
 * to stock photography and placeholders exactly as it does for a request that
 * supplied none — and `graph.ts` logs what it did not receive.
 */
async function resolveJobImages(input: Record<string, unknown>): Promise<string[]> {
  if (input.imagesS3Key && typeof input.imagesS3Key === 'string') {
    try {
      const parsed = JSON.parse(await fetchAndDelete(input.imagesS3Key));
      if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string');
      logger.warn('Supplied images payload was not a list', { key: input.imagesS3Key });
    } catch (e) {
      logger.warn('Could not read the supplied images; building without them', { error: String(e) });
    }
    return [];
  }
  return Array.isArray(input.images) ? input.images.filter((x): x is string => typeof x === 'string') : [];
}

/** Hand a large document to the job via S3 so the invoke payload stays small. */
export async function uploadHtmlIfNeeded(jobId: string, html: string): Promise<{ html?: string; htmlS3Key?: string }> {
  if (payloadBytes(html) <= HTML_S3_THRESHOLD) return { html };
  const key = `temp/${jobId}.html`;
  await s3Client.send(new PutObjectCommand({ Bucket: OUTPUT_BUCKET_NAME, Key: key, Body: html, ContentType: 'text/html' }));
  logger.info('Large HTML stored in S3 for async payload', { jobId, bytes: payloadBytes(html) });
  return { htmlS3Key: key };
}

/**
 * The pictures the user wants IN the UI, which travel the same way and for the
 * same reason: several photographs are megabytes of base64 against a 256KB async
 * invoke ceiling.
 *
 * All of them or none: a partial upload would build a UI missing exactly the
 * images the user chose it for, and the failure would look like the model
 * ignoring them rather than like a transport error.
 */
export async function uploadContentImages(
  jobId: string,
  images: string[] | undefined
): Promise<{ images?: string[]; imagesS3Key?: string }> {
  if (!images || images.length === 0) return {};
  const payload = JSON.stringify(images);
  if (payloadBytes(payload) <= HTML_S3_THRESHOLD) return { images };
  const key = `temp/${jobId}.images.json`;
  await s3Client.send(new PutObjectCommand({
    Bucket: OUTPUT_BUCKET_NAME, Key: key, Body: payload, ContentType: 'application/json',
  }));
  logger.info('Supplied images stored in S3 for async payload', {
    jobId, count: images.length, bytes: payloadBytes(payload),
  });
  return { imagesS3Key: key };
}

/** Same, for an attached reference image. */
export async function uploadImageIfNeeded(
  jobId: string,
  image: string | undefined
): Promise<{ image?: string; imageS3Key?: string }> {
  if (!image) return {};
  if (payloadBytes(image) <= HTML_S3_THRESHOLD) return { image };
  const key = `temp/${jobId}.image`;
  await s3Client.send(new PutObjectCommand({ Bucket: OUTPUT_BUCKET_NAME, Key: key, Body: image, ContentType: 'text/plain' }));
  logger.info('Large image stored in S3 for async payload', { jobId, bytes: payloadBytes(image) });
  return { imageS3Key: key };
}

/**
 * Executes the job and records its outcome on the job record. Never throws:
 * failures are written to the job so the polling client sees them.
 */
/**
 * The attached data file, if the request carries a usable one.
 *
 * Re-checked here rather than trusted: the API edge validates it, but the worker
 * Lambda fallback and the Runtime both enter through this function and only one
 * of those paths went through that validation.
 */
function jobAttachment(input: Record<string, any>): { name: string; content: string } | undefined {
  const a = input.attachment;
  if (!a || typeof a !== 'object') return undefined;
  if (typeof a.name !== 'string' || typeof a.content !== 'string') return undefined;
  if (!a.name.trim() || !a.content.trim()) return undefined;
  return { name: a.name, content: a.content };
}

export async function runJob(job: JobRequest): Promise<void> {
  const { jobId, userId, group, input, jobType } = job;
  const started = Date.now();
  try {
    await updateJobStatus(jobId, 'running');

    if (jobType === 'plan') {
      const htmlContent = (input.html || input.htmlS3Key) ? await resolveJobHtml(input) : undefined;
      const result = await planUI({
        prompt: input.prompt,
        userId,
        preset: input.preset,
        model: (input.model as ModelChoice) || undefined,
        outputKind: normalizeKind(input.outputKind),
        jobId,
        html: htmlContent || undefined,
        image: await resolveJobImage(input),
        images: await resolveJobImages(input),
        imageCaptions: Array.isArray(input.imageCaptions)
          ? input.imageCaptions.filter((x: unknown): x is string => typeof x === 'string')
          : undefined,
        attachment: jobAttachment(input),
        revision: await resolveJobRevision(input),
      });
      // Planning runs the design phase, which is most of a generation's cost —
      // and the figure now comes from the models rather than from the length of
      // the proposal, which was the smallest thing the operation produced.
      await recordUsage(userId, {
        inputTokens: result.tokenUsage.inputTokens,
        outputTokens: result.tokenUsage.outputTokens,
        cacheReadTokens: result.tokenUsage.cacheReadTokens,
        cacheWriteTokens: result.tokenUsage.cacheWriteTokens,
        // The tier that ran, which the result has carried all along. This used
        // to re-derive a name from the request: `auto` became the SSM default,
        // on the belief that plans do not classify — they do, through
        // `resolveModelForPrompt` — and a restricted user's clamp was invisible
        // to the guess either way. Two ways to be wrong about a fact already in
        // hand.
        model: result.modelTier,
        group,
      });
      /**
       * The specification goes to S3, not into the job record.
       *
       * Every other job type already strips its document out before writing the
       * result; the plan did not, and its specification is the largest thing the
       * pipeline produces. Measured runs put 59k and 71k characters in there — as
       * Japanese UTF-8 that is 176-212KB inside a DynamoDB item capped at 400KB,
       * and the specification is model-generated, so nothing bounds it. A busier
       * app crosses the line, the write throws, and the user loses the design
       * phase — the single most expensive part of a run — at its very last step.
       *
       * `GET /jobs/:id` hydrates it back, exactly as it does for `s3Key`, so the
       * client still receives `spec` and can hand it to /generate as approvedPlan.
       */
      const specKey = result.spec ? await saveJobPageHtml(jobId, 'spec', result.spec) : undefined;
      const { spec: _spec, ...planRest } = result;
      await updateJobStatus(jobId, 'completed', specKey ? { ...planRest, specS3Key: specKey } : planRest);
    } else if (jobType === 'modify') {
      const modifyUI = await getModifyUI();
      const htmlContent = await resolveJobHtml(input);
      const result = await modifyUI({
        html: htmlContent,
        instruction: input.instruction,
        userId,
        preset: input.preset,
        model: (input.model as ModelChoice) || undefined,
        jobId,
        image: await resolveJobImage(input),
        images: await resolveJobImages(input),
        imageCaptions: Array.isArray(input.imageCaptions)
          ? input.imageCaptions.filter((x: unknown): x is string => typeof x === 'string')
          : undefined,
        attachment: jobAttachment(input),
        effort: normalizeEffort(input.effort),
      });
      // As above: the tier the edit actually ran on, not the word requested.
      // This value also names the version row, so a guess here mislabels the
      // history as well as the ledger.
      const modifyModel = result.modelTier;
      await recordUsage(userId, {
        inputTokens: result.tokenUsage?.inputTokens || 0,
        outputTokens: result.tokenUsage?.outputTokens || 0,
        cacheReadTokens: result.tokenUsage?.cacheReadTokens,
        cacheWriteTokens: result.tokenUsage?.cacheWriteTokens,
        model: modifyModel,
        group,
      });
      try {
        await saveVersion({
          // The project's history, in its owner's partition, naming who ran it.
          userId: projectPartition(input, userId),
          actorId: userId,
          ...(typeof input.actorName === 'string' ? { actorName: input.actorName } : {}),
          projectId: input.projectId,
          prompt: input.userPrompt || input.instruction,
          html: result.html,
          /**
           * Measured, not assumed. This was the literal `70` for every edit ever
           * made, so version history showed a flat 70 down the modify rows next to
           * real scores on the generate rows — a number that looked measured, was
           * not, and made the column unreadable. The scorer is a pure function over
           * the document, so there is nothing to save by skipping it.
           */
          score: scoreHtml(
            result.html,
            input.preset,
            detectKindOf(result.html)
          ),
          // Nothing rendered on this path, so the runtime half of the rubric was
          // never reachable. Recorded rather than left to be inferred from the
          // row's shape.
          scoreVerified: false,
          scoreRubric: SCORE_RUBRIC,
          ...checklistOf(result.requirements),
          // The same counts recorded against the account above, kept on the row
          // as well: the ledger answers "how much this month" and cannot answer
          // "how much did this edit cost".
          tokens: {
            input: result.tokenUsage?.inputTokens || 0,
            output: result.tokenUsage?.outputTokens || 0,
          },
          preset: input.preset || 'modified',
          model: modifyModel,
        });
      } catch (e) {
        logger.warn('Failed to save version', { error: String(e) });
      }
      if (input.projectId) {
        await recordProjectRun(projectPartition(input, userId), input.projectId, {
          html: result.html,
          tokens: (result.tokenUsage?.inputTokens || 0) + (result.tokenUsage?.outputTokens || 0),
        }).catch((e) => logger.warn('Failed to record project run', { error: String(e) }));
      }
      const s3Key = await saveJobPageHtml(jobId, 'result', result.html);
      const { html: _html, ...restResult } = result;
      await updateJobStatus(jobId, 'completed', { ...restResult, s3Key });
    } else {
      const result = await generateUI({
        prompt: input.prompt,
        userId,
        preset: input.preset,
        model: (input.model as ModelChoice) || undefined,
        image: await resolveJobImage(input),
        images: await resolveJobImages(input),
        imageCaptions: Array.isArray(input.imageCaptions)
          ? input.imageCaptions.filter((x: unknown): x is string => typeof x === 'string')
          : undefined,
        // Re-parsed here rather than trusted: the API edge validates it, but the
        // worker fallback and the Runtime both enter through this function and
        // only one of those paths went through that validation.
        jobId,
        outputKind: normalizeKind(input.outputKind),
        approvedPlan: await resolveJobPlan(input),
        // Validated at the API edge; re-checked here because the worker fallback
        // and the Runtime both enter through this function, and only one of them
        // came through that validation.
        effort: normalizeEffort(input.effort),
        attachment: jobAttachment(input),
        // Only a direct Runtime invocation can carry this; the API strips it.
        experiment: input.experiment && typeof input.experiment === 'object'
          ? { requirementBriefing: input.experiment.requirementBriefing !== false }
          : undefined,
      });
      const tokenUsage = result.metadata?.tokenUsage;
      /**
       * The tier that ran, not the word the user picked.
       *
       * With `auto` those differ, and `auto` is now the default — so writing the
       * request field would stamp "auto" on every version row, losing the one
       * thing the feature is meant to tell you: which model this document came
       * from.
       *
       * `modelTier` is that answer unconditionally. This read `autoModel?.tier`
       * first, which the pipeline sets ONLY when the router explained itself, so
       * an explicit choice fell through to `input.model` — the request, before
       * the permitted-set clamp had a say. Two sources for one fact, and the
       * complete one was already in the same object.
       */
      const ranAs = result.metadata?.modelTier || input.model || 'sonnet';
      await recordUsage(userId, {
        inputTokens: tokenUsage?.inputTokens || 0,
        outputTokens: tokenUsage?.outputTokens || 0,
        cacheReadTokens: tokenUsage?.cacheReadTokens,
        cacheWriteTokens: tokenUsage?.cacheWriteTokens,
        /*
         * Not `metadata.model`, which is the literal string
         * 'multi-agent-pipeline' — a description of the pipeline, not a model
         * name. It is set on every generate, so `|| ranAs` never ran and the
         * careful line above it was discarded by the line below it. Measured in
         * the live ledger before this change: 345 of 400 sampled rows recorded
         * 'multi-agent-pipeline', which is to say the model column was mostly
         * not a model.
         */
        model: ranAs,
        group,
      });
      try {
        await saveVersion({
          // The project's history, in its owner's partition, naming who ran it.
          userId: projectPartition(input, userId),
          actorId: userId,
          ...(typeof input.actorName === 'string' ? { actorName: input.actorName } : {}),
          projectId: input.projectId,
          prompt: input.prompt,
          html: result.html,
          score: result.qualityScore,
          scoreVerified: Boolean(result.metadata?.scoreVerified),
          scoreRubric: (result.metadata?.scoreParts as { rubric?: number } | undefined)?.rubric ?? SCORE_RUBRIC,
          ...checklistOf(result.metadata?.requirements as ChecklistCounts | undefined),
          ...(typeof result.metadata?.openFindings === 'number' ? { openFindings: result.metadata.openFindings } : {}),
          tokens: {
            input: tokenUsage?.inputTokens || 0,
            output: tokenUsage?.outputTokens || 0,
          },
          preset: input.preset || 'default',
          model: ranAs,
        });
      } catch (e) {
        logger.warn('Failed to save version', { error: String(e) });
      }
      if (input.projectId) {
        await recordProjectRun(projectPartition(input, userId), input.projectId, {
          html: result.html,
          tokens: (tokenUsage?.inputTokens || 0) + (tokenUsage?.outputTokens || 0),
        }).catch((e) => logger.warn('Failed to record project run', { error: String(e) }));
      }
      const genS3Key = await saveJobPageHtml(jobId, 'result', result.html);
      const { html: _genHtml, ...genRest } = result;
      await updateJobStatus(jobId, 'completed', { ...genRest, s3Key: genS3Key });
    }

    logger.info('Job completed', { jobId, jobType: jobType || 'generate', durationMs: Date.now() - started });
  } catch (e) {
    logger.error('Job failed', { jobId, jobType: jobType || 'generate', error: String(e) });
    /*
     * The stored message is what the chat renders, in an error bubble, with no
     * further processing — so it is written here rather than displayed here.
     *
     * This passed `e.message` through, on the reasoning that the orchestrators
     * raise messages written for the user. They do, but measured over thirty
     * days none of them reached this line: all 42 terminal failures were SDK
     * exceptions, and 「ThrottlingException: Too many tokens per day」 was 34 of
     * them. `describeFailure` still passes a deliberate message through
     * untouched; it replaces the ones nobody wrote for a reader. The raw text
     * stays on the log line above, against the job id.
     */
    await updateJobStatus(jobId, 'failed', undefined, describeFailure(e))
      .catch((err) => logger.error('Could not mark the job failed', { jobId, error: String(err) }));
  }
}
