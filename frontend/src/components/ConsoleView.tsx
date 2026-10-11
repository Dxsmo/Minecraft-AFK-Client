import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
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

const timeFormatter = new Intl.DateTimeFormat(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
const COMPACT_LINE_COUNT = 6;
const ConsoleRow = memo(function ConsoleRow({ log }: { log: ConsoleLogEntry }) {
  return (
    <div className="flex gap-2 whitespace-pre-wrap break-words">
      <span className="shrink-0 tabular-nums" style={{ color: "#52525b" }}>{timeFormatter.format(new Date(log.createdAt))}</span>
      <span className="w-9 shrink-0 text-right text-[10px] font-semibold" style={{ color: TYPE_STYLES[log.type], opacity: 0.7 }}>{TYPE_LABEL[log.type]}</span>
      <span style={{ color: TYPE_STYLES[log.type] }}>{log.message}</span>
    </div>
  );
});

export const ConsoleView = memo(function ConsoleView({ logs, className = "h-[440px]" }: { logs: ConsoleLogEntry[]; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  const outputId = useId();
  const visibleLogs = useMemo(() => expanded ? logs : logs.slice(-COMPACT_LINE_COUNT), [logs, expanded]);
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
    if (expanded && previous.firstId && visibleLogs[0]?.id !== previous.firstId && visibleLogs.some((log) => log.id === previous.firstId)) {
      el.scrollTop = previous.top + el.scrollHeight - previous.height;
    }
    previousViewRef.current = { firstId: visibleLogs[0]?.id, height: el.scrollHeight, top: el.scrollTop };
  }, [visibleLogs, expanded]);

  // Key the auto-follow on the newest entry's id, not the array length: the log
  // buffer is capped (ring buffer), so once it's full `length` stops changing
  // and a length-based effect would never fire again — freezing the scroll.
  const lastLogId = logs.length > 0 ? logs[logs.length - 1].id : null;

  useEffect(() => {
    const el = containerRef.current;
    if (!el || (expanded && !stickToBottomRef.current)) return;
    // Scroll only this container - never the page/ancestors (unlike scrollIntoView).
    el.scrollTop = el.scrollHeight;
    previousViewRef.current.top = el.scrollTop;
  }, [lastLogId, expanded]);

  function toggleExpanded() {
    // Both views start at the newest output after switching their size.
    stickToBottomRef.current = true;
    previousViewRef.current = { height: 0, top: 0 };
    setExpanded(value => !value);
  }

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 48;
    previousViewRef.current.top = el.scrollTop;
  };

  return (
    <div className="overflow-hidden rounded-xl border" style={{ borderColor: "var(--border-strong)" }}>
      <div className="flex items-center justify-between border-b px-2 py-1.5" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
        <button type="button" className="btn btn-ghost btn-sm gap-2" onClick={toggleExpanded}
          aria-expanded={expanded} aria-controls={outputId}
          aria-label={expanded ? "Konsole einklappen" : "Konsole ausklappen"}
          title={expanded ? "Konsole einklappen" : "Konsole ausklappen"}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={expanded ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"} />
          </svg>
          <span>Konsole</span>
        </button>
        {!expanded && <span className="pr-2 text-xs" style={{ color: "var(--text-subtle)" }}>Neueste {COMPACT_LINE_COUNT} Zeilen</span>}
      </div>
      <div id={outputId} ref={containerRef} onScroll={handleScroll} className={`console-output ${expanded ? className : "h-[160px]"}`}
        style={{ border: 0, borderRadius: 0 }}>
        {logs.length === 0 && (
          <p style={{ color: "#52525b" }}>No console output yet. Start the client to see live output.</p>
        )}
        {visibleLogs.map((log) => <ConsoleRow key={log.id} log={log} />)}
      </div>
    </div>
  );
});
