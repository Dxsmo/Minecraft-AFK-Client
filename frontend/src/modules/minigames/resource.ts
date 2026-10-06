import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api";
export function useResource<T>(path: string, refreshMs = 0) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const latestPath = useRef(path);
  latestPath.current = path;
  const controller = useRef<AbortController | undefined>(undefined);
  const reload = useCallback(async () => {
    if (latestPath.current !== path) return;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    try {
      const value = await apiFetch<T>(path, { signal: request.signal });
      if (!request.signal.aborted && latestPath.current === path) {
        setData(value);
        setError("");
      }
    } catch (e) {
      if (!request.signal.aborted && latestPath.current === path)
        setError(e instanceof Error ? e.message : "Dienst nicht erreichbar");
    } finally {
      if (!request.signal.aborted && latestPath.current === path)
        setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    setLoading(true);
    void reload();
    const timer = refreshMs
      ? setInterval(() => void reload(), refreshMs)
      : undefined;
    return () => {
      controller.current?.abort();
      if (timer) clearInterval(timer);
    };
  }, [reload, refreshMs]);
  return { data, error, loading, reload };
}
