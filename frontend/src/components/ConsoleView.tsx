import { useEffect, useRef } from "react";
import type { ConsoleLogEntry } from "../lib/types";

const TYPE_STYLES: Record<ConsoleLogEntry["type"], string> = {
  SYSTEM: "#60a5fa",
  CHAT: "#e4e4e7",
  SERVER_MESSAGE: "#c4b5fd",
  USER_COMMAND: "#34d399",
  ERROR: "#f87171",
  WARNING: "#fbbf24",
};

const TYPE_LABEL: Record<ConsoleLogEntry["type"], string> = {
  SYSTEM: "SYS",
  CHAT: "CHAT",
  SERVER_MESSAGE: "SRV",
  USER_COMMAND: "CMD",
  ERROR: "ERR",
  WARNING: "WARN",
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour12: false });
}

export function ConsoleView({ logs }: { logs: ConsoleLogEntry[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs.length]);

  return (
    <div className="console-output h-[440px]">
      {logs.length === 0 && (
        <p style={{ color: "#52525b" }}>No console output yet. Start the client to see live output.</p>
      )}
      {logs.map((log) => (
        <div key={log.id} className="flex gap-2 whitespace-pre-wrap break-words">
          <span className="shrink-0 tabular-nums" style={{ color: "#52525b" }}>
            {formatTime(log.createdAt)}
          </span>
          <span className="w-9 shrink-0 text-right text-[10px] font-semibold" style={{ color: TYPE_STYLES[log.type], opacity: 0.7 }}>
            {TYPE_LABEL[log.type]}
          </span>
          <span style={{ color: TYPE_STYLES[log.type] }}>{log.message}</span>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
