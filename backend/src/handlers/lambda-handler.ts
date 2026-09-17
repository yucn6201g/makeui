import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import crypto from 'node:crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { CognitoIdentityProviderClient, AdminCreateUserCommand, ListUsersCommand, AdminDeleteUserCommand, AdminEnableUserCommand, AdminDisableUserCommand, AdminUpdateUserAttributesCommand, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { authenticateRequest, AuthError } from '../middleware/auth.js';
import { applyInputGuardrail, GuardrailBlockedError } from '../middleware/guardrails.js';
import { MAX_CONTENT_IMAGES } from '../utils/content-images.js';
import { checkRateLimit } from '../middleware/rate-limiter.js';
import { isEffort } from '../config/effort.js';
import { isWithdrawnModel } from '../config/withdrawn.js';
import { displayNameFor, isValidDisplayName, DISPLAY_NAME_MAX, resolveDisplayName, forgetDisplayName } from '../services/display-name.js';
import { recordUsage, checkUsageLimit, getUsageHistory, getAllUsersUsage, getMonthlySeries, isMonthKey, monthsBetween, getCurrentMonthKey, setUserTokenLimit, setUserAllowedModels, getUserAllowedModels, normalizeModelSet, setGroupLimit, getGroupLimit, getGroupMonth } from '../services/token-usage.js';
import { getVersionHistory, getVersion, saveVersion } from '../services/version-history.js';
import { getJobPageHtml } from '../services/output-storage.js';
import { runJob, uploadHtmlIfNeeded, uploadImageIfNeeded, uploadContentImages } from './job-runner.js';
import { createJob, updateJobStatus, getJob } from '../services/job-service.js';
import { getModelConfig } from '../config/agentcore-config.js';
import { createProject, listProjects, updateProject, deleteProject, getLatestProjectHtml } from '../services/project-service.js';
import { saveChatMessages, getChatMessages } from '../services/chat-history.js';
import { logger } from '../utils/logger.js';
import { getModelInventory, describeModelId } from '../services/model-inventory.js';
import { maskAccountId } from '../utils/mask-account.js';
import { MAX_ATTACHMENT_CHARS } from '../utils/data-attachment.js';
import { canOpenAdminPanel, isSuperAdmin, mayActOn, membersOf, listUserGroups, groupByUsername, createUserGroup, deleteUserGroup, setUserGroup, GroupWouldLoseAdminError, setGroupAdmin, isValidGroupName, membershipOfSub } from '../services/user-groups.js';
import { purgeAccount, purgeGroup, sweepOrphans } from '../services/account-purge.js';
import { recordPublish } from '../services/published-sites.js';

/**
 * Whether this caller may act on the account identified by `sub`.
 *
 * A super-admin may act on anything, including rows whose owner has no group —
 * a usage row outlives its account, and somebody has to be able to see those. A
 * group-admin may act only inside their own group, and "no group" is not "my
 * group": an ungrouped account is refused rather than shared.
 */
/**
 * Why the request was refused, in the terms the person can act on.
 *
 * The two budgets fail differently and the difference is the whole of what
 * somebody does next: over their own, they ask their group's administrator; over
 * the group's, asking is pointless because a colleague has spent it. One message
 * for both would send half of them to the wrong person.
 */
function usageRefusal(r: { currentUsage: number; limit: number; group: { name: string; limit: number; used: number; exceeded: boolean } | null }): {
  error: string; currentUsage: number; limit: number; scope: 'user' | 'group'; group?: string;
} {
  if (r.group?.exceeded) {
    return {
      error: `グループ「${r.group.name}」全体の今月の予算を使い切りました`,
      currentUsage: r.group.used,
      limit: r.group.limit,
      scope: 'group',
      group: r.group.name,
    };
  }
  return {
    error: 'Monthly token usage limit exceeded',
    currentUsage: r.currentUsage,
    limit: r.limit,
    scope: 'user',
  };
}

async function mayActOnUser(
  auth: { membership: Parameters<typeof mayActOn>[0] },
  targetSub: string
): Promise<boolean> {
  if (isSuperAdmin(auth.membership)) return true;
  const target = await membershipOfSub(targetSub);
  /*
   * Never upwards. A super-admin who is also in a group satisfies "in my
   * group", which would have made a group administrator able to configure the
   * person who administers the account — including lowering their budget to
   * one, from inside the group they were put in to be helpful.
   */
  if (target?.role === 'super-admin') return false;
  return mayActOn(auth.membership, target?.group ?? null);
}

/**
 * Which origins may read a reply from this API.
 *
 * A comma-separated list, and `*` — the default — means any. It defaulted to
 * `*` and was set nowhere: the variable was read here, absent from
 * template.yaml, and absent from the deployed function, so the API answered
 * every origin on the web while looking configured. Bearer tokens make that far
 * from fatal (there is no cookie to ride on) but the reading code existed and
 * the setting did not, which is the shape a control has when nobody has checked
 * it in a year.
 *
 * A list rather than one name because more than one origin is legitimate: the
 * CloudFront distribution the app is served from, and `localhost` while somebody
 * develops against the deployed API.
 */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || '*')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
const MAX_PROMPT_LENGTH = 2000;
/**
 * How many design systems one account may keep.
 *
 * Bounded because nothing else bounds it. The container-side table in graph.ts
 * evicts past 64 entries across ALL users sharing a warm container, so one
 * account filling its own list would start pushing other people's systems out of
 * that cache — a slow, confusing failure somewhere else, instead of a refusal at
 * the point of the mistake.
 */
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_BODY_SIZE = 10 * 1024 * 1024;

/** The ceiling the project store already enforces on `lastHtml`. */
const MAX_EDITED_HTML = 350_000;
const VALID_IMAGE_PREFIXES = ['data:image/png;base64,', 'data:image/jpeg;base64,', 'data:image/gif;base64,', 'data:image/webp;base64,'];

/**
 * The largest document an edit request may carry.
 *
 * Raised from 500,000 once documents could embed a user's photograph. The bound is
 * the API Gateway → Lambda invocation limit (6MB), not storage: the document itself
 * lives in S3 now. A document larger than this cannot be edited, so the embedding
 * ceiling in image-input.ts is set to keep results comfortably under it.
 */
const MAX_DOCUMENT_CHARS = 3_000_000;

const s3Client = new S3Client({ region: process.env.AWS_REGION || 'ap-northeast-1' });
const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION || 'ap-northeast-1' });
const agentCoreClient = new BedrockAgentCoreClient({ region: process.env.AWS_REGION || 'ap-northeast-1' });
const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || 'ap-northeast-1' });
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || '';
const OUTPUT_BUCKET_NAME = process.env.OUTPUT_BUCKET_NAME || `makeui-outputs-${process.env.AWS_ACCOUNT_ID || 'unknown'}`;
const CLOUDFRONT_DOMAIN = process.env.CLOUDFRONT_DOMAIN || '';
const FUNCTION_NAME = process.env.WORKER_FUNCTION_NAME || 'makeui-worker';
const AGENT_RUNTIME_ARN = process.env.AGENT_RUNTIME_ARN || '';

/**
 * The answer when a spend guard could not read its ledger.
 *
 * 503 rather than 403 or 429, because "over your limit" and "too fast" are both
 * claims about this user, and nothing established either — the read failed. 503
 * also says the right thing to whatever sits in front of it: retry later, this
 * is us, not you.
 *
 * Both guards refuse in that case now. Both used to allow, and they read the
 * SAME table — so one DynamoDB throttle removed every spend guard the product
 * has, for its duration. A throttle arrives under load, which is when the
 * guards are doing the most work.
 */
function ledgerUnavailable(): APIGatewayProxyResultV2 {
  return jsonResponse(
    503,
    { error: '利用状況を確認できませんでした。少し待ってから、もう一度お試しください。' },
    { 'Retry-After': '30' }
  );
}


/**
 * Pull the display version out of a Bedrock model id or inference-profile ARN,
 * e.g. ".../jp.anthropic.claude-haiku-4-5-20251001-v1:0" -> "4.5".
 * Returns null when the id doesn't carry a recognisable version.
 */
/*
 * One reader for a model id, shared with the admin panel's model tab.
 *
 * The copy that stood here used `(?:-(\d+))?` for the minor, and the snapshot
 * date sits in the same position with the same separator — so
 * `claude-opus-5-20260601` labelled a chip "5.20260601". Two implementations of
 * one parse is how they came to disagree; there is now one.
 */
const modelVersion = (modelId: string): string | null => describeModelId(modelId).version;


/**
 * Hands a queued job to its executor.
 *
 * Primary target is the AgentCore Runtime: it accepts the job, answers 202 and
 * keeps working in a session that can live for hours, which is what a
 * multi-screen TypeScript project needs. The worker Lambda stays as the
 * fallback so a Runtime outage degrades to the old 900s path instead of
 * failing the request outright.
 *
 * Returns null on success, or the error response to send to the caller.
 */
async function dispatchJob(jobId: string, payload: Record<string, unknown>): Promise<APIGatewayProxyResultV2 | null> {
  if (AGENT_RUNTIME_ARN) {
    try {
      const res = await agentCoreClient.send(new InvokeAgentRuntimeCommand({
        agentRuntimeArn: AGENT_RUNTIME_ARN,
        // One session per job: each gets its own microVM, so concurrent jobs
        // cannot interfere. UUIDs satisfy the 33-character minimum.
        runtimeSessionId: sessionIdFor(jobId),
        contentType: 'application/json',
        accept: 'application/json',
        payload: new TextEncoder().encode(JSON.stringify(payload)),
      }));
      if (res.statusCode && res.statusCode >= 400) {
        throw new Error(`runtime returned ${res.statusCode}`);
      }
      logger.info('Job dispatched to AgentCore Runtime', { jobId });
      return null;
    } catch (err) {
      logger.error('Runtime invoke failed, falling back to worker Lambda', { jobId, error: String(err) });
    }
  }

  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: FUNCTION_NAME,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify(payload)),
    }));
    logger.info('Job dispatched to worker Lambda', { jobId });
    return null;
  } catch (err) {
    logger.error('Lambda async invoke failed', { jobId, error: String(err) });
    await updateJobStatus(jobId, 'failed', undefined, 'Job dispatch failed').catch(() => {});
    return jsonResponse(503, { error: 'Service temporarily unavailable. Please try again.' });
  }
}

/**
 * AgentCore requires a session id of at least 33 characters. Job ids are UUIDs
 * (36), but a shorter id would otherwise fail the call rather than the job.
 */
function sessionIdFor(jobId: string): string {
  return jobId.length >= 33 ? jobId : `${jobId}-makeui-session-padding-0000000000`.slice(0, 40);
}

/**
 * A Runtime session is reclaimed after `idleRuntimeSessionTimeout` without an
 * invocation, and a detached job produces no invocations of its own. The client
 * already polls this API every 2s while a job runs, so that poll doubles as the
 * heartbeat. Rate-limited per warm container; duplicate pings across containers
 * are harmless.
 */
const RUNTIME_PING_INTERVAL_MS = 120_000;
const lastPingAt = new Map<string, number>();

function keepRuntimeSessionAlive(jobId: string): void {
  if (!AGENT_RUNTIME_ARN) return;
  const now = Date.now();
  const last = lastPingAt.get(jobId) ?? 0;
  if (now - last < RUNTIME_PING_INTERVAL_MS) return;
  lastPingAt.set(jobId, now);
  // Bound the map: a warm container can outlive thousands of jobs.
  if (lastPingAt.size > 500) {
    for (const [k, t] of lastPingAt) {
      if (now - t > RUNTIME_PING_INTERVAL_MS * 10) lastPingAt.delete(k);
    }
  }
  agentCoreClient
    .send(new InvokeAgentRuntimeCommand({
      agentRuntimeArn: AGENT_RUNTIME_ARN,
      runtimeSessionId: sessionIdFor(jobId),
      contentType: 'application/json',
      accept: 'application/json',
      payload: new TextEncoder().encode(JSON.stringify({ ping: true })),
    }))
    .catch((err) => logger.warn('Runtime keep-alive failed', { jobId, error: String(err) }));
}

/**
 * The pictures the user wants placed IN the generated UI.
 *
 * A list of the same thing `validateImage` accepts, bounded by count here rather
 * than only downstream: `parseContentImages` silently drops what it cannot fit,
 * and a request that quietly loses half its images is better refused at the door
 * with a reason.
 *
 * The per-image 5MB limit is `validateImage`'s. The TOTAL is deliberately not
 * checked here — the budget that matters is how much can be embedded in the
 * finished document, and `parseContentImages` owns that because it is the thing
 * that knows what a data URI costs. Two places deciding one limit is how they
 * come to disagree.
 */
function validateImages(images: unknown): { valid: boolean; error?: string } {
  if (!Array.isArray(images)) return { valid: false, error: 'images must be a list' };
  if (images.length > MAX_CONTENT_IMAGES) {
    return { valid: false, error: `images must be ${MAX_CONTENT_IMAGES} or fewer` };
  }
  for (let i = 0; i < images.length; i += 1) {
    const one = images[i];
    if (typeof one !== 'string') {
      return { valid: false, error: `images[${i}] must be a base64 string or data URI` };
    }
    const v = validateImage(one);
    if (!v.valid) return { valid: false, error: `images[${i}]: ${v.error}` };
  }
  return { valid: true };
}

/**
 * The user's descriptions of the attached pictures, aligned with them by index.
 *
 * Checked at the edge because two of the three endpoints that take pictures
 * used to drop this field on the way to the job, and a field nobody validates is
 * easy to forget to forward as well. The pipeline clips each to its own caption
 * length; this bound only keeps a request from carrying essays.
 */
function validateImageCaptions(captions: unknown): { valid: boolean; error?: string } {
  if (captions === undefined) return { valid: true };
  if (!Array.isArray(captions) || captions.length > MAX_CONTENT_IMAGES) {
    return { valid: false, error: `imageCaptions must be a list of ${MAX_CONTENT_IMAGES} or fewer` };
  }
  if (captions.some((c) => typeof c !== 'string' || c.length > 500)) {
    return { valid: false, error: 'imageCaptions must be strings of 500 characters or fewer' };
  }
  return { valid: true };
}

function validateImage(image: string): { valid: boolean; error?: string } {
  const hasDataPrefix = VALID_IMAGE_PREFIXES.some((prefix) => image.startsWith(prefix));
  const isRawBase64 = /^[A-Za-z0-9+/]+=*$/.test(image.slice(0, 100));
  if (!hasDataPrefix && !isRawBase64) {
    return { valid: false, error: 'Image must be a valid base64 string or data URI (png, jpeg, gif, webp)' };
  }
  const base64Part = hasDataPrefix ? image.split(',')[1] : image;
  const estimatedSize = (base64Part.length * 3) / 4;
  if (estimatedSize > MAX_IMAGE_SIZE) {
    return { valid: false, error: 'Image must be 5MB or smaller' };
  }
  return { valid: true };
}

/**
 * A data file the user attached to a build.
 *
 * The cap is on what this endpoint accepts, not on what reaches a model: the
 * job distils the file to a sample of a few thousand characters before any
 * prompt sees it (utils/data-attachment.ts). So a large CSV is cheap, and the
 * limit here exists only because the payload travels inline to the Runtime —
 * unlike the image, which is 5MB of base64 and goes via S3.
 */
function validateAttachment(a: unknown): { valid: boolean; error?: string } {
  if (typeof a !== 'object' || a === null) return { valid: false, error: 'attachment must be an object' };
  const { name, content } = a as { name?: unknown; content?: unknown };
  if (typeof name !== 'string' || !name.trim()) return { valid: false, error: 'attachment.name is required' };
  if (typeof content !== 'string' || !content.trim()) return { valid: false, error: 'attachment.content is required' };
  if (content.length > MAX_ATTACHMENT_CHARS) {
    return { valid: false, error: `attachment.content must be ${MAX_ATTACHMENT_CHARS} characters or fewer` };
  }
  // Text formats only. An image already has its own field and its own route.
  // `.pdf` is here because the browser extracts a PDF's text and sends THAT
  // under the original filename — the name records where the text came from,
  // which the prompt then says. No PDF bytes ever reach this endpoint.
  if (!/\.(csv|tsv|json|md|markdown|txt|pdf)$/i.test(name)) {
    return { valid: false, error: 'attachment must be a .csv, .tsv, .json, .md, .txt or .pdf file' };
  }
  // Which is exactly why this check exists: a caller that skipped the browser
  // and posted the file itself would have its bytes read as text and distilled
  // into nonsense that looks like data. A PDF says so in its first five bytes.
  if (content.startsWith('%PDF-')) {
    return { valid: false, error: 'attachment.content must be text — PDF はブラウザ側でテキストに変換してから送信してください' };
  }
  return { valid: true };
}

/**
 * The origin of the request being answered.
 *
 * Module scope because `corsHeaders` is reached through `jsonResponse` from
 * something like sixty places, none of which hold the event, and threading it
 * through all of them to reply to one header would be a worse change than this
 * one. A Node Lambda handles one event at a time per container, so there is no
 * second request to confuse it with — and it is reset at the top of every
 * invocation rather than left from the last, so a container reused across
 * origins cannot answer one with the other's.
 */
let requestOrigin: string | null = null;

/**
 * Echoed back when it is on the list, refused by omission when it is not.
 *
 * `Access-Control-Allow-Origin` takes one origin or `*`, never a list, so an
 * allowlist has to answer with the caller's own name — which is why `Vary`
 * matters here: without it a cache could hand one origin the header written for
 * another.
 *
 * An origin that is not allowed gets no header at all rather than a wrong one.
 * The browser then refuses to hand the reply to the page, which is the intended
 * outcome and reads clearly in the console.
 */
function corsHeaders(): Record<string, string> {
  const any = ALLOWED_ORIGINS.includes('*');
  const allowed = any || (requestOrigin !== null && ALLOWED_ORIGINS.includes(requestOrigin));
  return {
    ...(allowed
      ? { 'Access-Control-Allow-Origin': any && !requestOrigin ? '*' : (requestOrigin ?? '*') }
      : {}),
    ...(any ? {} : { Vary: 'Origin' }),
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(statusCode: number, body: unknown, extraHeaders?: Record<string, string>): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(), ...extraHeaders },
    body: JSON.stringify(body),
  };
}

function getBodyString(event: APIGatewayProxyEventV2): string {
  if (!event.body) return '';
  if (event.isBase64Encoded) return Buffer.from(event.body, 'base64').toString('utf-8');
  return event.body;
}

export const handler = async (
  event: APIGatewayProxyEventV2,
  _context: Context
): Promise<APIGatewayProxyResultV2> => {
  // Internal async job runner — invoked by Lambda itself (no requestContext).
  // Kept as a fallback path; the primary executor is the AgentCore Runtime,
  // which runs the same runJob() from job-runner.ts.
  if ((event as any).__job === true) {
    const { jobId, userId, group, input, jobType } = event as any;
    await runJob({ jobId, userId, group, input, jobType });
    return { statusCode: 200, body: '{"ok":true}' };
  }

  /*
   * The nightly orphan sweep, invoked by EventBridge with a constant payload.
   *
   * Here rather than in a function of its own because it needs exactly what this
   * one already has — the table, the bucket and the user pool, under a role that
   * may reach all three — and a second Lambda to run one scheduled call would be
   * a second thing to deploy, grant and keep in step.
   *
   * There is no request and no caller: EventBridge is the only thing that can
   * send this shape, since the API Gateway integration always populates
   * `requestContext`, and this returns before any route is considered.
   */
  if ((event as any).__sweep === true) {
    const result = await sweepOrphans((event as any).dryRun === true);
    return { statusCode: 200, body: JSON.stringify(result) };
  }

  const requestId = crypto.randomUUID();
  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;
  // Before the first reply can be built, and unconditionally, so a warm
  // container never answers this request with the last one's origin.
  requestOrigin = event.headers?.origin || event.headers?.Origin || null;

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders() };
  }

  const headers = event.headers || {};
  const authorization = headers['authorization'] || headers['Authorization'];

  try {
    if (method === 'GET' && path === '/health') {
      return jsonResponse(200, { status: 'healthy', timestamp: new Date().toISOString() });
    }

    /**
     * Rewrites the brief the user is typing into one the build can act on.
     *
     * Behind the same rate limit and the same guardrail as a generation, because
     * it is the same thing at a smaller size: a user's text going to a model.
     * Charged at Haiku, which is what it runs on and cannot be asked to change —
     * `refinePrompt` reads the model from configuration rather than from this
     * request, so no caller can raise it.
     *
     * Returns 204 rather than an error when there is nothing to suggest. "The
     * brief was already specific enough" and "the call failed" are different
     * facts and the composer shows different things for them.
     */
    if (method === 'POST' && path === '/refine-prompt') {
      const auth = await authenticateRequest(authorization);
      const body = getBodyString(event);
      let input: { prompt?: unknown };
      try { input = JSON.parse(body); } catch { return jsonResponse(400, { error: 'Invalid JSON body' }); }
      if (!input.prompt || typeof input.prompt !== 'string') {
        return jsonResponse(400, { error: 'prompt is required and must be a string' });
      }
      if (input.prompt.length > MAX_PROMPT_LENGTH) {
        return jsonResponse(400, { error: `prompt must be ${MAX_PROMPT_LENGTH} characters or fewer` });
      }
      const rate = await checkRateLimit(auth.userId, 'haiku');
      if (rate.known === false) return ledgerUnavailable();
      if (!rate.allowed) {
        return jsonResponse(429, { error: 'Rate limit exceeded', retryAfter: rate.retryAfter }, { 'Retry-After': String(rate.retryAfter) });
      }
      await applyInputGuardrail(input.prompt);
      const { refinePrompt } = await import('../orchestration/refine-prompt.js');
      /*
       * Billed, which it was not.
       *
       * The comment above says 「Charged at Haiku」 and the rate limit was wired
       * up, so the intent was never in doubt — but nothing wrote the row. This
       * path has no run ledger to fall into (it is one call, not a pipeline), so
       * the record has to be made here, and it is made whatever the call
       * returned: a refusal, an unusable reply and a useful suggestion all cost
       * the same money.
       *
       * The callback is synchronous, so it records what was spent and the write
       * is awaited below — before either return, so the next request's limit
       * check sees this one. A failed write is logged and not raised: a usage
       * row is not worth failing a suggestion the user is already looking at.
       */
      let refineUsage: { inputTokens: number; outputTokens: number } | null = null;
      const refined = await refinePrompt(input.prompt, (usage) => { refineUsage = usage; });
      if (refineUsage) {
        await recordUsage(auth.userId, {
          inputTokens: (refineUsage as { inputTokens: number }).inputTokens,
          outputTokens: (refineUsage as { outputTokens: number }).outputTokens,
          model: 'haiku',
          group: auth.membership.group,
        }).catch((e) => logger.warn('Failed to record refine-prompt usage', { error: String(e) }));
      }
      if (!refined) return jsonResponse(204, {});
      return jsonResponse(200, refined);
    }

    if (method === 'POST' && path === '/generate') {
      const auth = await authenticateRequest(authorization);
      const body = getBodyString(event);
      let input: { prompt: string; preset?: string; model?: string; image?: string; projectId?: string; outputKind?: string; approvedPlan?: string; effort?: string; attachment?: { name: string; content: string } };
      try { input = JSON.parse(body); } catch { return jsonResponse(400, { error: 'Invalid JSON body' }); }
      if (!input.prompt || typeof input.prompt !== 'string') return jsonResponse(400, { error: 'prompt is required and must be a string' });
      if (input.prompt.length > MAX_PROMPT_LENGTH) return jsonResponse(400, { error: `prompt must be ${MAX_PROMPT_LENGTH} characters or fewer` });
      if (input.model && !['auto', 'sonnet', 'opus', 'haiku'].includes(input.model)) return jsonResponse(400, { error: 'model must be "auto", "sonnet", "opus", or "haiku"' });
      /**
       * How much this build may spend.
       *
       * Rejected rather than defaulted when it is a string we do not recognise.
       * Falling back to `standard` would run the full pipeline — design graph,
       * verification, repair — for a user who asked for the cheap one, and they
       * would be billed for it without anything saying so. A 400 is visible.
       */
      if (input.effort !== undefined && !isEffort(input.effort)) {
        return jsonResponse(400, { error: 'effort must be "draft" or "checked"' });
      }
      // The plan travels as a design specification; it is model input, not markup,
      // so cap it rather than letting an arbitrary payload through to the job.
      if (input.approvedPlan !== undefined && (typeof input.approvedPlan !== 'string' || input.approvedPlan.length > 120_000)) {
        return jsonResponse(400, { error: 'approvedPlan must be a string of 120,000 characters or fewer' });
      }
      if (input.image) {
        const v = validateImage(input.image);
        if (!v.valid) return jsonResponse(400, { error: v.error });
      }
      if (input.attachment !== undefined) {
        const a = validateAttachment(input.attachment);
        if (!a.valid) return jsonResponse(400, { error: a.error });
      }
      if ((input as { images?: unknown }).images !== undefined) {
        const im = validateImages((input as { images?: unknown }).images);
        if (!im.valid) return jsonResponse(400, { error: im.error });
      }
      // Checked here as on /plan and /modify: this route spreads the body into the job, so an
      // unchecked field would otherwise travel as whatever the client sent.
      {
        const c = validateImageCaptions((input as { imageCaptions?: unknown }).imageCaptions);
        if (!c.valid) return jsonResponse(400, { error: c.error });
      }
      const rateResult = await checkRateLimit(auth.userId, input.model || 'sonnet');
      if (rateResult.known === false) return ledgerUnavailable();
      if (!rateResult.allowed) return jsonResponse(429, { error: 'Rate limit exceeded', retryAfter: rateResult.retryAfter }, { 'Retry-After': String(rateResult.retryAfter) });
      await applyInputGuardrail(input.prompt);
      const usageResult = await checkUsageLimit(auth.userId, auth.membership.group);
      if (!usageResult.known) return ledgerUnavailable();
      if (!usageResult.allowed) return jsonResponse(403, usageRefusal(usageResult));

      // Async job pattern: submit job and invoke Lambda async
      const jobId = crypto.randomUUID();
      await createJob(jobId, auth.userId);
      // The image is up to 5MB of base64 and the async Lambda invoke ceiling is
      // 256KB, so it travels the same way the document does rather than inline.
      // `experiment` is dropped here: it switches pipeline stages for a measured
      // comparison, and only a direct Runtime invocation may set it.
      const { image: _rawImage, images: _rawImages, experiment: _experiment, ...inputWithoutImage } =
        input as typeof input & { images?: string[]; experiment?: unknown };
      let imageForPayload: { image?: string; imageS3Key?: string };
      let imagesForPayload: { images?: string[]; imagesS3Key?: string };
      try {
        imageForPayload = await uploadImageIfNeeded(jobId, input.image);
        imagesForPayload = await uploadContentImages(
          jobId, (input as { images?: string[] }).images);
      } catch (e) {
        await updateJobStatus(jobId, 'failed', undefined, 'Image upload failed');
        throw e;
      }
      const jobPayload = {
        __job: true,
        jobId,
        userId: auth.userId,
        group: auth.membership.group,
        input: { ...inputWithoutImage, ...imageForPayload, ...imagesForPayload },
      };
      const invokeErr = await dispatchJob(jobId, jobPayload);
      if (invokeErr) return invokeErr;
      return jsonResponse(202, { jobId, status: 'pending' });
    }

    /**
     * Plan mode: run the design phase and return the proposal, building nothing.
     * The specification comes back with it so an approved plan can be handed
     * straight to /generate instead of being redesigned from the prompt.
     */
    if (method === 'POST' && path === '/plan') {
      const auth = await authenticateRequest(authorization);
      const body = getBodyString(event);
      let input: { prompt?: string; preset?: string; model?: string; outputKind?: string; html?: string; projectId?: string; image?: string; images?: string[]; imageCaptions?: string[]; attachment?: { name: string; content: string } };
      try { input = JSON.parse(body); } catch { return jsonResponse(400, { error: 'Invalid JSON body' }); }
      if (!input.prompt || typeof input.prompt !== 'string') return jsonResponse(400, { error: 'prompt is required and must be a string' });
      if (input.prompt.length > MAX_PROMPT_LENGTH) return jsonResponse(400, { error: `prompt must be ${MAX_PROMPT_LENGTH} characters or fewer` });
      if (input.model && !['auto', 'sonnet', 'opus', 'haiku'].includes(input.model)) return jsonResponse(400, { error: 'model must be "auto", "sonnet", "opus", or "haiku"' });
      if (input.html && (typeof input.html !== 'string' || input.html.length > MAX_DOCUMENT_CHARS)) {
        return jsonResponse(400, { error: `html must be a string of ${MAX_DOCUMENT_CHARS} characters or fewer` });
      }
      if (input.image) {
        const v = validateImage(input.image);
        if (!v.valid) return jsonResponse(400, { error: v.error });
      }
      if (input.images !== undefined) {
        const im = validateImages(input.images);
        if (!im.valid) return jsonResponse(400, { error: im.error });
      }
      {
        const c = validateImageCaptions(input.imageCaptions);
        if (!c.valid) return jsonResponse(400, { error: c.error });
      }
      if (input.attachment !== undefined) {
        const a = validateAttachment(input.attachment);
        if (!a.valid) return jsonResponse(400, { error: a.error });
      }
      const rateResult = await checkRateLimit(auth.userId, input.model || 'sonnet');
      if (rateResult.known === false) return ledgerUnavailable();
      if (!rateResult.allowed) return jsonResponse(429, { error: 'Rate limit exceeded', retryAfter: rateResult.retryAfter }, { 'Retry-After': String(rateResult.retryAfter) });
      await applyInputGuardrail(input.prompt);
      const usageResult = await checkUsageLimit(auth.userId, auth.membership.group);
      if (!usageResult.known) return ledgerUnavailable();
      if (!usageResult.allowed) return jsonResponse(403, usageRefusal(usageResult));

      const jobId = crypto.randomUUID();
      await createJob(jobId, auth.userId);
      let htmlForPayload: { html?: string; htmlS3Key?: string } = {};
      let planImagePayload: { image?: string; imageS3Key?: string } = {};
      let planImagesPayload: { images?: string[]; imagesS3Key?: string } = {};
      try {
        if (input.html) htmlForPayload = await uploadHtmlIfNeeded(jobId, input.html);
        planImagePayload = await uploadImageIfNeeded(jobId, input.image);
        planImagesPayload = await uploadContentImages(
          jobId, (input as { images?: string[] }).images);
      } catch (e) {
        await updateJobStatus(jobId, 'failed', undefined, 'S3 upload failed');
        throw e;
      }
      const invokeErr = await dispatchJob(jobId, {
        __job: true,
        jobType: 'plan',
        jobId,
        userId: auth.userId,
        group: auth.membership.group,
        /*
         * The data file and the picture descriptions were validated above and then
         * left out of this object, so a plan was written without the CSV the user
         * attached and without what they said each picture was. Both are named
         * here rather than spread from `input`, because this payload is the list
         * of what a plan job may carry.
         */
        input: {
          ...htmlForPayload, ...planImagePayload, ...planImagesPayload,
          prompt: input.prompt, preset: input.preset, model: input.model, outputKind: input.outputKind,
          ...(input.attachment ? { attachment: input.attachment } : {}),
          ...(input.imageCaptions ? { imageCaptions: input.imageCaptions } : {}),
        },
      });
      if (invokeErr) return invokeErr;
      return jsonResponse(202, { jobId, status: 'pending' });
    }

    if (method === 'POST' && path === '/modify') {
      const auth = await authenticateRequest(authorization);
      const body = getBodyString(event);
      let input: { html?: string; currentHtml?: string; instruction?: string; prompt?: string; preset?: string; model?: string; selector?: string; image?: string; images?: string[]; imageCaptions?: string[]; projectId?: string; effort?: string; attachment?: { name: string; content: string } };
      try { input = JSON.parse(body); } catch { return jsonResponse(400, { error: 'Invalid JSON body' }); }
      const html = input.html || input.currentHtml;
      const instruction = input.instruction || input.prompt;
      if (!html || typeof html !== 'string') return jsonResponse(400, { error: 'html is required and must be a string' });
      if (html.length > MAX_DOCUMENT_CHARS) return jsonResponse(400, { error: `html must be ${MAX_DOCUMENT_CHARS} characters or fewer` });
      if (!instruction || typeof instruction !== 'string') return jsonResponse(400, { error: 'instruction is required and must be a string' });
      if (instruction.length > MAX_PROMPT_LENGTH) return jsonResponse(400, { error: `instruction must be ${MAX_PROMPT_LENGTH} characters or fewer` });
      if (input.model && !['auto', 'sonnet', 'opus', 'haiku'].includes(input.model)) return jsonResponse(400, { error: 'model must be "auto", "sonnet", "opus", or "haiku"' });
      // The mode applies to edits too — see the note on the modifyUI option.
      if (input.effort !== undefined && !isEffort(input.effort)) {
        return jsonResponse(400, { error: 'effort must be "draft" or "checked"' });
      }
      if (input.image) {
        const v = validateImage(input.image);
        if (!v.valid) return jsonResponse(400, { error: v.error });
      }
      if (input.images !== undefined) {
        const im = validateImages(input.images);
        if (!im.valid) return jsonResponse(400, { error: im.error });
      }
      {
        const c = validateImageCaptions(input.imageCaptions);
        if (!c.valid) return jsonResponse(400, { error: c.error });
      }
      if (input.attachment !== undefined) {
        const a = validateAttachment(input.attachment);
        if (!a.valid) return jsonResponse(400, { error: a.error });
      }
      /**
       * The React guard is no longer glued to the instruction.
       *
       * It used to be prepended here, which meant everything downstream read
       * twelve hundred characters of format rules as "what the user asked for".
       * Measured on a real edit: the file-edit planner was handed the boilerplate
       * with 「お問い合わせページを作成してください」 as its last line and returned no
       * plan at all, so the edit silently did nothing. The guard also contains
       * the words 「画面を追加する場合は」, which made the structural-instruction
       * keyword test fire on every edit ever made to a React project.
       *
       * It is prompt text for the whole-document rewrite, so it now lives in
       * that prompt. The per-file path has its own rules, and most of these —
       * "keep every data-file block" — are meaningless when the model is handed
       * one file and asked for one file back.
       */
      let finalInstruction = instruction;
      if (input.selector && typeof input.selector === 'string') {
        if (input.selector.length > 200) return jsonResponse(400, { error: 'selector must be 200 characters or fewer' });
        finalInstruction = `Target element: ${input.selector}. ${finalInstruction}`;
      }
      const rateResult = await checkRateLimit(auth.userId, input.model || 'sonnet');
      if (rateResult.known === false) return ledgerUnavailable();
      if (!rateResult.allowed) return jsonResponse(429, { error: 'Rate limit exceeded', retryAfter: rateResult.retryAfter });
      await applyInputGuardrail(finalInstruction);
      const usageResult = await checkUsageLimit(auth.userId, auth.membership.group);
      if (!usageResult.known) return ledgerUnavailable();
      if (!usageResult.allowed) return jsonResponse(403, usageRefusal(usageResult));

      // Async job pattern — large HTML stored in S3 to avoid the 256KB async invoke limit
      const jobId = crypto.randomUUID();
      await createJob(jobId, auth.userId);
      let htmlForPayload: { html?: string; htmlS3Key?: string };
      let modifyImagePayload: { image?: string; imageS3Key?: string };
      let modifyImagesPayload: { images?: string[]; imagesS3Key?: string };
      try {
        htmlForPayload = await uploadHtmlIfNeeded(jobId, html);
        modifyImagesPayload = await uploadContentImages(jobId, input.images);
        // The attachment used to be validated here and then left out of the payload,
        // so an image attached to an edit was rejected if malformed and ignored if
        // valid — it never left the browser.
        modifyImagePayload = await uploadImageIfNeeded(jobId, input.image);
      } catch (e) {
        await updateJobStatus(jobId, 'failed', undefined, 'S3 upload failed');
        throw e;
      }
      const jobPayload = {
        __job: true,
        jobType: 'modify',
        jobId,
        userId: auth.userId,
        group: auth.membership.group,
        // `instruction` is model-facing (may carry the element-targeting wrapper);
        // `userPrompt` is what the user typed and is the only thing history shows.
        /*
         * The data file used to be validated above and missing here — the same
         * shape the image had before it was fixed — so a CSV attached to an edit
         * never reached the job. Named, with the pictures and their descriptions,
         * for the reason the plan payload names them.
         */
        input: {
          ...htmlForPayload, ...modifyImagePayload, ...modifyImagesPayload,
          instruction: finalInstruction, userPrompt: instruction, preset: input.preset, model: input.model, projectId: input.projectId, effort: input.effort,
          ...(input.attachment ? { attachment: input.attachment } : {}),
          ...(input.imageCaptions ? { imageCaptions: input.imageCaptions } : {}),
        },
      };
      const invokeErr = await dispatchJob(jobId, jobPayload);
      if (invokeErr) return invokeErr;
      return jsonResponse(202, { jobId, status: 'pending' });
    }

    if (method === 'GET' && path === '/versions') {
      const auth = await authenticateRequest(authorization);
      const queryParams = event.queryStringParameters || {};
      const projectId = queryParams.projectId;
      const versions = await getVersionHistory(auth.userId, 20, projectId || undefined);
      return jsonResponse(200, { versions });
    }

    /**
     * Saves a document the user edited directly, with no model involved.
     *
     * Every change to a generated UI used to cost a full pipeline run, because
     * the only way to alter the document was to describe the alteration to a
     * model. Retyping a heading meant minutes of waiting and a token bill for a
     * change the browser could have made instantly.
     *
     * Deliberately not rate-limited against the model budget and not counted as
     * usage: nothing is inferred here. It is a write, and its cost is a PutItem
     * and an S3 object. The size ceiling is the one the project store already
     * enforces, so a direct edit cannot produce a document the rest of the app
     * could not have produced anyway.
     */
    if (method === 'POST' && path === '/versions') {
      const auth = await authenticateRequest(authorization);
      const body = getBodyString(event);
      if (body.length > MAX_BODY_SIZE) return jsonResponse(413, { error: 'Request body too large' });
      let input: { html: string; projectId?: string; note?: string; preset?: string; score?: number };
      try { input = JSON.parse(body); } catch { return jsonResponse(400, { error: 'Invalid JSON body' }); }
      if (!input.html || typeof input.html !== 'string') {
        return jsonResponse(400, { error: 'html is required' });
      }
      if (input.html.length > MAX_EDITED_HTML) {
        return jsonResponse(413, { error: `html must be ${MAX_EDITED_HTML} characters or fewer` });
      }
      const version = await saveVersion({
        userId: auth.userId,
        prompt: (input.note || '直接編集').slice(0, 200),
        html: input.html,
        /**
         * Carried from the version this was edited from, not recomputed.
         *
         * Re-scoring here would mean importing the whole generation pipeline
         * into the API Lambda — the audits, the browser client, the React
         * bundler — to run one pure function, for a change that moves the
         * rubric by nothing. The record says `direct-edit`, so a score that did
         * not move is readable as exactly what it is.
         */
        score: Math.max(0, Math.min(99, Math.round(Number(input.score) || 0))),
        preset: input.preset || 'none',
        model: 'direct-edit',
        ...(input.projectId ? { projectId: input.projectId } : {}),
      });
      if (input.projectId) {
        await updateProject(auth.userId, input.projectId, { lastHtml: input.html });
      }
      return jsonResponse(201, { versionId: version.versionId, score: version.score });
    }

    if (method === 'GET' && path.startsWith('/versions/')) {
      const auth = await authenticateRequest(authorization);
      const versionId = decodeURIComponent(path.replace('/versions/', ''));
      if (!versionId) return jsonResponse(400, { error: 'versionId is required' });
      const version = await getVersion(auth.userId, versionId);
      if (!version) return jsonResponse(404, { error: 'Version not found' });
      return jsonResponse(200, version);
    }

    /*
     * One document, one link.
     *
     * This took a `pages` array of up to twenty and built a navigation index
     * when it held more than one. Nothing ever sent more than one: the client
     * wrapped the single document as `[{ id: 'index', … }]` and always had, so
     * the index generator, the per-page URL list and the UI branch that
     * rendered it were unreachable from the moment multi-file output shipped.
     * Deleted rather than wired, because wiring it needs a decision nobody has
     * made — what a "page" is, now that a project is a routed app rather than a
     * set of documents.
     */
    if (method === 'POST' && path === '/publish') {
      const auth = await authenticateRequest(authorization);
      const body = getBodyString(event);
      let input: { html?: string };
      try { input = JSON.parse(body); } catch { return jsonResponse(400, { error: 'Invalid JSON body' }); }
      if (!input.html || typeof input.html !== 'string') return jsonResponse(400, { error: 'html is required' });
      if (input.html.length > 2 * 1024 * 1024) return jsonResponse(400, { error: 'html exceeds the 2MB limit' });

      /*
       * Rated like the cheapest model, though it spends none.
       *
       * This was the one authenticated route with no gate of any kind: every
       * other path that writes anything checks the bucket first, and this one
       * accepted two megabytes per call as fast as they arrived. It costs no
       * tokens, so it is charged the smallest unit there is — one point of two
       * hundred a day, invisible to anyone publishing normally and a bound on
       * anyone who is not.
       */
      const rate = await checkRateLimit(auth.userId, 'haiku');
      if (rate.known === false) return ledgerUnavailable();
      if (!rate.allowed) {
        return jsonResponse(429, { error: 'Rate limit exceeded', retryAfter: rate.retryAfter }, { 'Retry-After': String(rate.retryAfter) });
      }

      const siteId = crypto.randomUUID();
      const key = `published/${siteId}/index.html`;
      await s3Client.send(new PutObjectCommand({
        Bucket: OUTPUT_BUCKET_NAME, Key: key, Body: input.html, ContentType: 'text/html',
      }));
      /*
       * And a row saying whose it is, which nothing wrote before.
       *
       * `published/` is keyed by a random site id, so without this nothing
       * connected a live public page to an account — deleting the account left
       * the page up for the thirty days the lifecycle rule gives it. After the
       * object, so a record never describes a document that failed to write.
       */
      await recordPublish(auth.userId, siteId, input.html.length);
      logger.info('Published', { userId: auth.userId, siteId, bytes: input.html.length });
      return jsonResponse(200, {
        siteId,
        url: `https://${CLOUDFRONT_DOMAIN}/${key}`,
        domain: `https://${CLOUDFRONT_DOMAIN}`,
      });
    }

    if (method === 'GET' && path === '/usage') {
      const auth = await authenticateRequest(authorization);
      const [history, limitResult] = await Promise.all([
        getUsageHistory(auth.userId),
        checkUsageLimit(auth.userId, auth.membership.group),
      ]);
      /*
       * A ledger that could not be read must not be drawn as one that was.
       * The panel says 「今月の上限」 over these numbers, and the placeholders
       * are 0 of the default — a confident, wrong answer to the one question
       * people open it to ask. `useUsage` already turns a non-2xx into the
       * error state the panel renders, so refusing here is enough.
       */
      if (!limitResult.known) return ledgerUnavailable();
      /*
       * The same CONFIG item, read a second time, so it can fail on its own.
       * `useUsage` treats an absent list as "all models permitted" — a picker
       * offering Opus to someone held to Haiku, which is the exact lie the field
       * was added to prevent.
       */
      const allowedModels = await getUserAllowedModels(auth.userId);
      if (allowedModels === null) return ledgerUnavailable();
      return jsonResponse(200, {
        /*
         * The name the header shows, from the verified token rather than a
         * directory lookup: it is already in hand, and /usage is on the path of
         * every page load. It goes stale for at most one token refresh after an
         * administrator renames somebody, which is the right trade against a
         * Cognito call per request.
         */
        displayName: await resolveDisplayName(auth.email, auth.name, USER_POOL_ID),
        history,
        currentUsage: limitResult.currentUsage,
        limit: limitResult.limit,
        /*
         * The plain token count as well as the figure the limit is checked
         * against. Once a price table is enforced those differ by a factor of
         * about three, and 「トークン数」 has to be the tokens.
         */
        tokensUsed: limitResult.totalTokens,
        /** The month's spend, from the same read as the limit. */
        cost: limitResult.cost,
        /*
         * Whether that spend is a sum or an estimate — see `splitCoverage`.
         * True only for a month straddling the deploy that began recording
         * which model each request went to, where what the uncounted requests
         * cost is inferred from what the counted ones did. A number somebody is
         * held to should say when it was inferred.
         */
        costEstimated: limitResult.estimated ?? false,
        // Use the authoritative counter from checkUsageLimit — history[0] is not
        // guaranteed to be the current month.
        requestsUsed: limitResult.requestCount,
        /*
         * The group's name and its combined budget — visible to every member,
         * not only to whoever administers it. Somebody refused while still
         * inside their own budget has to be able to see why, and the answer is
         * a number their colleagues moved.
         *
         * From the token's own membership rather than a directory lookup: it is
         * already in hand on the path of every page load.
         */
        group: auth.membership.group,
        groupBudget: limitResult.group
          ? { limit: limitResult.group.limit, used: limitResult.group.used, cost: limitResult.group.cost }
          : null,
        // So the client can draw a picker that matches what the pipeline will
        // actually honour, rather than offering a model it will silently replace.
        allowedModels,
      });
    }

    if (method === 'GET' && path === '/admin/usage') {
      const auth = await authenticateRequest(authorization);
      if (!canOpenAdminPanel(auth.membership)) return jsonResponse(403, { error: 'Admin access required' });
      /*
       * With the group each account belongs to, which every screen that lists
       * people now shows. Keyed by the Cognito username — the email for this
       * pool — because that is what membership is recorded against, while a
       * usage row is keyed by `sub`.
       */
      /*
       * The period, defaulting to this month.
       *
       * `YYYY-MM` because that is the granularity the store has — one row per
       * account per month. A finer range would have to be built from the
       * `EVENT#` rows, which means a query per account to answer a report.
       *
       * Bounded at 24 months: the scan reads the whole table either way, but a
       * range nobody meant is better refused than merged into one line.
       */
      const q = event.queryStringParameters ?? {};
      const from = q.from ?? getCurrentMonthKey();
      const to = q.to ?? from;
      if (!isMonthKey(from) || !isMonthKey(to)) {
        return jsonResponse(400, { error: 'from と to は YYYY-MM 形式で指定してください' });
      }
      if (to < from) {
        return jsonResponse(400, { error: '終了月は開始月より前にできません' });
      }
      if (monthsBetween(from, to).length > 24) {
        return jsonResponse(400, { error: '期間は24ヶ月までです' });
      }

      const placements = await groupByUsername();
      const allUsage = (await getAllUsersUsage(from, to)).map((u) => ({
        ...u,
        group: placements.get(u.email)?.group ?? null,
      }));
      /*
       * A group-admin sees their own group and nothing else.
       *
       * Filtered by EMAIL, because that is the Cognito username for this pool
       * and so what group membership is recorded against, while a usage row is
       * keyed by `sub`. Matching on the wrong one would silently return an empty
       * table, which reads as "this group has spent nothing".
       */
      if (!isSuperAdmin(auth.membership)) {
        const mine = new Set((await membersOf(auth.membership.group ?? '')).map((u) => u.toLowerCase()));
        return jsonResponse(200, {
          users: allUsage.filter((u) => mine.has((u.email ?? '').toLowerCase())),
          scope: auth.membership.group,
        });
      }
      return jsonResponse(200, { users: allUsage });
    }

    if (method === 'POST' && path === '/admin/usage/limit') {
      const auth = await authenticateRequest(authorization);
      if (!canOpenAdminPanel(auth.membership)) return jsonResponse(403, { error: 'Admin access required' });
      const body = getBodyString(event);
      let input: { userId: string; limit: number };
      try { input = JSON.parse(body); } catch { return jsonResponse(400, { error: 'Invalid JSON body' }); }
      if (!input.userId || typeof input.userId !== 'string') return jsonResponse(400, { error: 'userId is required' });
      /*
       * A group's administrator may set the budgets of their own members.
       *
       * They could not before, which left the one person who knows how a team
       * divides its month unable to divide it — every change went through the
       * account administrator. What stays theirs alone is the group's total:
       * dividing a ceiling is the tenant's business, raising it is the
       * account's.
       */
      if (!(await mayActOnUser(auth, input.userId))) {
        return jsonResponse(403, { error: '自分のグループのユーザーのみ設定できます' });
      }
      if (typeof input.limit !== 'number' || !Number.isInteger(input.limit) || (input.limit !== -1 && input.limit < 1)) return jsonResponse(400, { error: 'limit must be a positive integer or -1 (unlimited)' });

      /*
       * What a group administrator may set, as opposed to whose budget.
       *
       * `mayActOnUser` answers "is this one of my people", and their own
       * account is one of their people — so on its own it let a group
       * administrator write their own budget, and `-1` was an accepted value,
       * and a group's own budget defaults to unlimited. Three reasonable
       * decisions that composed into: any group administrator may grant
       * themselves an unlimited budget.
       *
       * So dividing stays dividing. Unlimited is the account administrator's
       * word, and no share may exceed the ceiling it is a share of — a budget
       * larger than the group's is not enforceable anyway, since the group's is
       * checked on the same request, and offering it would only mean showing
       * somebody a figure that refuses them before they reach it.
       */
      if (!isSuperAdmin(auth.membership)) {
        if (input.limit === -1) {
          return jsonResponse(403, { error: '無制限に設定できるのはアカウント管理者のみです' });
        }
        const ceiling = auth.membership.group ? await getGroupLimit(auth.membership.group) : -1;
        if (ceiling === null) {
          return jsonResponse(503, { error: 'グループの予算を読み取れませんでした。しばらくしてからお試しください' });
        }
        if (ceiling !== -1 && input.limit > ceiling) {
          return jsonResponse(400, { error: 'グループ全体の予算を超える金額は設定できません' });
        }
      }

      await setUserTokenLimit(input.userId, input.limit);
      return jsonResponse(200, { message: `Token limit for ${input.userId} set to ${input.limit}` });
    }

    /**
     * Which models a user may pick.
     *
     * Enforced in the pipeline rather than here — see the note at the model
     * resolution — so this endpoint only records the setting. That split is
     * deliberate: a permission the API merely filters could be bypassed by
     * anything that talks to the pipeline directly, and the picker the client
     * draws from it is a convenience, not the control.
     */
    if (method === 'POST' && path === '/admin/usage/model-allowance') {
      const auth = await authenticateRequest(authorization);
      if (!canOpenAdminPanel(auth.membership)) return jsonResponse(403, { error: 'Admin access required' });
      const body = getBodyString(event);
      let input: { userId: string; models: unknown };
      try { input = JSON.parse(body); } catch { return jsonResponse(400, { error: 'Invalid JSON body' }); }
      if (!input.userId || typeof input.userId !== 'string') return jsonResponse(400, { error: 'userId is required' });
      if (!(await mayActOnUser(auth, input.userId))) {
        return jsonResponse(403, { error: 'このユーザーはあなたのグループに属していません' });
      }
      const models = normalizeModelSet(input.models);
      /**
       * Refused here rather than absorbed downstream. A set with no real model
       * cannot be resolved into one, and the resolver's own fallback for that is
       * to ignore the setting entirely — so storing it would silently grant
       * everything, which is the opposite of what unchecking every box means.
       */
      if (!models) {
        return jsonResponse(400, {
          error: 'models must be a subset of haiku, sonnet, opus, auto and include at least one of haiku, sonnet, opus',
        });
      }
      await setUserAllowedModels(input.userId, models);
      return jsonResponse(200, { message: `Allowed models for ${input.userId} set to ${models.join(', ')}` });
    }

    if (method === 'POST' && path === '/admin/groups/limit') {
      const auth = await authenticateRequest(authorization);
      /*
       * The account administrator, and nobody else.
       *
       * A group administrator dividing their own ceiling is reasonable; raising
       * it is not, because the ceiling is what the account is billed against and
       * they are not the one paying it.
       */
      if (!isSuperAdmin(auth.membership)) {
        return jsonResponse(403, { error: 'この操作はアカウント管理者のみが実行できます' });
      }
      const body = getBodyString(event);
      let input: { group: string; limit: number };
      try { input = JSON.parse(body); } catch { return jsonResponse(400, { error: 'Invalid JSON body' }); }
      if (!input.group || typeof input.group !== 'string') return jsonResponse(400, { error: 'group is required' });
      if (typeof input.limit !== 'number' || !Number.isInteger(input.limit) || (input.limit !== -1 && input.limit < 1)) {
        return jsonResponse(400, { error: 'limit must be a positive integer or -1 (unlimited)' });
      }
      // The group has to exist. A budget on a name nobody belongs to is a row
      // that never binds anything and never reports anything.
      if (!(await listUserGroups()).some((g) => g.name === input.group)) {
        return jsonResponse(404, { error: 'そのグループはありません' });
      }
      await setGroupLimit(input.group, input.limit);
      logger.info('Admin set a group budget', { adminId: auth.userId, group: input.group, limit: input.limit });
      return jsonResponse(200, { message: `Budget for ${input.group} set to ${input.limit}` });
    }

    if (method === 'GET' && path.startsWith('/admin/usage/')) {
      const auth = await authenticateRequest(authorization);
      if (!canOpenAdminPanel(auth.membership)) return jsonResponse(403, { error: 'Admin access required' });
      const targetUserId = decodeURIComponent(path.replace('/admin/usage/', ''));
      if (!(await mayActOnUser(auth, targetUserId))) return jsonResponse(403, { error: 'Forbidden' });
      const history = await getUsageHistory(targetUserId);
      return jsonResponse(200, { userId: targetUserId, history });
    }

    /*
     * What a user actually made: their projects, the prompts they typed, the
     * documents that came out, and what each project cost.
     *
     * Every one of these calls the same function the user's own endpoint calls,
     * with their id instead of the caller's. That is the point — an admin view
     * assembled from its own queries is a second implementation of "what does
     * this user have", and the two drift in the direction of the admin view
     * being wrong about somebody else's data, which is the worst direction.
     *
     * Placed after the `/admin/usage/` prefix route above but before nothing
     * that could shadow it: `/admin/projects/...` and `/admin/versions/...` are
     * distinct prefixes, matched by shape rather than by startsWith, so a
     * project id containing a slash cannot be read as a longer path.
     */
    const adminProjects = path.match(/^\/admin\/projects\/([^/]+)$/);
    if (method === 'GET' && adminProjects) {
      const auth = await authenticateRequest(authorization);
      if (!canOpenAdminPanel(auth.membership)) return jsonResponse(403, { error: 'Admin access required' });
      const targetUserId = decodeURIComponent(adminProjects[1]);
      if (!(await mayActOnUser(auth, targetUserId))) return jsonResponse(403, { error: 'Forbidden' });
      const projects = await listProjects(targetUserId);
      return jsonResponse(200, {
        userId: targetUserId,
        /*
         * `hasDocument` rather than the document — which `listProjects` now
         * answers for every caller, so there is nothing to strip here. It used
         * to carry the markup inline, which was right for opening one project
         * and wrong for listing forty. The document is fetched per version, on
         * demand, below.
         */
        projects,
      });
    }

    const adminVersions = path.match(/^\/admin\/projects\/([^/]+)\/([^/]+)\/versions$/);
    if (method === 'GET' && adminVersions) {
      const auth = await authenticateRequest(authorization);
      if (!canOpenAdminPanel(auth.membership)) return jsonResponse(403, { error: 'Admin access required' });
      const targetUserId = decodeURIComponent(adminVersions[1]);
      if (!(await mayActOnUser(auth, targetUserId))) return jsonResponse(403, { error: 'Forbidden' });
      const targetProjectId = decodeURIComponent(adminVersions[2]);
      // Metadata only, and prompts already cleaned of the internal scaffolding
      // older records embedded — `getVersionHistory` does both.
      const versions = await getVersionHistory(targetUserId, 100, targetProjectId);
      return jsonResponse(200, { userId: targetUserId, projectId: targetProjectId, versions });
    }

    const adminVersion = path.match(/^\/admin\/versions\/([^/]+)\/([^/]+)$/);
    if (method === 'GET' && adminVersion) {
      const auth = await authenticateRequest(authorization);
      if (!canOpenAdminPanel(auth.membership)) return jsonResponse(403, { error: 'Admin access required' });
      const targetUserId = decodeURIComponent(adminVersion[1]);
      if (!(await mayActOnUser(auth, targetUserId))) return jsonResponse(403, { error: 'Forbidden' });
      const versionId = decodeURIComponent(adminVersion[2]);
      const version = await getVersion(targetUserId, versionId);
      if (!version) return jsonResponse(404, { error: 'Version not found' });
      return jsonResponse(200, version);
    }

    /*
     * User groups. Account-wide administration, so super-admin only throughout —
     * a group-admin who could create groups or move people between them could
     * appoint themselves over another one, which is the whole boundary.
     */
    if (method === 'GET' && path === '/admin/groups') {
      const auth = await authenticateRequest(authorization);
      if (!canOpenAdminPanel(auth.membership)) return jsonResponse(403, { error: 'Admin access required' });
      /*
       * Readable by a group-admin too, and narrowed to their own. The panel
       * needs the group's name and who administers it to say whose panel this
       * is; it does not need the list of other tenants.
       */
      const groups = await listUserGroups();
      const visible = isSuperAdmin(auth.membership)
        ? groups
        : groups.filter((g) => g.name === auth.membership.group);
      /*
       * With each group's budget and what it has spent.
       *
       * Two reads per group rather than a scan over its members: the month is
       * kept as its own aggregate, written alongside each user's — see
       * `recordUsage`. A group administrator sees exactly one group, so this is
       * two reads for them and a handful for the account administrator.
       */
      return jsonResponse(200, {
        groups: await Promise.all(visible.map(async (g) => {
          const [limit, month] = await Promise.all([getGroupLimit(g.name), getGroupMonth(g.name)]);
          return {
            ...g,
            // Null is unreadable, which the panel must not draw as unlimited.
            monthlyLimit: limit,
            usedTokens: month?.total ?? null,
            usedWeighted: month?.weighted ?? null,
            requestCount: month?.requests ?? null,
            cost: month?.cost ?? null,
          };
        })),
      });
    }

    if (method === 'POST' && path === '/admin/groups') {
      const auth = await authenticateRequest(authorization);
      if (!isSuperAdmin(auth.membership)) {
        return jsonResponse(403, { error: 'この操作はアカウント管理者のみが実行できます' });
      }
      const body = getBodyString(event);
      let input: { name?: unknown; description?: unknown };
      try { input = JSON.parse(body); } catch { return jsonResponse(400, { error: 'Invalid JSON body' }); }
      if (!isValidGroupName(input.name)) {
        return jsonResponse(400, { error: 'グループ名は英数字で始まる63文字以内（英数字・空白・_ . -）で入力してください' });
      }
      const name = input.name.trim();
      const existing = await listUserGroups();
      if (existing.some((g) => g.name.toLowerCase() === name.toLowerCase())) {
        return jsonResponse(409, { error: 'その名前のグループはすでに存在します' });
      }
      await createUserGroup(name, typeof input.description === 'string' ? input.description.slice(0, 200) : undefined);
      logger.info('Admin created a user group', { adminId: auth.userId, group: name });
      return jsonResponse(201, { group: { name, admin: null, memberCount: 0 } });
    }

    const groupPath = path.match(/^\/admin\/groups\/([^/]+)$/);
    if (method === 'DELETE' && groupPath) {
      const auth = await authenticateRequest(authorization);
      if (!isSuperAdmin(auth.membership)) {
        return jsonResponse(403, { error: 'この操作はアカウント管理者のみが実行できます' });
      }
      const name = decodeURIComponent(groupPath[1]);
      /*
       * The accounts survive; only the grouping goes. A group is an
       * administrative grouping, not an owner, and deleting one must never be a
       * way to delete people — their projects and their usage are untouched and
       * they simply belong to nothing until they are placed again.
       */
      await deleteUserGroup(name);
      /*
       * And the two rows the group itself owns, which are keyed by its NAME.
       *
       * `GROUP#<name>` holds the budget and the month's spend. Leaving them
       * behind is not only an orphan: making another group with the same name —
       * the obvious thing to do after a typo — opened it with its predecessor's
       * budget already set and its predecessor's spending already counted.
       */
      const purged = await purgeGroup(name);
      logger.info('Admin deleted a user group', { adminId: auth.userId, group: name, purgedRows: purged });
      return jsonResponse(200, { success: true });
    }

    /* Membership and appointment, both by username, both super-admin only. */
    if (method === 'POST' && path === '/admin/groups/membership') {
      const auth = await authenticateRequest(authorization);
      if (!isSuperAdmin(auth.membership)) {
        return jsonResponse(403, { error: 'この操作はアカウント管理者のみが実行できます' });
      }
      const body = getBodyString(event);
      let input: { username?: unknown; group?: unknown };
      try { input = JSON.parse(body); } catch { return jsonResponse(400, { error: 'Invalid JSON body' }); }
      if (!input.username || typeof input.username !== 'string') {
        return jsonResponse(400, { error: 'username is required' });
      }
      // `null` is "belongs to no group", which is a real thing to ask for and
      // the only way to take somebody out of one.
      if (input.group !== null && !isValidGroupName(input.group)) {
        return jsonResponse(400, { error: 'group must be a valid group name or null' });
      }
      /*
       * 409, not 500. Removing a group's administrator while other members
       * remain is refused — see `setUserGroup` — and the refusal carries the
       * sentence the operator needs, so it is passed through rather than
       * flattened into the generic handler below.
       */
      try {
        await setUserGroup(input.username, input.group === null ? null : String(input.group).trim());
      } catch (e) {
        if (e instanceof GroupWouldLoseAdminError) return jsonResponse(409, { error: e.message });
        throw e;
      }
      logger.info('Admin moved a user between groups', {
        adminId: auth.userId, username: input.username, group: input.group,
      });
      return jsonResponse(200, { success: true });
    }

    if (method === 'POST' && path === '/admin/groups/admin') {
      const auth = await authenticateRequest(authorization);
      if (!isSuperAdmin(auth.membership)) {
        return jsonResponse(403, { error: 'この操作はアカウント管理者のみが実行できます' });
      }
      const body = getBodyString(event);
      let input: { group?: unknown; username?: unknown };
      try { input = JSON.parse(body); } catch { return jsonResponse(400, { error: 'Invalid JSON body' }); }
      if (!isValidGroupName(input.group)) return jsonResponse(400, { error: 'group is required' });
      if (input.username !== null && (!input.username || typeof input.username !== 'string')) {
        return jsonResponse(400, { error: 'username must be a string or null' });
      }
      /*
       * One appointment, not an add and a remove the caller sequences. "One
       * admin per group" is a property of the group, and a caller that forgets
       * the removal leaves two — which nothing downstream would notice, because
       * both would simply work.
       */
      await setGroupAdmin(String(input.group).trim(), input.username === null ? null : String(input.username));
      logger.info('Admin appointed a group administrator', {
        adminId: auth.userId, group: input.group, username: input.username,
      });
      return jsonResponse(200, { success: true });
    }

    // GET /admin/users — Cognitoユーザー一覧
    if (method === 'GET' && path === '/admin/users') {
      const auth = await authenticateRequest(authorization);
      if (!canOpenAdminPanel(auth.membership)) return jsonResponse(403, { error: 'Admin access required' });
      const allCognitoUsers: any[] = [];
      let cognitoPaginationToken: string | undefined;
      do {
        const res = await cognitoClient.send(new ListUsersCommand({
          UserPoolId: USER_POOL_ID,
          Limit: 60,
          ...(cognitoPaginationToken ? { PaginationToken: cognitoPaginationToken } : {}),
        }));
        allCognitoUsers.push(...(res.Users ?? []));
        cognitoPaginationToken = res.PaginationToken;
      } while (cognitoPaginationToken);
      const attr = (u: any, name: string): string | undefined =>
        u.Attributes?.find((a: { Name?: string; Value?: string }) => a.Name === name)?.Value;
      // The same lookup the usage route makes — see `groupByUsername`.
      const groupOf = await groupByUsername();
      const users = allCognitoUsers.map((u) => {
        const email = attr(u, 'email') ?? '';
        const placement = groupOf.get(String(u.Username));
        return {
          group: placement?.group ?? null,
          isGroupAdmin: Boolean(placement?.isAdmin),
          // Cognito's own username, which for this pool is the email address —
          // it is what every other route addresses a user by, and it is not the
          // name people are shown.
          username: u.Username,
          email,
          displayName: displayNameFor(email, attr(u, 'name')),
          /*
           * Whether the name is stored or derived. The row is not editable
           * differently either way, but an administrator looking at a column of
           * names should be able to tell which of them anybody actually chose.
           */
          displayNameSet: Boolean((attr(u, 'name') ?? '').trim()),
          status: u.UserStatus,
          enabled: u.Enabled,
          createdAt: u.UserCreateDate?.toISOString(),
        };
      });
      /*
       * Same narrowing as the usage table, and by username rather than email
       * because that is what this listing is keyed by. A group-admin's directory
       * is their group's directory.
       */
      if (!isSuperAdmin(auth.membership)) {
        const mine = new Set(await membersOf(auth.membership.group ?? ''));
        return jsonResponse(200, { users: users.filter((u) => mine.has(String(u.username))), scope: auth.membership.group });
      }
      return jsonResponse(200, { users });
    }

    // POST /admin/users — Cognitoユーザー作成
    if (method === 'POST' && path === '/admin/users') {
      const auth = await authenticateRequest(authorization);
      if (!isSuperAdmin(auth.membership)) {
        return jsonResponse(403, { error: 'この操作はアカウント管理者のみが実行できます' });
      }
      const body = getBodyString(event);
      let input: { email?: string; temporaryPassword?: string; displayName?: string };
      try { input = JSON.parse(body); } catch { return jsonResponse(400, { error: 'Invalid JSON' }); }
      if (!input.email || typeof input.email !== 'string') return jsonResponse(400, { error: 'email is required' });
      if (!input.temporaryPassword || typeof input.temporaryPassword !== 'string') return jsonResponse(400, { error: 'temporaryPassword is required' });
      /*
       * Required at creation, rather than defaulted from the address.
       *
       * The fallback exists for accounts made before names did; a new account is
       * being made by an administrator on a form that asks for one, and letting
       * it through empty would create the only kind of account nobody can
       * explain — one whose name was never decided, in a system where names are
       * decided by exactly one person.
       */
      if (!isValidDisplayName(input.displayName)) {
        return jsonResponse(400, { error: `ユーザー名は1〜${DISPLAY_NAME_MAX}文字で入力してください` });
      }
      const createCmd = new AdminCreateUserCommand({
        UserPoolId: USER_POOL_ID,
        // The email, still: sign-in is unchanged by any of this.
        Username: input.email,
        TemporaryPassword: input.temporaryPassword,
        UserAttributes: [
          { Name: 'email', Value: input.email },
          { Name: 'email_verified', Value: 'true' },
          { Name: 'name', Value: input.displayName.trim() },
        ],
        MessageAction: 'SUPPRESS',
      });
      let createRes;
      try {
        createRes = await cognitoClient.send(createCmd);
      } catch (err: any) {
        const code: string = err.name || err.__type || '';
        if (code === 'UsernameExistsException') return jsonResponse(409, { error: 'このメールアドレスはすでに登録されています' });
        if (code === 'InvalidPasswordException') return jsonResponse(400, { error: `パスワードが要件を満たしていません: ${err.message}` });
        if (code === 'InvalidParameterException') return jsonResponse(400, { error: err.message || '入力値が不正です' });
        if (code === 'TooManyRequestsException') return jsonResponse(429, { error: 'リクエストが多すぎます。しばらくしてから再試行してください' });
        logger.error('AdminCreateUser failed', { error: String(err), code });
        return jsonResponse(500, { error: `ユーザー作成に失敗しました: ${err.message || code}` });
      }
      const user = createRes.User;
      logger.info('Admin created user', { adminId: auth.userId, newUserEmail: input.email });
      return jsonResponse(201, {
        user: {
          username: user?.Username,
          email: input.email,
          displayName: input.displayName.trim(),
          displayNameSet: true,
          status: user?.UserStatus,
          enabled: user?.Enabled,
          createdAt: user?.UserCreateDate?.toISOString(),
        },
      });
    }

    // PATCH /admin/users/:username — ユーザー有効/無効切り替え
    if (method === 'PATCH' && path.startsWith('/admin/users/')) {
      const auth = await authenticateRequest(authorization);
      if (!canOpenAdminPanel(auth.membership)) return jsonResponse(403, { error: 'Admin access required' });
      const username = decodeURIComponent(path.replace('/admin/users/', ''));
      if (!username) return jsonResponse(400, { error: 'username is required' });
      /*
       * By Cognito username, which is the address — the same key the directory
       * listing above is filtered by, so a group-admin can only edit a row they
       * can see.
       */
      if (!isSuperAdmin(auth.membership)) {
        const mine = new Set(await membersOf(auth.membership.group ?? ''));
        if (!mine.has(username)) return jsonResponse(403, { error: 'このユーザーはあなたのグループに属していません' });
      }
      const body = getBodyString(event);
      let input: { enabled?: boolean; displayName?: string };
      try { input = JSON.parse(body); } catch { return jsonResponse(400, { error: 'Invalid JSON body' }); }

      /*
       * One route, two edits, and exactly one of them per request.
       *
       * Naming and enabling are unrelated, and a body carrying both would have to
       * decide what a half-applied request means — Cognito has no transaction
       * across the two calls. Refusing the combination is the whole answer, and
       * the client never sends one.
       */
      const wantsName = input.displayName !== undefined;
      const wantsEnabled = input.enabled !== undefined;
      if (wantsName === wantsEnabled) {
        return jsonResponse(400, { error: 'enabled (boolean) または displayName のどちらか一方が必要です' });
      }

      if (wantsName) {
        if (!isValidDisplayName(input.displayName)) {
          return jsonResponse(400, { error: `ユーザー名は1〜${DISPLAY_NAME_MAX}文字で入力してください` });
        }
        /*
         * Only an administrator reaches this — the group check above is the
         * whole authorisation, and it is the reason there is no self-service
         * equivalent anywhere else in the file. A user changing their own name
         * would need a route that does not exist.
         */
        await cognitoClient.send(new AdminUpdateUserAttributesCommand({
          UserPoolId: USER_POOL_ID,
          Username: username,
          UserAttributes: [{ Name: 'name', Value: input.displayName.trim() }],
        }));
        // So the renamed user's own header does not keep the old name for the
        // rest of the cache window.
        forgetDisplayName(username);
        logger.info('Admin renamed user', { adminId: auth.userId, username });
        return jsonResponse(200, { success: true, displayName: input.displayName.trim() });
      }

      if (typeof input.enabled !== 'boolean') return jsonResponse(400, { error: 'enabled (boolean) is required' });
      if (input.enabled) {
        await cognitoClient.send(new AdminEnableUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));
      } else {
        await cognitoClient.send(new AdminDisableUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));
      }
      logger.info('Admin toggled user enabled', { adminId: auth.userId, username, enabled: input.enabled });
      return jsonResponse(200, { success: true, enabled: input.enabled });
    }

    // DELETE /admin/users/:username — Cognitoユーザー削除
    if (method === 'DELETE' && path.startsWith('/admin/users/')) {
      const auth = await authenticateRequest(authorization);
      if (!isSuperAdmin(auth.membership)) {
        return jsonResponse(403, { error: 'この操作はアカウント管理者のみが実行できます' });
      }
      const username = decodeURIComponent(path.replace('/admin/users/', ''));
      if (!username) return jsonResponse(400, { error: 'username is required' });
      if (username.toLowerCase() === auth.email.toLowerCase()) return jsonResponse(400, { error: 'Cannot delete your own account' });

      /*
       * The `sub` first, while the account still exists to be asked.
       *
       * Every row this user wrote is under `USER#<sub>`, and every document
       * under `projects/<sub>/` and `versions/<sub>/`, but the route addresses
       * people by username — so the only handle on their storage has to be
       * fetched before the account holding it is deleted. Read after, it is
       * unobtainable and the data is unreachable for good.
       */
      let sub: string | null = null;
      try {
        const record = await cognitoClient.send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));
        sub = record.UserAttributes?.find((a) => a.Name === 'sub')?.Value ?? null;
      } catch (e) {
        logger.warn('Could not resolve the sub of an account being deleted', { username, error: String(e) });
      }

      await cognitoClient.send(new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));

      /*
       * Then everything they stored. Deleting the account used to be the whole
       * of it, which left the partition and the documents behind — and the
       * usage panel had by then started HIDING rows belonging to no live
       * account, so the orphans stopped being listed at the same moment they
       * stopped being deleted.
       *
       * After the Cognito call on purpose: the account has to stop being able
       * to sign in and write more before its storage is swept, or the sweep
       * races the person it is sweeping. The cost is that a failure here leaves
       * exactly what the old behaviour left, which is why it is logged with a
       * count rather than swallowed.
       */
      const purged = sub ? await purgeAccount(sub) : { rows: 0, objects: 0 };
      if (!sub) logger.error('Account deleted without purging its storage', { adminId: auth.userId, username });
      logger.info('Admin deleted user', { adminId: auth.userId, deletedUsername: username, ...purged });
      return jsonResponse(200, { success: true, purged });
    }

    if (method === 'GET' && path.startsWith('/jobs/')) {
      const auth = await authenticateRequest(authorization);
      const jobId = decodeURIComponent(path.replace('/jobs/', ''));
      if (!jobId) return jsonResponse(400, { error: 'jobId is required' });
      const job = await getJob(jobId);
      if (!job) return jsonResponse(404, { error: 'Job not found' });
      if (job.userId !== auth.userId) return jsonResponse(403, { error: 'Forbidden' });

      // Doubles as the Runtime session heartbeat while work is still in flight.
      if (job.status === 'pending' || job.status === 'running') keepRuntimeSessionAlive(jobId);

      /**
       * Put back whatever the job kept out of its record.
       *
       * Large payloads travel through S3 so the job item stays under DynamoDB's
       * 400KB cap; the client is not meant to know that, so they are restored here.
       * The `pages` and `variations` shapes that used to be handled alongside these
       * were removed: multi-page and variations are gone, so no job could produce
       * them, and code that hydrates a shape nothing writes only reads as support.
       */
      let result = job.result as Record<string, unknown> | undefined;
      if (result) {
        // generate / modify / reverse-engineer: the document.
        if (typeof (result as any).s3Key === 'string') {
          const html = await getJobPageHtml((result as any).s3Key as string);
          const { s3Key: _key, ...rest } = result;
          result = { ...rest, html };
        }
        // plan: the design specification, which /generate takes back as approvedPlan.
        if (typeof (result as any).specS3Key === 'string') {
          const spec = await getJobPageHtml((result as any).specS3Key as string);
          const { specS3Key: _sk, ...rest } = result;
          result = { ...rest, spec };
        }
      }

      return jsonResponse(200, {
        jobId: job.jobId,
        status: job.status,
        result,
        error: job.error,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        events: job.events ?? [],
        // Live model output, for showing the response as it is written.
        streamTail: job.streamTail,
        streamChars: job.streamChars,
        // Cumulative for the run; the client differences it per step.
        streamTokens: job.streamTokens,
        streamPhase: job.streamPhase,
      });
    }

    /*
     * What this deployment is configured to run, and where each value is set.
     *
     * Super-admin only. It reports the account's own infrastructure — model
     * ids, bucket names, pool ids, role ARNs — which is the account
     * administrator's business and not a group administrator's, and a group
     * administrator's panel is scoped to their own people by design.
     */
    if (method === 'GET' && path === '/admin/models') {
      const auth = await authenticateRequest(authorization);
      if (!isSuperAdmin(auth.membership)) {
        return jsonResponse(403, { error: 'この情報はアカウント管理者のみが参照できます' });
      }
      /*
       * The same period rules as `/admin/usage`, stated once here rather than
       * shared: two routes agreeing by copy is how they came to disagree in this
       * codebase before, so the messages are identical strings and
       * `usage-period.test.mjs` reads both.
       */
      const q = event.queryStringParameters ?? {};
      const from = q.from ?? getCurrentMonthKey();
      const to = q.to ?? from;
      if (!isMonthKey(from) || !isMonthKey(to)) {
        return jsonResponse(400, { error: 'from と to は YYYY-MM 形式で指定してください' });
      }
      if (to < from) {
        return jsonResponse(400, { error: '終了月は開始月より前にできません' });
      }
      if (monthsBetween(from, to).length > 24) {
        return jsonResponse(400, { error: '期間は24ヶ月までです' });
      }
      const [inventory, series] = await Promise.all([
        getModelInventory(),
        getMonthlySeries(from, to),
      ]);
      return jsonResponse(200, { ...inventory, period: { from, to }, series });
    }

    // Model tiers with the versions currently configured in Parameter Store, so the
    // composer can label the chips with what will actually run.
    if (method === 'GET' && path === '/models') {
      await authenticateRequest(authorization);
      try {
        const cfg = await getModelConfig();
        return jsonResponse(200, {
          /*
           * Filtered here rather than in the composer, so the menu cannot offer a
           * model this build refuses. The composer's own fallback list exists for
           * the moment before this answers and is filtered to match; the test
           * holds the two together.
           */
          models: [
            // First, and the default: the tier is chosen from the brief.
            { id: 'auto', label: '自動', version: null, modelId: '' },
            /*
             * Masked: this route answers every signed-in user, not only admins,
             * and nothing in the frontend reads `modelId` — so it was sending the
             * AWS account id to everyone for no purpose. See utils/mask-account.ts.
             */
            { id: 'haiku', label: 'Haiku', version: modelVersion(cfg.haikuId), modelId: maskAccountId(cfg.haikuId) },
            { id: 'sonnet', label: 'Sonnet', version: modelVersion(cfg.sonnetId), modelId: maskAccountId(cfg.sonnetId) },
            { id: 'opus', label: 'Opus', version: modelVersion(cfg.opusId), modelId: maskAccountId(cfg.opusId) },
          ].filter((m) => !isWithdrawnModel(m.id)),
          default: 'auto',
        });
      } catch (e) {
        logger.warn('Model config lookup failed', { error: String(e) });
        return jsonResponse(200, { models: [], default: 'auto' });
      }
    }

    // --- Project management endpoints ---
    if (method === 'GET' && path === '/projects') {
      const auth = await authenticateRequest(authorization);
      const projects = await listProjects(auth.userId);
      return jsonResponse(200, { projects });
    }

    if (method === 'POST' && path === '/projects') {
      const auth = await authenticateRequest(authorization);
      const body = getBodyString(event);
      let input: { name: string };
      try { input = JSON.parse(body); } catch { return jsonResponse(400, { error: 'Invalid JSON body' }); }
      if (!input.name || typeof input.name !== 'string') return jsonResponse(400, { error: 'name is required' });
      if (input.name.length > 100) return jsonResponse(400, { error: 'name must be 100 characters or fewer' });
      const project = await createProject(auth.userId, input.name);
      return jsonResponse(201, project);
    }

    // Recovers a project whose stored preview is missing, by falling back to the
    // last document the job itself wrote to version history. Kept as its own
    // route rather than folded into GET /projects so the list stays cheap — it
    // is only consulted for the one project actually being opened.
    const previewMatch = path.match(/^\/projects\/([^/]+)\/preview$/);
    if (method === 'GET' && previewMatch) {
      const auth = await authenticateRequest(authorization);
      const projectId = decodeURIComponent(previewMatch[1]);
      const html = await getLatestProjectHtml(auth.userId, projectId);
      return jsonResponse(200, { html });
    }

    // --- Chat messages endpoints (must be checked before /projects/:id PUT/DELETE) ---
    const chatMatch = path.match(/^\/projects\/([^/]+)\/messages$/);
    if (chatMatch) {
      const auth = await authenticateRequest(authorization);
      const projectId = decodeURIComponent(chatMatch[1]);

      if (method === 'GET') {
        const messages = await getChatMessages(auth.userId, projectId);
        return jsonResponse(200, { messages });
      }

      if (method === 'PUT') {
        const body = getBodyString(event);
        let input: { messages: unknown[] };
        try { input = JSON.parse(body); } catch { return jsonResponse(400, { error: 'Invalid JSON body' }); }
        if (!Array.isArray(input.messages)) return jsonResponse(400, { error: 'messages must be an array' });
        await saveChatMessages(auth.userId, projectId, input.messages as any);
        return jsonResponse(200, { message: 'Messages saved' });
      }
    }

    if (method === 'PUT' && path.startsWith('/projects/')) {
      const auth = await authenticateRequest(authorization);
      const projectId = decodeURIComponent(path.replace('/projects/', ''));
      if (!projectId) return jsonResponse(400, { error: 'projectId is required' });
      const body = getBodyString(event);
      let input: {
        name?: string;
        lastHtml?: string;
        preset?: string;
        model?: string;
        archived?: boolean;
        favourite?: boolean;
      };
      try { input = JSON.parse(body); } catch { return jsonResponse(400, { error: 'Invalid JSON body' }); }
      for (const flag of ['archived', 'favourite'] as const) {
        if (input[flag] !== undefined && typeof input[flag] !== 'boolean') {
          return jsonResponse(400, { error: `${flag} must be a boolean` });
        }
      }
      const existingProject = await import('../services/project-service.js').then(m => m.getProject(auth.userId, projectId));
      if (!existingProject) return jsonResponse(404, { error: 'Project not found' });
      await updateProject(auth.userId, projectId, input);
      return jsonResponse(200, { message: 'Project updated' });
    }

    if (method === 'DELETE' && path.startsWith('/projects/')) {
      const auth = await authenticateRequest(authorization);
      const projectId = decodeURIComponent(path.replace('/projects/', ''));
      if (!projectId) return jsonResponse(400, { error: 'projectId is required' });
      const existingProject = await import('../services/project-service.js').then(m => m.getProject(auth.userId, projectId));
      if (!existingProject) return jsonResponse(404, { error: 'Project not found' });
      /*
       * Deletion is an archive operation.
       *
       * The product rule is that a project is archived first and destroyed from
       * the archive, and this is where that becomes true rather than a habit of
       * one screen. The delete removes the record, the stored document and the
       * thumbnail, and there is nothing to undo it with — so the one step that
       * makes it deliberate is worth enforcing on the server, where a stray
       * client cannot skip it.
       */
      if (!existingProject.archivedAt) {
        return jsonResponse(409, {
          error: 'Project must be archived before it can be deleted',
        });
      }
      await deleteProject(auth.userId, projectId);
      return jsonResponse(200, { message: 'Project deleted' });
    }

    return jsonResponse(404, { error: 'Not found' });

  } catch (error) {
    if (error instanceof AuthError) return jsonResponse((error as any).statusCode, { error: (error as Error).message });
    if (error instanceof GuardrailBlockedError) return jsonResponse((error as any).statusCode, { error: (error as Error).message });
    if ((error as Error).message === 'Request body too large') return jsonResponse(413, { error: 'Request body too large' });
    if (error instanceof URIError) return jsonResponse(400, { error: 'Malformed URL encoding' });

    logger.error('Unhandled Lambda error', { requestId, path, method, error: (error as Error).message });
    return jsonResponse(500, { error: 'Internal server error' });
  }
};
