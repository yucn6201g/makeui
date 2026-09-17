import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../auth/AuthProvider';

export interface UsageData {
  /**
   * The name this account is shown by. Sign-in is still the email address.
   *
   * From the server rather than from the ID token. The token should carry the
   * `name` claim and the header could read it directly — but the deployed app
   * cannot be signed into from the development environment, so that "should"
   * cannot be checked, and if it were wrong the header would quietly show the
   * email local part forever. The server resolves it from the directory, which
   * is true either way. See backend services/display-name.ts.
   */
  displayName: string;
  tokensUsed: number;
  tokensLimit: number;
  requestsUsed: number;
  /**
   * The month's spend, or null when no price table is configured.
   *
   * Null rather than 0, which would read as a free month — the same distinction
   * the admin panel makes for the same reason.
   */
  cost: number | null;
  /**
   * Whether `cost` is a sum or an estimate.
   *
   * True only for a month that straddles the deploy which began recording which
   * model each request went to: the requests written before it added to the
   * totals and to nothing else, so their share of the money is inferred from
   * what the recorded ones cost. The figure is drawn with a 「約」 when it is —
   * a number somebody is held to should say when it was inferred, and this
   * stops being true of its own accord when the month ends.
   */
  costEstimated: boolean;
  /** The group this account belongs to, shown beside the name. */
  group: string | null;
  /**
   * The whole group's budget and what it has spent, for every member to see.
   *
   * Not only for whoever administers it: somebody refused while still inside
   * their own budget is being stopped by a number their colleagues moved, and
   * without this the refusal has no explanation on the screen.
   */
  groupBudget: { limit: number; used: number; cost: number | null } | null;
  /** The models an administrator lets this user pick, each independently. */
  allowedModels: ('haiku' | 'sonnet' | 'opus' | 'auto')[];
}

interface UseUsageReturn {
  usage: UsageData | null;
  /** True once the first request has settled, successfully or not. */
  answered: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useUsage(): UseUsageReturn {
  const { token } = useAuth();
  const [usage, setUsage] = useState<UsageData | null>(null);
  /**
   * Whether the first request has finished, however it finished.
   *
   * Not `!loading`: that starts false, before anything has been asked, and a
   * caller cannot tell "nobody has asked yet" from "asked and got nothing".
   * The header needs exactly that difference — see the note on the name it
   * draws.
   */
  const [answered, setAnswered] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(() => {
    if (!token) return;

    if (abortRef.current) {
      abortRef.current.abort();
    }

    setLoading(true);
    setError(null);

    const controller = new AbortController();
    abortRef.current = controller;

    const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:8080';

    fetch(`${apiUrl}/usage`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const data = await response.json();
        setUsage({
          // '' rather than a guess. The header falls back to nothing visible
          // rather than to an address, which is the field being replaced.
          displayName: typeof data.displayName === 'string' ? data.displayName : '',
          tokensLimit: data.limit === -1 ? -1 : (data.limit ?? 10_000_000),
          requestsUsed: data.requestsUsed ?? 0,
          /*
           * `tokensUsed` where the server sends it: `currentUsage` is what the
           * limit is checked against, and once a price table is enforced that is
           * a weighted figure about three times the token count. 「トークン数」
           * has to be the tokens.
           */
          tokensUsed: data.tokensUsed ?? data.currentUsage ?? 0,
          cost: typeof data.cost === 'number' ? data.cost : null,
          costEstimated: data.costEstimated === true,
          group: data.group ?? null,
          groupBudget: data.groupBudget ?? null,
          // Unrestricted unless the server says otherwise, so a response from
          // before this field existed does not lock anyone out of their models.
          allowedModels: Array.isArray(data.allowedModels) && data.allowedModels.length > 0
            ? data.allowedModels
            : ['haiku', 'sonnet', 'opus', 'auto'],
        });
        setAnswered(true);
      })
      .catch((err) => {
        if (err.name !== 'AbortError') {
          setError(err.message || 'Failed to fetch usage');
          // A failure is an answer for this purpose: the header has waited long
          // enough and should fall back rather than hold a placeholder for ever.
          setAnswered(true);
        }
      })
      .finally(() => {
        setLoading(false);
      });
  }, [token]);

  useEffect(() => {
    refresh();
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, [refresh]);

  return { usage, answered, loading, error, refresh };
}
