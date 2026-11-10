import { useEffect, useRef, useState } from "react";
import type { ConsoleLogEntry, LiveStatus } from "./types";
import { api, clearApiReadCache, invalidateAccountHistory } from "./api";
import { MAX_CONSOLE_LOGS, mergeConsoleHistory, appendConsoleLogs } from "./consoleBuffer";

const MAX_ACCOUNT_CONSOLE_LOGS = MAX_CONSOLE_LOGS;
const CONSOLE_HISTORY_PAGE_SIZE = 2000;

export interface ConsoleEventMsg {
  type: "history" | "console" | "status" | "error" | "heartbeat";
  logs?: ConsoleLogEntry[];
  event?: { id?: string; minecraftAccountId: string; type: ConsoleLogEntry["type"]; message: string; timestamp: string };
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
  const acceptRef = useRef<(event: NonNullable<ConsoleEventMsg["event"]>) => void>(() => {});
  const refreshRef = useRef<() => void>(() => {});
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
        : appendConsoleLogs(previous, batch));
    }
    flushRef.current = flush;
    function accept(event: NonNullable<ConsoleEventMsg["event"]>) {
      if (cancelled || event.minecraftAccountId !== accountId) return;
      pending.push({ id: event.id ?? `${event.timestamp}-${Math.random()}`, minecraftAccountId: event.minecraftAccountId,
        type: event.type, message: event.message, createdAt: event.timestamp });
      flush();
    }
    acceptRef.current = accept;
    let refreshing = false;
    async function refresh() {
      if (cancelled || refreshing) return;
      refreshing = true;
      try {
        const [history, account] = await Promise.all([
          api.get<ConsoleLogEntry[]>(`/minecraft/accounts/${accountId}/logs?limit=${CONSOLE_HISTORY_PAGE_SIZE}`, { signal: controller.signal }),
          api.get<{ live?: LiveStatus }>(`/minecraft/accounts/${accountId}`, { signal: controller.signal }),
        ]);
        if (cancelled) return;
        pendingHistory = history; flush();
        if (account.live) setStatus(account.live);
        setHistoryError(null);
      } catch { if (!cancelled) setHistoryError("Live-Konsole unterbrochen; Verlauf konnte nicht nachgeladen werden."); }
      finally { refreshing = false; }
    }
    let receiptRefresh: ReturnType<typeof setTimeout> | undefined;
    refreshRef.current = () => { clearTimeout(receiptRefresh); receiptRefresh = setTimeout(() => void refresh(), 1500); };
    let lastMessage = Date.now();
    const recoveryTimer = setInterval(() => {
      if (document.hidden || !renderLogsRef.current) return;
      if (socketRef.current?.readyState !== WebSocket.OPEN || Date.now() - lastMessage > 25_000) {
        void refresh();
        if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.close();
      }
    }, 10_000);
    document.addEventListener("visibilitychange", flush);
    const controller = new AbortController();
    const historyController = new AbortController();
    // HTTP history remains available when a proxy delays/blocks the socket.
    // Normal connections deliver history first and never need this request.
    const historyTimer = setTimeout(() => {
      if (receivedHistory) return;
      void api.get<ConsoleLogEntry[]>(`/minecraft/accounts/${accountId}/logs?limit=${CONSOLE_HISTORY_PAGE_SIZE}`, { signal: historyController.signal })
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

      socket.onopen = () => { opened = true; lastMessage = Date.now(); if (!cancelled && socketRef.current === socket) setConnected(true); };
      socket.onclose = event => {
        if (socketRef.current !== socket) return;
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
        lastMessage = Date.now();
        let msg: ConsoleEventMsg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === "history" && msg.logs) {
          receivedHistory = true;
          clearTimeout(historyTimer);
          historyController.abort();
          setHistoryError(null);
          pendingHistory = msg.logs.slice(-MAX_ACCOUNT_CONSOLE_LOGS); flush();
        } else if (msg.type === "console" && msg.event) {
          const e = msg.event;
          pending.push({ id: e.id ?? `${e.timestamp}-${Math.random()}`, minecraftAccountId: e.minecraftAccountId, type: e.type, message: e.message, createdAt: e.timestamp });
          // Keep the newest complete buffer while a settings/hidden
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
      clearInterval(recoveryTimer);
      clearTimeout(receiptRefresh);
      clearTimeout(historyTimer);
      clearTimeout(flushTimer);
      document.removeEventListener("visibilitychange", flush);
      controller.abort();
      historyController.abort();
      socketRef.current?.close();
    };
  }, [accountId]);

  return { logs, status, connected, historyError, acceptCommand: (event: NonNullable<ConsoleEventMsg["event"]>) => acceptRef.current(event), refreshAfterCommand: () => refreshRef.current() };
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
