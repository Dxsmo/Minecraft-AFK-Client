import { useEffect, useRef, useState } from "react";
import type { ConsoleLogEntry, LiveStatus } from "./types";
import { api, clearApiReadCache, invalidateAccountHistory } from "./api";

const MAX_ACCOUNT_CONSOLE_LOGS = 20_000;
const CONSOLE_HISTORY_PAGE_SIZE = 2000;

export interface ConsoleEventMsg {
  type: "history" | "console" | "status" | "error";
  logs?: ConsoleLogEntry[];
  event?: { minecraftAccountId: string; type: ConsoleLogEntry["type"]; message: string; timestamp: string };
  status?: LiveStatus;
  reason?: string;
}

/**
 * Connects to the per-account live console WebSocket and keeps a rolling
 * log buffer + latest status in sync. Automatically reconnects the browser
 * socket itself if it drops (separate from the backend's Minecraft
 * reconnect logic).
 */
export function useAccountConsole(accountId: string | undefined) {
  const [logs, setLogs] = useState<ConsoleLogEntry[]>([]);
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId) return;
    setLogs([]);
    setStatus(null);
    setConnected(false);
    setHistoryError(null);
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout>;
    let receivedHistory = false;
    const controller = new AbortController();
    // HTTP history remains available when a proxy delays/blocks the socket.
    // Normal connections deliver history first and never need this request.
    const historyTimer = setTimeout(() => {
      if (receivedHistory) return;
      void api.get<ConsoleLogEntry[]>(`/minecraft/accounts/${accountId}/logs?limit=${CONSOLE_HISTORY_PAGE_SIZE}`, { signal: controller.signal })
        .then(history => {
          if (cancelled || receivedHistory) return;
          receivedHistory = true;
          // Preserve live lines delivered while the HTTP request was pending.
          setLogs(live => {
            const key = (line: ConsoleLogEntry) => JSON.stringify([line.createdAt, line.type, line.message]);
            const counts = new Map<string, number>();
            for (const line of history) counts.set(key(line), (counts.get(key(line)) ?? 0) + 1);
            const extra = live.filter(line => {
              const remaining = counts.get(key(line)) ?? 0;
              if (!remaining) return true;
              counts.set(key(line), remaining - 1);
              return false;
            });
            return [...history, ...extra].slice(-MAX_ACCOUNT_CONSOLE_LOGS);
          });
        }).catch(() => {
          if (!cancelled && !receivedHistory) setHistoryError("Konsolenverlauf konnte nicht geladen werden. Bitte erneut versuchen.");
        });
    }, 1500);

    function connect() {
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${proto}://${window.location.host}/ws/accounts/${accountId}`);
      socketRef.current = socket;

      socket.onopen = () => { if (!cancelled) setConnected(true); };
      socket.onclose = () => {
        if (!cancelled) {
          setConnected(false);
          retryTimer = setTimeout(connect, 3000);
        }
      };
      socket.onerror = () => socket.close();
      socket.onmessage = (ev) => {
        if (cancelled || socketRef.current !== socket) return;
        const msg: ConsoleEventMsg = JSON.parse(ev.data);
        if (msg.type === "history" && msg.logs) {
          receivedHistory = true;
          clearTimeout(historyTimer);
          controller.abort();
          setHistoryError(null);
          setLogs(msg.logs);
        } else if (msg.type === "console" && msg.event) {
          const e = msg.event;
          setLogs((prev) => [
            ...prev.slice(-(MAX_ACCOUNT_CONSOLE_LOGS - 1)),
            { id: `${e.timestamp}-${Math.random()}`, minecraftAccountId: e.minecraftAccountId, type: e.type, message: e.message, createdAt: e.timestamp },
          ]);
        } else if (msg.type === "status" && msg.status) {
          setStatus(msg.status);
        }
      };
    }

    connect();
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      clearTimeout(historyTimer);
      controller.abort();
      socketRef.current?.close();
    };
  }, [accountId]);

  return { logs, status, connected, historyError };
}

/** Live status snapshots for every account visible to the current user. */
export function useDashboardSocket(
  onImageUpdated?: (update: { id: string; imageUrl: string }) => void,
  onRefresh?: () => void,
  onSellUpdated?: (update: { id: string; lastSellAt: string }) => void,
) {
  const [statuses, setStatuses] = useState<Record<string, LiveStatus>>({});
  const imageCallback = useRef(onImageUpdated);
  const refreshCallback = useRef(onRefresh);
  const sellCallback = useRef(onSellUpdated);
  imageCallback.current = onImageUpdated;
  refreshCallback.current = onRefresh;
  sellCallback.current = onSellUpdated;

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout>;
    let socket: WebSocket;
    let receivedInitialStatuses = false;

    function connect() {
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${proto}://${window.location.host}/ws/dashboard`);
      socket.onclose = () => {
        if (!cancelled) retryTimer = setTimeout(connect, 3000);
      };
      socket.onerror = () => socket.close();
      socket.onmessage = (ev) => {
        if (cancelled) return;
        const msg = JSON.parse(ev.data);
        if (msg.type === "statuses") {
          const map: Record<string, LiveStatus> = {};
          for (const s of msg.statuses as LiveStatus[]) map[s.id] = s;
          setStatuses(map);
          // The page loads accounts on mount. Only reconnects need another list fetch.
          if (receivedInitialStatuses) {
            clearApiReadCache();
            refreshCallback.current?.();
          }
          receivedInitialStatuses = true;
        } else if (msg.type === "status") {
          setStatuses((prev) => ({ ...prev, [msg.status.id]: msg.status }));
        } else if (msg.type === "account_image") {
          imageCallback.current?.({ id: msg.id, imageUrl: msg.imageUrl });
        } else if (msg.type === "account_sale") {
          invalidateAccountHistory(msg.id);
          sellCallback.current?.({ id: msg.id, lastSellAt: msg.lastSellAt });
        }
      };
    }

    connect();
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      socket?.close();
    };
  }, []);

  return statuses;
}
