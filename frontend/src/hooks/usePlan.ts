import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { requestErrorMessage } from '../utils/request';
import { appendPhase, closeTranscript, type PhaseEntry } from '../utils/phaseTranscript';
import { pollAuthToken, isAuthRefusal, AUTH_RETRY_BUDGET } from '../utils/pollAuth';

export interface PlanResult {
  /** Readable proposal, shown in the thread for approval. */
  plan: string;
  /** Design specification behind it, handed to /generate on approval. */
  spec: string;
  /** The prompt this plan answers, so approving it can rebuild the request. */
  prompt: string;
  /** Which tier actually ran, and the design system it was bound to. */
  runInfo?: { modelTier: string; preset: string };
}

interface UsePlanReturn {
  result: PlanResult | null;
  isPlanning: boolean;
  phases: PhaseEntry[];
  error: string | null;
  plan: (prompt: string, preset: string, model: string, outputKind: string, html?: string, image?: string, attachment?: { name: string; content: string }, images?: string[], imageCaptions?: string[]) => void;
  /** Re-attach to a plan already running on the server. */
  /** `priorPhases` seeds the transcript — see utils/activeJob.ts. */
  resume: (jobId: string, prompt: string, priorPhases?: PhaseEntry[]) => void;
  reset: () => void;
  stop: () => void;
  /** Job id of the run in flight, so the caller can persist it. */
  jobId: string | null;
}

const POLL_INTERVAL_MS = 2000;
/** The design phase alone can run for minutes; match the generate ceiling. */
const POLL_MAX_ATTEMPTS = 480;

/**
 * Plan mode: ask what would be built, without building it.
 *
 * Shares the job/poll shape with generate and modify because it is the same
 * machinery — the server runs the design phase as a job and reports progress the
 * same way. What differs is that it stops there and returns a proposal.
 */
export function usePlan(): UsePlanReturn {
  const { token } = useAuth();
  const tokenRef = useRef(token);
  useEffect(() => { tokenRef.current = token; }, [token]);

  const [result, setResult] = useState<PlanResult | null>(null);
  const [isPlanning, setIsPlanning] = useState(false);
  const [phases, setPhases] = useState<PhaseEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollFetchAbortRef = useRef<AbortController | null>(null);
  const pollAttemptsRef = useRef(0);
  /** Consecutive refused polls. Reset by any poll that answers. */
  const authRetriesRef = useRef(0);
  // Carried through the poll so the approved plan knows what it answers.
  const promptRef = useRef('');

  const cancelInFlight = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    pollFetchAbortRef.current?.abort();
    pollFetchAbortRef.current = null;
    pollAttemptsRef.current = 0;
  }, []);

  const reset = useCallback(() => {
    cancelInFlight();
    setResult(null);
    setPhases([]);
    setError(null);
    setJobId(null);
    setIsPlanning(false);
  }, [cancelInFlight]);

  const stop = useCallback(() => {
    cancelInFlight();
    setPhases(closeTranscript);
    setIsPlanning(false);
  }, [cancelInFlight]);

  const pollJob = useCallback((jobId: string, apiUrl: string) => {
    if (pollAttemptsRef.current >= POLL_MAX_ATTEMPTS) {
      setError('プランの作成がタイムアウトしました');
      setIsPlanning(false);
      return;
    }
    pollAttemptsRef.current += 1;

    pollFetchAbortRef.current?.abort();
    const controller = new AbortController();
    pollFetchAbortRef.current = controller;

    // Read at request time, not captured — see utils/pollAuth.ts.
    pollAuthToken(tokenRef.current)
      .then((bearer) => fetch(`${apiUrl}/jobs/${jobId}`, {
        headers: { Authorization: `Bearer ${bearer}` },
        signal: controller.signal,
      }))
      .then(async (res) => {
        if (!res.ok) {
          const err = new Error(`Poll failed: ${res.status}`);
          (err as Error & { status?: number }).status = res.status;
          throw err;
        }
        return res.json();
      })
      .then((data: { status: string; result?: { plan?: string; spec?: string; modelTier?: string; preset?: string }; error?: string; streamTail?: string; streamChars?: number; streamPhase?: string }) => {
        // The budget is for CONSECUTIVE refusals; one that answers clears it.
        authRetriesRef.current = 0;
        if (data.streamPhase) {
          setPhases((prev) => appendPhase(prev, data.streamPhase!, data.streamTail ?? '', data.streamChars ?? 0));
        }
        if (data.status === 'completed' && data.result) {
          setResult({
            plan: data.result.plan ?? '',
            spec: data.result.spec ?? '',
            prompt: promptRef.current,
            runInfo: data.result.modelTier
              ? { modelTier: data.result.modelTier, preset: data.result.preset || 'none' }
              : undefined,
          });
          setPhases(closeTranscript);
          setIsPlanning(false);
        } else if (data.status === 'failed') {
          setError(data.error || 'プランの作成に失敗しました');
          setPhases(closeTranscript);
          setIsPlanning(false);
        } else {
          pollTimerRef.current = setTimeout(() => pollJob(jobId, apiUrl), POLL_INTERVAL_MS);
        }
      })
      .catch((err: Error & { status?: number; name: string }) => {
        if (err.name === 'AbortError') return;
        // A refused poll is not a finished job — see utils/pollAuth.ts.
        if (isAuthRefusal(err.status) && authRetriesRef.current < AUTH_RETRY_BUDGET) {
          authRetriesRef.current += 1;
          pollTimerRef.current = setTimeout(() => pollJob(jobId, apiUrl), POLL_INTERVAL_MS * 2);
          return;
        }
        if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) {
          setError('認証エラーが発生しました。再度ログインしてください。');
          setIsPlanning(false);
          return;
        }
        pollTimerRef.current = setTimeout(() => pollJob(jobId, apiUrl), POLL_INTERVAL_MS * 2);
      });
  }, []);

  const plan = useCallback(
    (prompt: string, preset: string, model: string, outputKind: string, html?: string, image?: string, attachment?: { name: string; content: string }, images?: string[], imageCaptions?: string[]) => {
      if (!token) {
        setError('ログインの有効期限が切れています。再度ログインしてください。');
        return;
      }
      cancelInFlight();
      setResult(null);
      setPhases([]);
      setError(null);
      setIsPlanning(true);
      promptRef.current = prompt;

      const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:8080';
      const controller = new AbortController();
      abortRef.current = controller;

      fetch(`${apiUrl}/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt, preset, model, outputKind, ...(html ? { html } : {}), ...(image ? { image } : {}), ...(attachment ? { attachment } : {}), ...(images && images.length > 0 ? { images } : {}), ...(imageCaptions && imageCaptions.some((c) => c && c.trim()) ? { imageCaptions } : {}) }),
        signal: controller.signal,
      })
        .then(async (res) => {
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
          }
          return res.json();
        })
        .then((data: { jobId?: string }) => {
          if (!data.jobId) throw new Error('No jobId returned');
          setJobId(data.jobId);
          pollAttemptsRef.current = 0;
          pollJob(data.jobId, apiUrl);
        })
        .catch((err: Error) => {
          if (err.name === 'AbortError') return;
          setError(requestErrorMessage(err, 'プランの作成を開始できませんでした。もう一度お試しください。'));
          setIsPlanning(false);
        });
    },
    [token, cancelInFlight, pollJob]
  );

  /**
   * Re-attach to a plan started before the user navigated away. The design phase
   * runs for minutes, so dropping the client mid-run would throw away real work
   * that the server is still doing.
   */
  const resume = useCallback((id: string, prompt: string, priorPhases?: PhaseEntry[]) => {
    if (!tokenRef.current) return;
    promptRef.current = prompt;
  /*
   * Seeded with the transcript the caller kept, if it kept one.
   *
   * The server holds one `streamPhase` — the current step — so polling alone
   * rebuilds the list from whichever step is running and the history is gone.
   * See utils/activeJob.ts.
   */
    if (priorPhases && priorPhases.length > 0) setPhases(priorPhases);
    setJobId(id);
    setIsPlanning(true);
    setError(null);
    pollAttemptsRef.current = 0;
    pollJob(id, import.meta.env.VITE_API_URL || 'http://localhost:8080');
  }, [pollJob]);

  useEffect(() => cancelInFlight, [cancelInFlight]);

  return { result, isPlanning, phases, error, plan, resume, reset, stop, jobId };
}
