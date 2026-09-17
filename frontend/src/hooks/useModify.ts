import { useState, useCallback, useRef, useEffect } from 'react'
import { useAuth } from '../auth/AuthProvider'
import type { StreamEvent } from './useGenerate'
import { appendPhase, closeTranscript, type PhaseEntry } from '../utils/phaseTranscript'
import { postJson, requestErrorMessage } from '../utils/request'
import { pollAuthToken, isAuthRefusal, AUTH_RETRY_BUDGET } from '../utils/pollAuth';

interface UseModifyReturn {
  modifiedHtml: string | null
  /** Which tier actually ran, and the design system it was bound to. */
  runInfo: { modelTier: string; preset: string; effort?: string } | null
  toolsUsed: string[]
  /** What this edit cost. Null until the run reports, and on runs that never do. */
  tokenUsage: { inputTokens: number; outputTokens: number } | null
  events: StreamEvent[]
  isModifying: boolean
  /** Trailing slice of the model output as it is being written. */
  /** Prose the model wrote before the document, kept as its reasoning. */
  plan: string | null
  streamTail: string | null
  /** Label of the step currently producing output. */
  streamPhase: string | null;
  /** Characters generated so far. */
  streamChars: number
  /** Every step of this run with the reasoning it produced, oldest first. */
  phases: PhaseEntry[]
  error: string | null
  modify: (html: string, instruction: string, preset?: string, model?: string, selector?: string, projectId?: string, image?: string, effort?: string, attachment?: { name: string; content: string }, images?: string[], imageCaptions?: string[]) => void
  reset: () => void
  stop: () => void
  /** Re-attach to a job that is already running on the server. */
  /** `priorPhases` seeds the transcript — see utils/activeJob.ts. */
  resume: (jobId: string, priorPhases?: PhaseEntry[]) => void
  /** Job id of the run in flight, so the caller can persist it. */
  jobId: string | null
}

const POLL_INTERVAL_MS = 2000;
// Matches the generate path: the worker Lambda can run for 900s, and editing a
// large React project is not much cheaper than generating one.
const POLL_MAX_ATTEMPTS = 480; // 16 minutes


export function useModify(): UseModifyReturn {
  const { token } = useAuth()
  // Polling can outlive a token refresh; always read the newest one.
  const tokenRef = useRef(token)
  useEffect(() => { tokenRef.current = token }, [token])
  const [modifiedHtml, setModifiedHtml] = useState<string | null>(null)
  /*
   * What the edit cost.
   *
   * The result has carried `tokenUsage` since edits started reporting into the
   * ledger; nothing read it, so every reply after the first generation showed
   * no figure and the thread looked as though only the first run cost anything.
   */
  const [tokenUsage, setTokenUsage] = useState<{ inputTokens: number; outputTokens: number } | null>(null)
  const [runInfo, setRunInfo] = useState<{ modelTier: string; preset: string; effort?: string } | null>(null)
  const [toolsUsed, setToolsUsed] = useState<string[]>([])
  const [events, setEvents] = useState<StreamEvent[]>([])
  const [isModifying, setIsModifying] = useState(false)
  const [plan, setPlan] = useState<string | null>(null)
  const [streamTail, setStreamTail] = useState<string | null>(null)
  const [streamPhase, setStreamPhase] = useState<string | null>(null)
  const [streamChars, setStreamChars] = useState(0)
  const [phases, setPhases] = useState<PhaseEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollFetchAbortRef = useRef<AbortController | null>(null)
  const pollAttemptsRef = useRef(0)
  /** Consecutive refused polls. Reset by any poll that answers. */
  const authRetriesRef = useRef(0)

  const reset = useCallback(() => {
    setModifiedHtml(null)
    setToolsUsed([])
    setTokenUsage(null)
    setEvents([])
    setError(null)
    setPlan(null)
    setStreamTail(null)
    setStreamPhase(null)
    setStreamChars(0)
    setPhases([])
    setJobId(null)
    setIsModifying(false)
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
    if (pollFetchAbortRef.current) {
      pollFetchAbortRef.current.abort()
      pollFetchAbortRef.current = null
    }
    pollAttemptsRef.current = 0
  }, [])

  /**
   * Detach from the in-flight run without clearing collected events.
   * The server-side job keeps running — this cancels the client, not the work.
   */
  const stop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
    if (pollFetchAbortRef.current) {
      pollFetchAbortRef.current.abort()
      pollFetchAbortRef.current = null
    }
    pollAttemptsRef.current = 0
    setPhases(closeTranscript)
    setIsModifying(false)
  }, [])

  const pollJob = useCallback(
    (jobId: string, apiUrl: string, authToken: string) => {
      if (pollAttemptsRef.current >= POLL_MAX_ATTEMPTS) {
        setError('修正に時間がかかっています。処理はサーバー側で続いています。少し待ってから、バージョン履歴をご確認ください。')
        setIsModifying(false)
        return
      }
      pollAttemptsRef.current += 1

      if (pollFetchAbortRef.current) pollFetchAbortRef.current.abort()
      const pollController = new AbortController()
      pollFetchAbortRef.current = pollController

      // Read at request time, not captured — see utils/pollAuth.ts.
      pollAuthToken(tokenRef.current ?? authToken)
        .then((bearer) => fetch(`${apiUrl}/jobs/${jobId}`, {
          headers: { Authorization: `Bearer ${bearer}` },
          signal: pollController.signal,
        }))
        .then(async (res) => {
          if (!res.ok) {
            const err = new Error(`Poll failed: ${res.status}`)
            ;(err as any).status = res.status
            throw err
          }
          return res.json()
        })
        .then((data: { status: string; result?: Record<string, unknown>; error?: string; events?: Array<{ agent: string; status: string; t: string }> ; streamTail?: string; streamChars?: number; streamTokens?: number; streamPhase?: string }) => {
          // The budget is for CONSECUTIVE refusals; one that answers clears it.
          authRetriesRef.current = 0
          if (typeof data.streamTail === 'string') setStreamTail(data.streamTail)
          if (typeof data.streamChars === 'number') setStreamChars(data.streamChars)
          if (typeof data.streamPhase === 'string') setStreamPhase(data.streamPhase || null)
          if (data.streamPhase) {
            setPhases((prev) => appendPhase(prev, data.streamPhase!, data.streamTail ?? '', data.streamChars ?? 0, data.streamTokens))
          }
          // Sync pipeline events
          if (data.events && data.events.length > 0) {
            setEvents(data.events.map((e) => ({
              type: 'progress',
              data: { agent: e.agent, status: e.status },
              timestamp: new Date(e.t).getTime(),
            })))
          }

          if (data.status === 'completed' && data.result) {
            const r = data.result
            setModifiedHtml((r.html as string) || null)
            if (typeof r.plan === 'string' && r.plan.trim()) setPlan(r.plan.trim())
            setToolsUsed(Array.isArray(r.toolsUsed) ? (r.toolsUsed as string[]) : [])
            const tu = r.tokenUsage as { inputTokens?: number; outputTokens?: number } | undefined
            if (tu) setTokenUsage({ inputTokens: tu.inputTokens || 0, outputTokens: tu.outputTokens || 0 })
            setRunInfo(
              typeof r.modelTier === 'string'
                ? { modelTier: r.modelTier as string, preset: (r.preset as string) || 'none', effort: r.effort as string | undefined }
                : null
            )
            setPhases(closeTranscript)
            setIsModifying(false)
          } else if (data.status === 'failed') {
            setError(data.error || '修正に失敗しました。もう一度お試しください。')
            setPhases(closeTranscript)
            setIsModifying(false)
          } else {
            pollTimerRef.current = setTimeout(() => {
              if (authToken) pollJob(jobId, apiUrl, authToken)
            }, POLL_INTERVAL_MS)
          }
        })
        .catch((err) => {
          if (err.name === 'AbortError') return
          // A refused poll is not a finished job — see utils/pollAuth.ts.
          if (isAuthRefusal((err as any).status) && authRetriesRef.current < AUTH_RETRY_BUDGET) {
            authRetriesRef.current += 1
            pollTimerRef.current = setTimeout(() => {
              if (authToken) pollJob(jobId, apiUrl, authToken)
            }, POLL_INTERVAL_MS * 2)
            return
          }
          if ((err as any).status >= 400 && (err as any).status < 500 && (err as any).status !== 429) {
            setError('認証エラーが発生しました。再度ログインしてください。')
            setIsModifying(false)
            return
          }
          pollTimerRef.current = setTimeout(() => {
            if (authToken) pollJob(jobId, apiUrl, authToken)
          }, POLL_INTERVAL_MS * 2)
        })
    },
    []
  )

  const modify = useCallback(
    (html: string, instruction: string, preset?: string, model?: string, selector?: string, projectId?: string, image?: string, effort?: string, attachment?: { name: string; content: string }, images?: string[], imageCaptions?: string[]) => {
      if (!token) {
        setError('ログインの有効期限が切れています。再度ログインしてください。')
        return
      }

      if (abortRef.current) abortRef.current.abort()
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current)
        pollTimerRef.current = null
      }

      setIsModifying(true)
      setError(null)
      setModifiedHtml(null)
      setToolsUsed([])
      setEvents([])
      // Otherwise the next reply is labelled with the previous run's model.
      setRunInfo(null)
      // Without this the next run opens showing the previous run's output, and the
      // character counter continues from the old total.
      setPlan(null)
      setStreamTail(null)
      setStreamPhase(null)
      setStreamChars(0)
      /*
       * And the transcript, which is the one the others were fixed without.
       *
       * Every other piece of the previous run is cleared here; `phases` was not,
       * so a second edit opened with the first edit's steps already in the card
       * and appended its own underneath. The third showed all three. `reset()`
       * clears it and `generate()` calls `reset()` — this path never has, which
       * is why the same bug never appeared on the generate side.
       */
      setPhases([])

      const controller = new AbortController()
      abortRef.current = controller

      const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:8080'

      const body: Record<string, unknown> = { html, instruction, preset, model }
      if (selector) body.selector = selector
      if (projectId) body.projectId = projectId
      // An attached image is the reference for the edit. It used to stop here: the
      // composer held one, the endpoint validated one, and nothing sent one.
      if (image) body.image = image
      // The mode applies to edits too, so a 下書き session stays cheap — and,
      // since the mode stopped choosing the model, stays on whichever model the
      // picker is showing rather than one the mode substituted.
      if (effort) body.effort = effort
      // The user's data, for an edit that replaces what the screens are showing.
      if (attachment) body.attachment = attachment
      // Several pictures, and what each one is. An edit used to send only the first
      // and the composer cleared the rest — see utils/uiImages.ts.
      if (images && images.length > 0) body.images = images
      if (imageCaptions && imageCaptions.some((c) => c && c.trim())) body.imageCaptions = imageCaptions

      postJson<{
        jobId?: string
        html?: string
        toolsUsed?: string[]
        tokenUsage?: { inputTokens: number; outputTokens: number }
      }>({
        url: `${apiUrl}/modify`,
        token,
        body,
        signal: controller.signal,
        hasImage: Boolean(image),
      })
        .then((data) => {
          if (data.jobId) {
            setJobId(data.jobId)
            pollAttemptsRef.current = 0
            pollJob(data.jobId, apiUrl, token)
          } else if (data.html) {
            setModifiedHtml(data.html)
            setToolsUsed(data.toolsUsed || [])
            if (data.tokenUsage) setTokenUsage(data.tokenUsage)
            setIsModifying(false)
          } else {
            throw new Error('Unexpected response')
          }
        })
        .catch((err) => {
          if (err.name === 'AbortError') return
          setError(requestErrorMessage(err, '修正を開始できませんでした。もう一度お試しください。'))
          setIsModifying(false)
        })
    },
    [token, pollJob]
  )

  /**
   * Attach to a job started earlier (for example before the user navigated away).
   * The server keeps running it, so the client only needs to start polling again.
   */
  const resume = useCallback((id: string, priorPhases?: PhaseEntry[]) => {
    if (!tokenRef.current) return
    const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:8080'
  /*
   * Seeded with the transcript the caller kept, if it kept one.
   *
   * The server holds one `streamPhase` — the current step — so polling alone
   * rebuilds the list from whichever step is running and the history is gone.
   * See utils/activeJob.ts.
   */
    if (priorPhases && priorPhases.length > 0) setPhases(priorPhases)
    setJobId(id)
    setIsModifying(true)
    setError(null)
    pollAttemptsRef.current = 0
    pollJob(id, apiUrl, tokenRef.current)
  }, [pollJob])

  useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort()
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current)
      if (pollFetchAbortRef.current) pollFetchAbortRef.current.abort()
    }
  }, [])

  return { modifiedHtml, runInfo, toolsUsed, tokenUsage, events, isModifying, plan, streamTail, streamPhase, streamChars, phases, error, modify, reset, stop, resume, jobId }
}
