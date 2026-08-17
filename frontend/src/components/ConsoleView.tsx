import { useEffect, useRef } from "react";
import type { ConsoleLogEntry } from "../lib/types";

const TYPE_STYLES: Record<ConsoleLogEntry["type"], string> = {
  SYSTEM: "text-sky-400",
  CHAT: "text-slate-100",
  SERVER_MESSAGE: "text-violet-300",
  USER_COMMAND: "text-emerald-400",
  ERROR: "text-red-400",
  WARNING: "text-amber-400",
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour12: false });
}

export function ConsoleView({ logs }: { logs: ConsoleLogEntry[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs.length]);

  return (
    <div className="console-output h-[420px]">
      {logs.length === 0 && <p className="text-slate-500">No console output yet. Start the client to see live output.</p>}
      {logs.map((log) => (
        <div key={log.id} className="whitespace-pre-wrap break-words leading-relaxed">
          <span className="mr-2 text-slate-500">[{formatTime(log.createdAt)}]</span>
          <span className={TYPE_STYLES[log.type]}>{log.message}</span>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
