/**
 * Tracks the in-flight generation/modification for a project.
 *
 * Generation runs as a server-side job that outlives the page, but the polling
 * state lived only in the component. Leaving the project and coming back
 * therefore dropped the progress display even though the work was still running.
 * Recording the job id lets the client re-attach to it on return.
 */

export type ActiveJobKind = 'generate' | 'modify' | 'plan';

/**
 * Composer state the run was started with.
 *
 * The project record only learns the preset and model once a run *completes*, and
 * the output format is never stored there at all. Without carrying them here, a
 * mid-generation return re-attached to the job but reset the chips to the last
 * finished run's values — so the settings on screen no longer described the work
 * being watched.
 */
export interface ActiveJobSettings {
  preset: string;
  model: 'auto' | 'haiku' | 'sonnet' | 'opus';
  outputKind: string;
  /**
   * The prompt the run answers. Only a plan needs it: approving the proposal
   * rebuilds the original request, which is not recoverable from the job record.
   */
  prompt?: string;
}

export interface ActiveJob {
  jobId: string;
  kind: ActiveJobKind;
  /** Epoch ms, used to discard records left behind by a crashed tab. */
  startedAt: number;
  settings?: ActiveJobSettings;
}

const KEY_PREFIX = 'makeui:activeJob:';
/** Beyond the worker's own 900s ceiling there is nothing left to re-attach to. */
const MAX_AGE_MS = 20 * 60 * 1000;

function key(projectId: string): string {
  return `${KEY_PREFIX}${projectId}`;
}

export function setActiveJob(
  projectId: string,
  jobId: string,
  kind: ActiveJobKind,
  settings?: ActiveJobSettings
): void {
  if (!projectId) return;
  try {
    // Keep the original startedAt: this runs on every render while the job is in
    // flight, and refreshing the timestamp would stop MAX_AGE_MS from expiring.
    const existing = getActiveJob(projectId);
    const startedAt = existing?.jobId === jobId ? existing.startedAt : Date.now();
    localStorage.setItem(key(projectId), JSON.stringify({ jobId, kind, startedAt, settings }));
  } catch {
    // Storage unavailable (private mode, quota) — resuming is a convenience, not a
    // requirement, so a failure here must not break starting the job.
  }
}

export function getActiveJob(projectId: string): ActiveJob | null {
  if (!projectId) return null;
  try {
    const raw = localStorage.getItem(key(projectId));
    if (!raw) return null;
    const job = JSON.parse(raw) as ActiveJob;
    if (!job?.jobId || Date.now() - job.startedAt > MAX_AGE_MS) {
      localStorage.removeItem(key(projectId));
      return null;
    }
    return job;
  } catch {
    return null;
  }
}

export function clearActiveJob(projectId: string): void {
  if (!projectId) return;
  try {
    localStorage.removeItem(key(projectId));
    localStorage.removeItem(phaseKey(projectId));
  } catch {
    /* ignore */
  }
}

/**
 * The step-by-step transcript of a run that is still going.
 *
 * Re-attaching restored the job and lost its history. The server keeps a list
 * of pipeline `events` and the LATEST `streamPhase` — one value, overwritten on
 * every write — so the phase list a person watches is built in the browser by
 * observing that one value change over successive polls. It lives in a hook's
 * state and nowhere else, so leaving the project threw it away and coming back
 * rebuilt it from whichever step happened to be running: eight steps of
 * transcript became one.
 *
 * Kept separately from the job record because that record is rewritten on every
 * render while a job is in flight, and this is the larger of the two by an
 * order of magnitude.
 */
const PHASE_PREFIX = 'makeui:activePhases:';

function phaseKey(projectId: string): string {
  return `${PHASE_PREFIX}${projectId}`;
}

export function setActivePhases(projectId: string, phases: unknown[]): void {
  if (!projectId) return;
  try {
    if (phases.length === 0) localStorage.removeItem(phaseKey(projectId));
    else localStorage.setItem(phaseKey(projectId), JSON.stringify(phases));
  } catch {
    // Quota, most likely: a transcript is a convenience and losing it must not
    // break the run it describes.
  }
}

export function getActivePhases(projectId: string): unknown[] | null {
  if (!projectId) return null;
  try {
    const raw = localStorage.getItem(phaseKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Every project this browser believes is mid-run, for the project list.
 *
 * The list is a different screen from the workspace and asks the same question
 * the workspace answers continuously: is this one busy? The records are already
 * here, one per project — reading them is cheaper and more honest than asking
 * the server, which would need a query per card.
 *
 * Local to this browser, which is the limitation worth naming: a run started on
 * a phone is not marked on a laptop. It is still right far more often than
 * nothing, and the alternative is a job index the server does not keep.
 */
export function activeJobProjectIds(): Set<string> {
  const out = new Set<string>();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(KEY_PREFIX)) continue;
      const projectId = k.slice(KEY_PREFIX.length);
      // Through `getActiveJob`, so an expired record is dropped here too rather
      // than marking a card as busy for the rest of the browser's life.
      if (getActiveJob(projectId)) out.add(projectId);
    }
  } catch {
    /* ignore */
  }
  return out;
}
