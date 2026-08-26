import { useEffect, useRef, useState } from "react";
import type { ConsoleLogEntry, LiveStatus, SniperLiveStatus } from "./types";

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

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout>;

    function connect() {
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${proto}://${window.location.host}/ws/accounts/${accountId}`);
      socketRef.current = socket;

      socket.onopen = () => setConnected(true);
      socket.onclose = () => {
        setConnected(false);
        if (!cancelled) retryTimer = setTimeout(connect, 3000);
      };
      socket.onerror = () => socket.close();
      socket.onmessage = (ev) => {
        const msg: ConsoleEventMsg = JSON.parse(ev.data);
        if (msg.type === "history" && msg.logs) {
          setLogs(msg.logs);
        } else if (msg.type === "console" && msg.event) {
          const e = msg.event;
          setLogs((prev) => [
            ...prev.slice(-499),
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

  function sendCommand(command: string) {
    socketRef.current?.readyState === WebSocket.OPEN &&
      socketRef.current.send(JSON.stringify({ type: "command", command }));
  }

  return { logs, status, connected, sendCommand };
}

/** Live status snapshots for every account visible to the current user. */
export function useDashboardSocket() {
  const [statuses, setStatuses] = useState<Record<string, LiveStatus>>({});

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
        const msg = JSON.parse(ev.data);
        if (msg.type === "statuses") {
          const map: Record<string, LiveStatus> = {};
          for (const s of msg.statuses as LiveStatus[]) map[s.id] = s;
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
