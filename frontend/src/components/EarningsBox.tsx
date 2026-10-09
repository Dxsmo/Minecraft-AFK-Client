import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { apiFetch } from "../lib/api";

type Range = "1h" | "6h" | "24h";
interface Earnings { last5m: number; last1h: number; last24h: number }
interface History {
  range: Range;
  start: string;
  end: string;
  bucketMs: number;
  total: number;
  points: { at: string; amount: number }[];
}
const money = (amount: number) => `$${amount.toLocaleString("de-DE", { maximumFractionDigits: 2 })}`;
const time = (at: string | number) => new Date(at).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });

export function EarningsBox({ accountId }: { accountId: string }) {
  const [earnings, setEarnings] = useState<Earnings | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [range, setRange] = useState<Range>("1h");
  const panelId = useId();
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    async function poll() {
      if (busy) return;
      busy = true;
      try {
        const data = await apiFetch<Earnings>(`/minecraft/accounts/${accountId}/earnings`, { signal: controller.signal });
        if (!controller.signal.aborted) setEarnings(data);
      } catch { /* Retry on the next poll. */ }
      finally { busy = false; }
    }
    void poll();
    const timer = setInterval(poll, 15_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [accountId]);

  return (
    <section className="card p-3.5 text-sm" aria-label="Sell earnings">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-subtle)" }}>Sell earnings</h3>
      <div className="grid grid-cols-3 gap-2 text-center">
        {([['5 min', earnings?.last5m], ['1 h', earnings?.last1h], ['24 h', earnings?.last24h]] as const).map(([label, amount]) => (
          <div key={label}>
            <p className="text-[11px]" style={{ color: "var(--text-subtle)" }}>{label}</p>
            <p className="mt-0.5 font-semibold tabular-nums" style={{ color: "var(--accent)" }}>{amount == null ? "—" : money(amount)}</p>
          </div>
        ))}
      </div>
      <button type="button" onClick={() => setExpanded(value => !value)} aria-expanded={expanded} aria-controls={panelId}
        aria-label={expanded ? "Verkaufsgraph einklappen" : "Verkaufsgraph ausklappen"}
        className="mt-3 flex items-center gap-1.5 rounded-md px-1 py-1 text-[11px] transition-colors hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-offset-2"
        style={{ color: "var(--text-muted)" }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"
          className={`transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}><path d="m6 9 6 6 6-6" /></svg>
        Verlauf
      </button>
      <div id={panelId} hidden={!expanded}>
        {expanded && <div className="mt-2 border-t pt-3" style={{ borderColor: "var(--border)" }}>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>Verkaufsverlauf</p>
            <div className="flex gap-1 rounded-lg p-1" role="group" aria-label="Zeitraum" style={{ background: "var(--surface)" }}>
              {([['1h', '1 Stunde'], ['6h', '6 Stunden'], ['24h', '24 Stunden']] as const).map(([value, label]) => (
                <button type="button" key={value} aria-pressed={range === value} onClick={() => setRange(value)}
                  className={`rounded-md px-2.5 py-1 text-[11px] transition-colors ${range === value ? "bg-white/10" : "hover:bg-white/5"}`}
                  style={{ color: range === value ? "var(--text)" : "var(--text-subtle)" }}>{label}</button>
              ))}
            </div>
          </div>
          <EarningsGraph key={`${accountId}:${range}`} accountId={accountId} range={range} />
        </div>}
      </div>
    </section>
  );
}

function EarningsGraph({ accountId, range }: { accountId: string; range: Range }) {
  const [history, setHistory] = useState<History | null>(null);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const gradientId = useId();
  const hintId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(700);
  const hasHistory = history !== null;
  useEffect(() => {
    const node = svgRef.current;
    if (!node) return;
    const observer = new ResizeObserver(entries => setWidth(Math.max(280, Math.round(entries[0].contentRect.width))));
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasHistory]);
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    async function poll() {
      if (busy) return;
      busy = true;
      try {
        const data = await apiFetch<History>(`/minecraft/accounts/${accountId}/earnings/history?range=${range}`, { signal: controller.signal });
        if (!controller.signal.aborted) { setHistory(data); setError(false); }
      } catch { if (!controller.signal.aborted) setError(true); }
      finally { busy = false; }
    }
    void poll();
    const timer = setInterval(poll, 15_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [accountId, range]);

  if (!history) return <div className="flex h-[240px] items-center justify-center text-xs" role="status" style={{ color: "var(--text-subtle)" }}>
    {error ? "Verkaufsverlauf konnte nicht geladen werden. Erneuter Versuch folgt." : "Verkaufsverlauf wird geladen…"}
  </div>;

  const height = 240, left = 8, right = 92, top = 16, bottom = 32;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const peak = Math.max(...history.points.map(point => point.amount), 0);
  const magnitude = 10 ** Math.floor(Math.log10(peak > 0 ? peak / 4 : 1));
  const step = ([1, 2, 5, 10].find(value => value * magnitude * 4 >= peak) ?? 10) * magnitude;
  const max = step * 4;
  const x = (index: number) => left + (index + 0.5) / history.points.length * plotWidth;
  const y = (amount: number) => top + plotHeight * (1 - amount / max);
  const line = history.points.map((point, index) => `${x(index)},${y(point.amount)}`).join(" ");
  const active = selected == null ? null : history.points[selected];
  const interval = history.bucketMs / 60_000;
  const axisMoney = (amount: number) => `$${new Intl.NumberFormat("de-DE", { notation: "compact", maximumFractionDigits: 1 }).format(amount)}`;
  const start = new Date(history.start).getTime(), end = new Date(history.end).getTime();
  function selectFromPointer(event: ReactPointerEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const pointerX = (event.clientX - bounds.left) / bounds.width * width;
    setSelected(Math.max(0, Math.min(history!.points.length - 1, Math.floor((pointerX - left) / plotWidth * history!.points.length))));
  }

  return <div>
    <div className="mb-1 flex min-h-5 flex-wrap items-center justify-between gap-2 text-[11px] tabular-nums" style={{ color: "var(--text-muted)" }}>
      <span aria-live="polite">{active ? `${time(active.at)}–${time(new Date(active.at).getTime() + history.bucketMs)} · ${money(active.amount)}` : `Verkäufe pro ${interval === 1 ? "Minute" : `${interval} Minuten`}`}</span>
      <span>Gesamt <strong style={{ color: "var(--text)" }}>{money(history.total)}</strong></span>
    </div>
    <svg ref={svgRef} style={{ height: 240, outlineColor: "var(--accent)" }} className="w-full rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2" viewBox={`0 0 ${width} ${height}`}
      role="img" tabIndex={0} aria-label={`Verkaufsgraph der letzten ${range === "1h" ? "Stunde" : range === "6h" ? "6 Stunden" : "24 Stunden"}. Gesamt ${money(history.total)}.`}
      aria-describedby={hintId} onPointerLeave={event => { if (event.pointerType !== "touch") setSelected(null); }} onBlur={() => setSelected(null)}
      onPointerMove={selectFromPointer} onPointerDown={selectFromPointer}
      onKeyDown={event => {
        if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          setSelected(current => event.key === "Home" ? 0 : event.key === "End" ? history.points.length - 1 : Math.max(0, Math.min(history.points.length - 1, (current ?? 0) + (event.key === "ArrowLeft" ? -1 : 1))));
        }
      }}>
      <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop stopColor="var(--accent)" stopOpacity=".2" /><stop offset="1" stopColor="var(--accent)" stopOpacity="0" /></linearGradient></defs>
      {[0, 1, 2, 3, 4].map(index => <g key={index}>
        <line x1={left} x2={left + plotWidth} y1={top + plotHeight * index / 4} y2={top + plotHeight * index / 4} stroke="var(--border)" strokeDasharray={index === 4 ? undefined : "3 5"} />
        <text x={left + plotWidth + 12} y={top + plotHeight * index / 4 + 4} fill="var(--text-subtle)" fontSize="11">{axisMoney(max * (1 - index / 4))}</text>
        <text x={left + plotWidth * index / 4} y={height - 9} textAnchor={index === 0 ? "start" : index === 4 ? "end" : "middle"} fill="var(--text-subtle)" fontSize="11">{time(start + (end - start) * index / 4)}</text>
      </g>)}
      <polygon points={`${left},${top + plotHeight} ${line} ${left + plotWidth},${top + plotHeight}`} fill={`url(#${gradientId})`} />
      <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {selected != null && active && <g>
        <line x1={x(selected)} x2={x(selected)} y1={top} y2={top + plotHeight} stroke="var(--text-muted)" strokeDasharray="3 4" />
        <circle cx={x(selected)} cy={y(active.amount)} r="4" fill="var(--accent)" stroke="var(--bg)" strokeWidth="2" />
      </g>}
      {history.total === 0 && <text x={left + plotWidth / 2} y={top + plotHeight / 2} textAnchor="middle" fill="var(--text-subtle)" fontSize="12">Keine Verkäufe in diesem Zeitraum</text>}
    </svg>
    <p id={hintId} className="sr-only">Einzelne Zeiträume mit dem Zeiger oder den Pfeiltasten auswählen.</p>
    {error && <p className="mt-1 text-[11px]" role="status" style={{ color: "var(--text-subtle)" }}>Aktualisierung fehlgeschlagen. Der letzte Stand wird angezeigt.</p>}
  </div>;
}
