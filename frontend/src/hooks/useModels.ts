import { useState, useEffect } from 'react';
import { useAuth } from '../auth/AuthProvider';

export interface ModelInfo {
  id: 'auto' | 'haiku' | 'sonnet' | 'opus';
  label: string;
  /** Version parsed from the configured Bedrock model id, e.g. "4.5". */
  version: string | null;
  modelId: string;
}

/**
 * Shown until Parameter Store answers, so the composer never renders empty chips.
 *
 * Opus is absent because the server's `/models` withholds it — see
 * backend/src/config/withdrawn.ts. This list is only on screen for the moment
 * before the fetch lands, which is exactly long enough to offer a model and take
 * it away again.
 */
const FALLBACK: ModelInfo[] = [
  { id: 'auto', label: '自動', version: null, modelId: '' },
  { id: 'haiku', label: 'Haiku', version: null, modelId: '' },
  { id: 'sonnet', label: 'Sonnet', version: null, modelId: '' },
];

/**
 * Model tiers and the versions actually configured in Parameter Store, so the chips
 * name what will run rather than a hard-coded guess that drifts when the
 * parameters are updated.
 */
export function useModels(): { models: ModelInfo[]; loaded: boolean } {
  const { token } = useAuth();
  const [models, setModels] = useState<ModelInfo[]>(FALLBACK);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:8080';

    fetch(`${apiUrl}/models`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: { models?: ModelInfo[] }) => {
        if (Array.isArray(data.models) && data.models.length > 0) setModels(data.models);
        setLoaded(true);
      })
      .catch(() => {
        // Keep the fallback labels — an unavailable version is not worth an error.
      });

    return () => controller.abort();
  }, [token]);

  return { models, loaded };
}
