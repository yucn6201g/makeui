import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { runJob, type JobRequest } from './job-runner.js';
import { logger } from '../utils/logger.js';

/**
 * AgentCore Runtime entry point.
 *
 * The Runtime contract is two routes on port 8080: `GET /ping` for the health
 * probe and `POST /invocations` for work. Everything user-facing stays on the
 * API Lambda — this process only executes queued jobs.
 *
 * Why jobs run detached from the request:
 *   An invocation must answer within 15 minutes, which is exactly the ceiling we
 *   are trying to escape. So `/invocations` schedules the job and answers 202
 *   straight away; the job keeps running in this microVM and reports progress
 *   through the DynamoDB job record, which is what the client already polls.
 *   A session lives up to `maxLifetime` (8h) as long as it is not idle, hence
 *   the `ping` payload the API Lambda sends while a job is in flight.
 */

const PORT = parseInt(process.env.PORT || '8080', 10);

/** Jobs currently executing in this microVM, so a retried invoke is not run twice. */
const inFlight = new Map<string, Promise<void>>();

function sendJSON(res: ServerResponse, statusCode: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const MAX_BODY_SIZE = 10 * 1024 * 1024;

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

async function handleInvocations(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let payload: Partial<JobRequest> & { ping?: boolean };
  try {
    payload = JSON.parse(await parseBody(req));
  } catch {
    sendJSON(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  // Heartbeat from the API Lambda: touching the session is the whole point, so
  // there is nothing to do but answer.
  if (payload.ping) {
    sendJSON(res, 200, { status: 'Healthy', running: [...inFlight.keys()] });
    return;
  }

  /*
   * `group` is destructured here for the same reason as everything else: it is
   * dropped otherwise.
   *
   * It was not, and the omission was invisible. The API puts the group on all
   * three job payloads and the worker Lambda forwards it, so the field was
   * correct at both ends — but the Runtime is the PRIMARY dispatch target and
   * the worker only its fallback, so the group survived exactly on the path
   * taken when the Runtime is down. Every healthy generation reached
   * `recordUsage` with `group: undefined`, no `GROUP#<name>/MONTH#<key>` row was
   * ever written, and `checkUsageLimit` therefore read a group's usage as zero.
   *
   * A group budget that cannot be exceeded is not a budget. Two groups with
   * limits set, months of traffic, and no group month row between them is what
   * this looked like from the table.
   */
  const { jobId, userId, group, input, jobType } = payload;
  if (!jobId || !userId || !input) {
    sendJSON(res, 400, { error: 'jobId, userId and input are required' });
    return;
  }

  if (inFlight.has(jobId)) {
    sendJSON(res, 202, { accepted: true, jobId, note: 'already running' });
    return;
  }

  logger.info('Job accepted by runtime', { jobId, jobType: jobType || 'generate' });

  // Detached on purpose — see the note at the top of the file. runJob never
  // rejects; it writes failures onto the job record.
  const task = runJob({ jobId, userId, group, input, jobType }).finally(() => {
    inFlight.delete(jobId);
  });
  inFlight.set(jobId, task);

  sendJSON(res, 202, { accepted: true, jobId });
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const path = new URL(req.url ?? '/', `http://localhost:${PORT}`).pathname;
  try {
    if (req.method === 'GET' && path === '/ping') {
      sendJSON(res, 200, { status: 'Healthy' });
    } else if (req.method === 'POST' && path === '/invocations') {
      await handleInvocations(req, res);
    } else {
      sendJSON(res, 404, { error: 'Not found' });
    }
  } catch (error) {
    logger.error('Runtime request failed', { path, error: (error as Error).message });
    if (!res.headersSent) sendJSON(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  logger.info('AgentCore Runtime started', { port: PORT });
});

/**
 * SIGTERM arrives when the session is being reclaimed. Give running jobs a
 * chance to finish rather than leaving the client polling a job that will never
 * change state.
 */
const DRAIN_TIMEOUT_MS = 120_000;
let draining = false;

function shutdown(signal: string) {
  if (draining) return;
  draining = true;
  logger.info('Runtime shutdown initiated', { signal, inFlight: inFlight.size });
  server.close();
  const timer = setTimeout(() => {
    logger.warn('Forcing runtime shutdown', { inFlight: inFlight.size });
    process.exit(1);
  }, DRAIN_TIMEOUT_MS);
  Promise.allSettled([...inFlight.values()]).then(() => {
    clearTimeout(timer);
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A rejected promise anywhere must not take the microVM down while other jobs
// are still running; runJob already records job-level failures.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection in runtime', { reason: String(reason) });
});

export { server };
