import { memo, useCallback, useLayoutEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
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
const ConsoleRow = memo(function ConsoleRow({ log }: { log: ConsoleLogEntry }) {
  return (
    <div className="console-row flex min-w-0 gap-2 whitespace-pre-wrap break-words">
      <span className="console-time shrink-0 tabular-nums" style={{ color: "#52525b" }}>{timeFormatter.format(new Date(log.createdAt))}</span>
      <span className="w-9 shrink-0 text-right text-[10px] font-semibold" style={{ color: TYPE_STYLES[log.type], opacity: 0.7 }}>{TYPE_LABEL[log.type]}</span>
      <span className="console-message min-w-0 flex-1" style={{ color: TYPE_STYLES[log.type], overflowWrap: "anywhere" }}>{log.message}</span>
    </div>
  );
});

export const ConsoleView = memo(function ConsoleView({ logs, className = "h-[440px]" }: { logs: ConsoleLogEntry[]; className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  const following = useRef(true);
  const adjusting = useRef(false);
  const frame = useRef<number | undefined>(undefined);
  const settled = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: logs.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => 24,
    getItemKey: useCallback((index: number) => logs[index].id, [logs]),
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 48,
    overscan: 12,
    directDomUpdates: true,
    onChange: (instance, sync) => {
      if (sync || !following.current || frame.current !== undefined) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = undefined;
        if (!following.current) return;
        adjusting.current = true;
        instance.scrollToEnd();
        clearTimeout(settled.current);
        settled.current = setTimeout(() => { adjusting.current = false; }, 150);
      });
    },
  });
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (width !== element.clientWidth) { width = element.clientWidth; virtualizer.measure(); }
      if (following.current) {
        adjusting.current = true; virtualizer.scrollToEnd();
        clearTimeout(settled.current);
        settled.current = setTimeout(() => { adjusting.current = false; }, 150);
      }
    });
    observer.observe(element);
    return () => {
      observer.disconnect(); if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = undefined; clearTimeout(settled.current); adjusting.current = false;
    };
  }, [virtualizer]);
  useLayoutEffect(() => {
    if (!initialized.current && logs.length) {
      initialized.current = true;
      virtualizer.scrollToEnd();
    }
  }, [logs.length, virtualizer]);

  return (
    <div ref={containerRef} className={`console-output ${className}`} style={{ overflowAnchor: "none" }}
      onWheel={event => { adjusting.current = false; if (event.deltaY < 0) following.current = false; }}
      onPointerDown={() => { adjusting.current = false; }} onTouchStart={() => { adjusting.current = false; }}
      onKeyDown={() => { adjusting.current = false; }}
      onScroll={event => {
        if (!adjusting.current) {
          const element = event.currentTarget;
          following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        }
      }}
      role="log" aria-label="Account-Konsole" aria-live="off" tabIndex={0} data-log-count={logs.length} data-last-log-id={logs.at(-1)?.id}>
      {logs.length === 0 && (
        <p style={{ color: "#52525b" }}>No console output yet. Start the client to see live output.</p>
      )}
      <div ref={virtualizer.containerRef} style={{ position: "relative", width: "100%" }}>
        {virtualizer.getVirtualItems().map(item => (
          <div key={item.key} data-index={item.index} data-log-id={logs[item.index].id} ref={virtualizer.measureElement}
            style={{ position: "absolute", top: 0, left: 0, width: "100%" }}>
            <ConsoleRow log={logs[item.index]} />
          </div>
        ))}
      </div>
    </div>
  );
});
