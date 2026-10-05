import { useEffect, useLayoutEffect, useRef } from "react";
import type { ConsoleLogEntry } from "../lib/types";

const TYPE_STYLES: Record<ConsoleLogEntry["type"], string> = {
  SYSTEM: "#60a5fa",
  CHAT: "#e4e4e7",
  SERVER_MESSAGE: "#c4b5fd",
  USER_COMMAND: "#38bdf8",
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

export function ConsoleView({ logs, className = "h-[440px]" }: { logs: ConsoleLogEntry[]; className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Tracks whether the user is (roughly) scrolled to the bottom already, so we only
  // auto-follow new output when they haven't scrolled up to read history.
  const stickToBottomRef = useRef(true);
  const previousViewRef = useRef<{ firstId?: string; height: number; top: number }>({ height: 0, top: 0 });

  // Preserve the reading position when an older page is inserted above it.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const previous = previousViewRef.current;
    if (previous.firstId && logs[0]?.id !== previous.firstId && logs.some((log) => log.id === previous.firstId)) {
      el.scrollTop = previous.top + el.scrollHeight - previous.height;
    }
    previousViewRef.current = { firstId: logs[0]?.id, height: el.scrollHeight, top: el.scrollTop };
  }, [logs]);

  // Key the auto-follow on the newest entry's id, not the array length: the log
  // buffer is capped (ring buffer), so once it's full `length` stops changing
  // and a length-based effect would never fire again — freezing the scroll.
  const lastLogId = logs.length > 0 ? logs[logs.length - 1].id : null;

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !stickToBottomRef.current) return;
    // Scroll only this container - never the page/ancestors (unlike scrollIntoView).
    el.scrollTop = el.scrollHeight;
    previousViewRef.current.top = el.scrollTop;
  }, [lastLogId]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 48;
    previousViewRef.current.top = el.scrollTop;
  };

  return (
    <div ref={containerRef} onScroll={handleScroll} className={`console-output ${className}`}>
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
    </div>
  );
}
