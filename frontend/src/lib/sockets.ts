import { useEffect, useRef, useState } from "react";
import type { ConsoleLogEntry, LiveStatus, SniperLiveStatus } from "./types";
import { api } from "./api";

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
  const olderCursorRef = useRef<string | null>(null);
  const loadingOlderRef = useRef(false);
  const currentAccountRef = useRef(accountId);
  currentAccountRef.current = accountId;
  const [hasOlderLogs, setHasOlderLogs] = useState(false);
  const [loadingOlderLogs, setLoadingOlderLogs] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId) return;
    setLogs([]);
    setStatus(null);
    setConnected(false);
    setHasOlderLogs(false);
    setHistoryError(null);
    olderCursorRef.current = null;
    loadingOlderRef.current = false;
    setLoadingOlderLogs(false);
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout>;

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
          setLogs(msg.logs);
          olderCursorRef.current = msg.logs[0]?.id ?? null;
          setHasOlderLogs(msg.logs.length === CONSOLE_HISTORY_PAGE_SIZE);
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
      socketRef.current?.close();
    };
  }, [accountId]);

  async function loadOlderLogs() {
    if (!accountId || !olderCursorRef.current || loadingOlderRef.current) return;
    const requestAccount = accountId;
    const cursor = olderCursorRef.current;
    loadingOlderRef.current = true;
    setLoadingOlderLogs(true);
    setHistoryError(null);
    try {
      const older = await api.get<ConsoleLogEntry[]>(
        `/minecraft/accounts/${accountId}/logs?limit=${CONSOLE_HISTORY_PAGE_SIZE}&before=${encodeURIComponent(cursor)}`,
      );
      if (currentAccountRef.current !== requestAccount || olderCursorRef.current !== cursor) return;
      olderCursorRef.current = older[0]?.id ?? null;
      setHasOlderLogs(older.length === CONSOLE_HISTORY_PAGE_SIZE);
      setLogs((prev) => {
        const known = new Set(prev.map((log) => log.id));
        return [...older.filter((log) => !known.has(log.id)), ...prev].slice(-MAX_ACCOUNT_CONSOLE_LOGS);
      });
    } catch {
      if (currentAccountRef.current === requestAccount) setHistoryError("Ältere Logs konnten nicht geladen werden. Bitte erneut versuchen.");
    } finally {
      if (currentAccountRef.current === requestAccount) {
        loadingOlderRef.current = false;
        setLoadingOlderLogs(false);
      }
    }
  }

  return {
    logs, status, connected, loadOlderLogs, loadingOlderLogs, historyError,
    hasOlderLogs: hasOlderLogs && logs.length < MAX_ACCOUNT_CONSOLE_LOGS,
  };
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
          refreshCallback.current?.();
        } else if (msg.type === "status") {
          setStatuses((prev) => ({ ...prev, [msg.status.id]: msg.status }));
        } else if (msg.type === "account_image") {
          imageCallback.current?.({ id: msg.id, imageUrl: msg.imageUrl });
        } else if (msg.type === "account_sale") {
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

// ---- Name Sniper (admin-only, mirrors useAccountConsole/useDashboardSocket) ----

interface SniperConsoleEventMsg {
  type: "history" | "console" | "status" | "error";
  logs?: ConsoleLogEntry[];
  event?: { sniperAccountId: string; type: ConsoleLogEntry["type"]; message: string; timestamp: string };
  status?: SniperLiveStatus;
  reason?: string;
}

/** Connects to a single Name Sniper account's live console WebSocket. */
export function useSniperConsole(accountId: string | undefined) {
  const [logs, setLogs] = useState<ConsoleLogEntry[]>([]);
  const [status, setStatus] = useState<SniperLiveStatus | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout>;
    let socket: WebSocket;

    function connect() {
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${proto}://${window.location.host}/ws/namesniper/${accountId}`);

      socket.onopen = () => setConnected(true);
      socket.onclose = () => {
        setConnected(false);
        if (!cancelled) retryTimer = setTimeout(connect, 3000);
      };
      socket.onerror = () => socket.close();
      socket.onmessage = (ev) => {
        const msg: SniperConsoleEventMsg = JSON.parse(ev.data);
        if (msg.type === "history" && msg.logs) {
          setLogs(msg.logs);
        } else if (msg.type === "console" && msg.event) {
          const e = msg.event;
          setLogs((prev) => [
            ...prev.slice(-499),
            { id: `${e.timestamp}-${Math.random()}`, minecraftAccountId: e.sniperAccountId, type: e.type, message: e.message, createdAt: e.timestamp },
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
      socket?.close();
    };
  }, [accountId]);

  return { logs, status, connected };
}

/** Live status snapshots for every Name Sniper account (admin-only). */
export function useSniperDashboardSocket() {
  const [statuses, setStatuses] = useState<Record<string, SniperLiveStatus>>({});

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout>;
    let socket: WebSocket;

    function connect() {
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${proto}://${window.location.host}/ws/namesniper-dashboard`);
      socket.onclose = () => {
        if (!cancelled) retryTimer = setTimeout(connect, 3000);
      };
      socket.onerror = () => socket.close();
      socket.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === "statuses") {
          const map: Record<string, SniperLiveStatus> = {};
          for (const s of msg.statuses as SniperLiveStatus[]) map[s.id] = s;
          setStatuses(map);
        } else if (msg.type === "status") {
          setStatuses((prev) => ({ ...prev, [msg.status.id]: msg.status }));
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
