import { useEffect, useRef } from "react";

/** Poll after completion, pause hidden tabs, and refresh on return. A slow
 * endpoint must never accumulate requests or keep getting aborted by a timer.
 */
export function usePolling(
  action: (signal: AbortSignal) => Promise<void>,
  intervalMs: number,
  enabled = true,
  aligned = false,
  resourceKey?: string,
) {
  const latest = useRef(action);
  latest.current = action;
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    async function poll() {
      clearTimeout(timer);
      if (busy || document.hidden || controller.signal.aborted) return;
      busy = true;
      let failed = false;
      try { await latest.current(controller.signal); }
      catch { failed = true; }
      finally {
        busy = false;
        if (!controller.signal.aborted && !document.hidden && intervalMs > 0) {
          const delay = failed ? Math.min(intervalMs, 15_000)
            : aligned ? intervalMs - Date.now() % intervalMs + 100 : intervalMs;
          timer = setTimeout(() => void poll(), delay);
        }
      }
    }
    const onVisibility = () => {
      clearTimeout(timer);
      if (!document.hidden) void poll();
    };
    void poll();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs, enabled, aligned, resourceKey]);
}
