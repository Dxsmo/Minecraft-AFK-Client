import { useEffect, useRef, useState } from "react";
import type { ConsoleLogEntry, LiveStatus } from "./types";
import { api, clearApiReadCache, invalidateAccountHistory } from "./api";
import { MAX_CONSOLE_LOGS, mergeConsoleHistory } from "./consoleBuffer";

const MAX_ACCOUNT_CONSOLE_LOGS = MAX_CONSOLE_LOGS;
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
export function useAccountConsole(accountId: string | undefined, renderLogs = true) {
  const [logs, setLogs] = useState<ConsoleLogEntry[]>([]);
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const renderLogsRef = useRef(renderLogs);
  renderLogsRef.current = renderLogs;
  const flushRef = useRef<() => void>(() => {});
  useEffect(() => { if (renderLogs) flushRef.current(); }, [renderLogs]);

  useEffect(() => {
    if (!accountId) return;
    setLogs([]);
    setStatus(null);
    setConnected(false);
    setHistoryError(null);
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout>;
    let receivedHistory = false;
    let pending: ConsoleLogEntry[] = [];
    let pendingHistory: ConsoleLogEntry[] | undefined;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    function flush() {
      clearTimeout(flushTimer); flushTimer = undefined;
      if (cancelled || document.hidden || !renderLogsRef.current) return;
      if (!pending.length && !pendingHistory) return;
      const batch = pending; pending = [];
      const history = pendingHistory; pendingHistory = undefined;
      setLogs(previous => history ? mergeConsoleHistory(history, [...previous, ...batch])
        : [...previous, ...batch].slice(-MAX_ACCOUNT_CONSOLE_LOGS));
    }
    flushRef.current = flush;
    document.addEventListener("visibilitychange", flush);
    const controller = new AbortController();
    // HTTP history remains available when a proxy delays/blocks the socket.
    // Normal connections deliver history first and never need this request.
    const historyTimer = setTimeout(() => {
      if (receivedHistory) return;
      void api.get<ConsoleLogEntry[]>(`/minecraft/accounts/${accountId}/logs?limit=${CONSOLE_HISTORY_PAGE_SIZE}`, { signal: controller.signal })
        .then(history => {
          if (cancelled || receivedHistory) return;
          receivedHistory = true;
          pendingHistory = history.slice(-MAX_ACCOUNT_CONSOLE_LOGS); flush();
        }).catch(() => {
          if (!cancelled && !receivedHistory) setHistoryError("Konsolenverlauf konnte nicht geladen werden. Bitte erneut versuchen.");
        });
    }, 1500);

    function connect() {
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${proto}://${window.location.host}/ws/accounts/${accountId}`);
      socketRef.current = socket;
      let opened = false;

      socket.onopen = () => { opened = true; if (!cancelled) setConnected(true); };
      socket.onclose = event => {
        if (!cancelled) {
          setConnected(false);
          if (!opened || event?.code === 4401 || event?.code === 4403) void api.get("/auth/me").catch(() => undefined);
          if (event?.code === 4401 || event?.code === 4403) {
            setHistoryError("Der Zugriff ist abgelaufen oder wurde entzogen. Bitte den Account erneut öffnen."); return;
          }
          retryTimer = setTimeout(connect, 3000);
        }
      };
      socket.onerror = () => socket.close();
      socket.onmessage = (ev) => {
        if (cancelled || socketRef.current !== socket) return;
        let msg: ConsoleEventMsg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === "history" && msg.logs) {
          receivedHistory = true;
          clearTimeout(historyTimer);
          controller.abort();
          setHistoryError(null);
          pendingHistory = msg.logs.slice(-MAX_ACCOUNT_CONSOLE_LOGS); flush();
        } else if (msg.type === "console" && msg.event) {
          const e = msg.event;
          pending.push({ id: `${e.timestamp}-${Math.random()}`, minecraftAccountId: e.minecraftAccountId, type: e.type, message: e.message, createdAt: e.timestamp });
          // Keep the newest complete buffer while a camera/settings/hidden
          // tab does not need console renders; bound the temporary queue too.
          if (pending.length > MAX_ACCOUNT_CONSOLE_LOGS * 2) pending = pending.slice(-MAX_ACCOUNT_CONSOLE_LOGS);
          if (!flushTimer && renderLogsRef.current && !document.hidden) flushTimer = setTimeout(flush, 50);
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
      clearTimeout(flushTimer);
      document.removeEventListener("visibilitychange", flush);
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
      const current = socket;
      let opened = false;
      current.onopen = () => { opened = true; };
      current.onclose = event => {
        if (cancelled || socket !== current) return;
        if (!opened || event?.code === 4401 || event?.code === 4403) void api.get("/auth/me").catch(() => undefined);
        if (event?.code === 4401 || event?.code === 4403) return;
        retryTimer = setTimeout(connect, 3000);
      };
      socket.onerror = () => current.close();
      socket.onmessage = (ev) => {
        if (cancelled || socket !== current) return;
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
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
