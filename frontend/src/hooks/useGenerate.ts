import { useState, useCallback, useRef, useEffect } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { appendPhase, closeTranscript, type PhaseEntry } from '../utils/phaseTranscript';
import { postJson, requestErrorMessage } from '../utils/request';
import { pollAuthToken, isAuthRefusal, AUTH_RETRY_BUDGET } from '../utils/pollAuth';


/**
 * The score, decomposed.
 *
 * One number summing a file-layout checklist and a browser's findings reads as a
 * judgement about the UI and is not one: two runs of the same brief scored 84
 * and 69, and most of that was two absent directories on the LARGER project,
 * which reached all five screens with no console errors. The parts are carried
 * so the number can say which half moved.
 */
export interface ScoreParts {
  /**
   * Which scale the score was measured on — backend `SCORE_RUBRIC`.
   *
   * Carried so that a number from before the rubric changed is not silently
   * compared with one from after. 427 stored versions were scored on scale 1,
   * where 22 checks every document passed still counted as 99 of 176 points.
   */
  rubric?: number;
  contract: { earned: number; possible: number };
  runtime: { earned: number; possible: number; penalty: number } | null;
}

export interface StreamEvent {
  type: string;
  data?: {
    phase?: string;
    agent?: string;
    status?: string;
    html?: string;
    qualityScore?: number;
    message?: string;
    [key: string]: unknown;
  };
  timestamp?: number;
  [key: string]: unknown;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

interface UseGenerateReturn {
  events: StreamEvent[];
  result: string | null;
  score: number | null;
  /** What the browser measured. Null when the page was never rendered. */
  /** Which tier actually ran, and the design system it was bound to. */
  runInfo: { modelTier: string; preset: string; effort?: string; scoreVerified?: boolean; unrepairedDefects?: number;
    /** `qualityScore` taken apart — the checklist, and what a browser found. */
    scoreParts?: ScoreParts } | null;
  /** The client gave up waiting, but the job is still running server-side. */
  abandoned: boolean;
  tokenUsage: TokenUsage | null;
  isGenerating: boolean;
  /** Prose the model wrote before the document, kept as its reasoning. */
  plan: string | null;
  /** Trailing slice of the model output as it is being written. */
  streamTail: string | null;
  /** Label of the step currently producing output. */
  streamPhase: string | null;
  /** Characters generated so far. */
  streamChars: number;
  /** Every step of this run with the reasoning it produced, oldest first. */
  phases: PhaseEntry[];
  error: string | null;
  generate: (prompt: string, preset: string, model: string, image?: string, projectId?: string, outputKind?: string, approvedPlan?: string, effort?: string, attachment?: { name: string; content: string }, images?: string[], imageCaptions?: string[]) => void;
  reset: () => void;
  stop: () => void;
  /** Re-attach to a job that is already running on the server. */
  /** `priorPhases` seeds the transcript — see utils/activeJob.ts. */
  resume: (jobId: string, priorPhases?: PhaseEntry[]) => void;
  /** Job id of the run in flight, so the caller can persist it. */
  jobId: string | null;
}

const POLL_INTERVAL_MS = 2000;
/**
 * How long the client will wait before it stops asking.
 *
 * 16 minutes was not enough and it cost users finished work. Measured on two
 * real runs: the design graph spent its full ten-minute budget, the pipeline
 * carried on, and the whole generation ran past 21 minutes — while the client
 * gave up at 16, reported a timeout, and cleared the job record, so the result
 * that did arrive could never be reached.
 *
 * Waiting longer costs a request every two seconds. Giving up early costs the
 * user the entire run. The ceiling exists only to stop an abandoned tab polling
 * forever, so it is set well past any run we have measured.
 */
const POLL_MAX_ATTEMPTS = 900; // 30 minutes

export function useGenerate(): UseGenerateReturn {
  const { token } = useAuth();
  // Polling can outlive a token refresh; always read the newest one.
  const tokenRef = useRef(token);
  useEffect(() => { tokenRef.current = token; }, [token]);
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [result, setResult] = useState<string | null>(null);
  const [score, setScore] = useState<number | null>(null);
  const [runInfo, setRunInfo] = useState<{ modelTier: string; preset: string; effort?: string; scoreVerified?: boolean; unrepairedDefects?: number;
    /** `qualityScore` taken apart — the checklist, and what a browser found. */
    scoreParts?: ScoreParts } | null>(null);
  /** True when the client stopped polling a job that is still running. */
  const [abandoned, setAbandoned] = useState(false);
  /** Consecutive refused polls. Reset by any poll that answers. */
  const authRetriesRef = useRef(0);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [plan, setPlan] = useState<string | null>(null);
  const [streamTail, setStreamTail] = useState<string | null>(null);
  const [streamPhase, setStreamPhase] = useState<string | null>(null)
  const [streamChars, setStreamChars] = useState(0);
  const [phases, setPhases] = useState<PhaseEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollFetchAbortRef = useRef<AbortController | null>(null);
  const pollAttemptsRef = useRef(0);

  const reset = useCallback(() => {
    setEvents([]);
    setResult(null);
    setScore(null);
    setRunInfo(null);
    setAbandoned(false);
    setTokenUsage(null);
    setError(null);
    setPlan(null);
    setStreamTail(null);
    setStreamPhase(null)
    setStreamChars(0);
    setPhases([]);
    setJobId(null);
    setIsGenerating(false);
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (pollFetchAbortRef.current) {
      pollFetchAbortRef.current.abort();
      pollFetchAbortRef.current = null;
    }
    pollAttemptsRef.current = 0;
  }, []);

  /**
   * Detach from the in-flight run: abort the request and stop polling, but keep
   * the events collected so far so the user can see where it got to.
   * Note: the server-side job keeps running — this cancels the client, not the work.
   */
  const stop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (pollFetchAbortRef.current) {
      pollFetchAbortRef.current.abort();
      pollFetchAbortRef.current = null;
    }
    pollAttemptsRef.current = 0;
    setPhases(closeTranscript);
    setIsGenerating(false);
  }, []);

  const pollJob = useCallback(
    (jobId: string, apiUrl: string, authToken: string) => {
      if (pollAttemptsRef.current >= POLL_MAX_ATTEMPTS) {
        /**
         * The client stopped waiting; the job did not stop running. Saying so
         * matters, because the caller uses this to decide whether the job
         * record may be discarded — and discarding it is what made the earlier
         * "timed out" unrecoverable.
         */
        setAbandoned(true);
        setError('生成に時間がかかっています。処理はサーバー側で続いているので、少し待ってからこのプロジェクトを開き直すと結果が表示されます。');
        setIsGenerating(false);
        return;
      }
      pollAttemptsRef.current += 1;

      if (pollFetchAbortRef.current) pollFetchAbortRef.current.abort();
      const pollController = new AbortController();
      pollFetchAbortRef.current = pollController;

      // Read at request time, not captured — see utils/pollAuth.ts.
      pollAuthToken(tokenRef.current ?? authToken)
        .then((bearer) => fetch(`${apiUrl}/jobs/${jobId}`, {
          headers: { Authorization: `Bearer ${bearer}` },
          signal: pollController.signal,
        }))
        .then(async (res) => {
          if (!res.ok) {
            const err = new Error(`Poll failed: ${res.status}`);
            (err as any).status = res.status;
            throw err;
          }
          return res.json();
        })
        .then((data: { status: string; result?: Record<string, unknown>; error?: string; events?: Array<{ agent: string; status: string; t: string }>; streamTail?: string; streamChars?: number; streamTokens?: number; streamPhase?: string }) => {
          // The budget is for CONSECUTIVE refusals; one that answers clears it.
          authRetriesRef.current = 0;
          if (typeof data.streamTail === 'string') setStreamTail(data.streamTail);
          if (typeof data.streamChars === 'number') setStreamChars(data.streamChars)
          if (typeof data.streamPhase === 'string') setStreamPhase(data.streamPhase || null);
          if (data.streamPhase) {
            setPhases((prev) => appendPhase(prev, data.streamPhase!, data.streamTail ?? '', data.streamChars ?? 0, data.streamTokens));
          }
          // Sync pipeline events from server
          if (data.events && data.events.length > 0) {
            setEvents(data.events.map((e) => ({
              type: 'progress',
              data: { agent: e.agent, status: e.status },
              timestamp: new Date(e.t).getTime(),
            })));
          }

          if (data.status === 'completed' && data.result) {
            const r = data.result;
            setResult((r.html as string) || null);
            if (typeof r.plan === 'string' && r.plan.trim()) setPlan(r.plan.trim());
            setScore(typeof r.qualityScore === 'number' ? r.qualityScore : null);
            const meta = r.metadata as Record<string, unknown> | undefined;
            if (meta?.tokenUsage) setTokenUsage(meta.tokenUsage as TokenUsage);
            setRunInfo(
              typeof meta?.modelTier === 'string'
                ? { modelTier: meta.modelTier as string, preset: (meta.preset as string) || 'none', effort: meta.effort as string | undefined, scoreVerified: meta.scoreVerified as boolean | undefined, scoreParts: meta.scoreParts as ScoreParts | undefined, unrepairedDefects: meta.unrepairedDefects as number | undefined }
                : null
            );
            setPhases(closeTranscript);
            setIsGenerating(false);
          } else if (data.status === 'failed') {
            setError(data.error || '生成に失敗しました。もう一度お試しください。');
            setPhases(closeTranscript);
            setIsGenerating(false);
          } else {
            pollTimerRef.current = setTimeout(() => {
              if (authToken) pollJob(jobId, apiUrl, authToken);
            }, POLL_INTERVAL_MS);
          }
        })
        .catch((err) => {
          if (err.name === 'AbortError') return;
          /*
           * A refused poll is not a finished job.
           *
           * The token is refreshed on the next attempt, so the case this covers
           * is the one that used to end the run: a machine waking up with an
           * expired ID token and a job still running on the server.
           */
          if (isAuthRefusal((err as any).status) && authRetriesRef.current < AUTH_RETRY_BUDGET) {
            authRetriesRef.current += 1;
            pollTimerRef.current = setTimeout(() => {
              if (authToken) pollJob(jobId, apiUrl, authToken);
            }, POLL_INTERVAL_MS * 2);
            return;
          }
          if ((err as any).status >= 400 && (err as any).status < 500 && (err as any).status !== 429) {
            setError('認証エラーが発生しました。再度ログインしてください。');
            setIsGenerating(false);
            return;
          }
          // Retry on transient errors
          pollTimerRef.current = setTimeout(() => {
            if (authToken) pollJob(jobId, apiUrl, authToken);
          }, POLL_INTERVAL_MS * 2);
        });
    },
    []
  );

  const generate = useCallback(
    (prompt: string, preset: string, model: string, image?: string, projectId?: string, outputKind?: string, approvedPlan?: string, effort?: string, attachment?: { name: string; content: string }, images?: string[], imageCaptions?: string[]) => {
      if (!token) {
        setError('ログインの有効期限が切れています。再度ログインしてください。');
        return;
      }

      reset();
      setIsGenerating(true);

      const controller = new AbortController();
      abortRef.current = controller;

      const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:8080';

      const body: Record<string, unknown> = { prompt, preset, model };
      if (image) body.image = image;
      if (projectId) body.projectId = projectId;
      if (outputKind) body.outputKind = outputKind;
      // A plan the user reviewed and accepted replaces the design phase entirely,
      // so the build reflects what they approved rather than a fresh interpretation.
      if (approvedPlan) body.approvedPlan = approvedPlan;
      // Which stages of the pipeline this build may run. Omitted means `standard`.
      if (effort) body.effort = effort;
      // The user's own data. Sent whole; the job samples it before any prompt
      // sees it, so the size here is a payload question, not a token one.
      if (attachment) body.attachment = attachment;
      /*
       * Pictures to put IN the UI, as opposed to `image`, which the design phase
       * looks at. Omitted entirely when there are none, so a request that
       * attaches nothing sends exactly the body it sent before.
       */
      if (images && images.length > 0) body.images = images;
      // Aligned with `images` by index; a described picture never reaches the
      // captioning call. Omitted when nothing was described.
      if (imageCaptions && imageCaptions.some((c) => c && c.trim())) body.imageCaptions = imageCaptions;

      postJson<{ jobId?: string; status?: string; html?: string; qualityScore?: number; metadata?: Record<string, unknown> }>({
        url: `${apiUrl}/generate`,
        token,
        body,
        signal: controller.signal,
        hasImage: Boolean(image) || Boolean(images && images.length > 0),
      })
        .then((data) => {
          if (data.jobId) {
            setEvents([{ type: 'progress', data: { status: 'queued' }, timestamp: Date.now() }]);
            setJobId(data.jobId);
            pollAttemptsRef.current = 0;
            pollJob(data.jobId, apiUrl, token);
          } else if (data.html) {
            setResult(data.html);
            setScore(data.qualityScore ?? null);
            const tu = data.metadata?.tokenUsage as { inputTokens?: number; outputTokens?: number } | undefined;
            if (tu) setTokenUsage({ inputTokens: tu.inputTokens || 0, outputTokens: tu.outputTokens || 0 });
            setRunInfo(
              typeof data.metadata?.modelTier === 'string'
                ? { modelTier: data.metadata.modelTier as string, preset: (data.metadata.preset as string) || 'none', effort: data.metadata.effort as string | undefined, scoreVerified: data.metadata.scoreVerified as boolean | undefined, scoreParts: data.metadata.scoreParts as ScoreParts | undefined, unrepairedDefects: data.metadata.unrepairedDefects as number | undefined }
                : null
            );
            setIsGenerating(false);
          } else {
            throw new Error('No jobId returned');
          }
        })
        .catch((err) => {
          if (err.name !== 'AbortError') {
            setError(requestErrorMessage(err, '生成を開始できませんでした。もう一度お試しください。'));
            setIsGenerating(false);
          }
        });
    },
    [token, reset, pollJob]
  );

  /**
   * Attach to a job started earlier (for example before the user navigated away).
   * The server keeps running it, so the client only needs to start polling again.
   */
  const resume = useCallback((id: string, priorPhases?: PhaseEntry[]) => {
    if (!tokenRef.current) return;
    const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:8080';
  /*
   * Seeded with the transcript the caller kept, if it kept one.
   *
   * The server holds one `streamPhase` — the current step — so polling alone
   * rebuilds the list from whichever step is running and the history is gone.
   * See utils/activeJob.ts.
   */
    if (priorPhases && priorPhases.length > 0) setPhases(priorPhases);
    setJobId(id);
    setIsGenerating(true);
    setError(null);
    setAbandoned(false);
    pollAttemptsRef.current = 0;
    pollJob(id, apiUrl, tokenRef.current);
  }, [pollJob]);

  useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort();
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      if (pollFetchAbortRef.current) pollFetchAbortRef.current.abort();
    };
  }, []);

  return { events, result, score, runInfo, abandoned, tokenUsage, isGenerating, plan, streamTail, streamPhase, streamChars, phases, error, generate, reset, stop, resume, jobId };
}
