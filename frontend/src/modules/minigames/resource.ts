import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { usePolling } from "../../lib/polling";
export function useResource<T>(path: string, refreshMs = 0) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const latestPath = useRef(path);
  latestPath.current = path;
  const controller = useRef<AbortController | undefined>(undefined);
  const reload = useCallback(async (signal?: AbortSignal) => {
    if (latestPath.current !== path) return;
    if (controller.current && !controller.current.signal.aborted && signal) return;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    const abort = () => request.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) request.abort();
    try {
      const value = await api.get<T>(path, { signal: request.signal });
      if (!request.signal.aborted && latestPath.current === path) {
        setData(value);
        setError("");
      }
    } catch (e) {
      if (!request.signal.aborted && latestPath.current === path)
        setError(e instanceof Error ? e.message : "Dienst nicht erreichbar");
    } finally {
      signal?.removeEventListener("abort", abort);
      if (controller.current === request) controller.current = undefined;
      if (!request.signal.aborted && latestPath.current === path)
        setLoading(false);
    }
  }, [path]);
  usePolling(reload, refreshMs, true, false, path);
  useEffect(() => {
    setData(undefined);
    setError("");
    setLoading(true);
    return () => {
      controller.current?.abort();
    };
  }, [reload]);
  return { data, error, loading, reload: () => reload() };
}
