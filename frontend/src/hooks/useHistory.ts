import { useState, useCallback, useRef, useEffect } from 'react';
import { useAuth } from '../auth/AuthProvider';

export interface VersionEntry {
  versionId: string;
  prompt: string;
  html: string;
  score: number;
  preset: string;
  model: string;
  createdAt: string;
}

interface UseHistoryReturn {
  versions: VersionEntry[];
  loading: boolean;
  error: string | null;
  fetchVersions: (projectId?: string) => void;
  loadVersion: (versionId: string) => Promise<VersionEntry | null>;
}

export function useHistory(): UseHistoryReturn {
  const { token } = useAuth();
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchVersions = useCallback((projectId?: string) => {
    if (!token) return;

    if (abortRef.current) {
      abortRef.current.abort();
    }

    setLoading(true);
    setError(null);

    const controller = new AbortController();
    abortRef.current = controller;

    const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:8080';
    const url = projectId ? `${apiUrl}/versions?projectId=${encodeURIComponent(projectId)}` : `${apiUrl}/versions`;
    fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setVersions(data.versions ?? []);
      })
      .catch((err) => {
        if (err.name !== 'AbortError') {
          setError(err.message);
        }
      })
      .finally(() => {
        if (abortRef.current === controller) setLoading(false);
      });
  }, [token]);

  const loadVersion = useCallback(async (versionId: string): Promise<VersionEntry | null> => {
    if (!token) return null;
    const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:8080';
    const res = await fetch(`${apiUrl}/versions/${encodeURIComponent(versionId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return res.json();
  }, [token]);

  useEffect(() => {
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, []);

  return { versions, loading, error, fetchVersions, loadVersion };
}
