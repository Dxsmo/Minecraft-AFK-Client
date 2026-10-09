import { useEffect, useId, useRef, useState } from "react";
import { apiFetch } from "../lib/api";
import type { EarningsHistory } from "../lib/types";

const intervalMs = 5 * 60_000;
const money = (amount: number) => `$${(Math.round(amount / 1000) * 1000).toLocaleString("de-DE", { maximumFractionDigits: 0 })}`;
const time = (at: string) => new Date(at).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });

/** Fetch only while open; preserve a completed interval's data across quick hovers. */
export function AccountSellPreview({ accountId, active, blurred }: { accountId: string; active: boolean; blurred: boolean }) {
  const [history, setHistory] = useState<EarningsHistory | null>(null);
  const cached = useRef<EarningsHistory | null>(null);
  const [error, setError] = useState(false);
  const chart = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  const gradientId = useId();

  useEffect(() => {
    if (!active || !chart.current) return;
    const observer = new ResizeObserver(entries => setWidth(Math.max(180, Math.round(entries[0].contentRect.width))));
    observer.observe(chart.current);
    return () => observer.disconnect();
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      let retry = false;
      const end = Math.floor(Date.now() / intervalMs) * intervalMs;
      try {
        if (!cached.current || Date.parse(cached.current.end) !== end) {
          const data = await apiFetch<EarningsHistory>(`/minecraft/accounts/${accountId}/earnings/history?range=30m`, { signal: controller.signal });
          if (controller.signal.aborted) return;
          cached.current = data;
          setHistory(data);
          setError(false);
        }
      } catch {
        retry = true;
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, retry ? 15_000 : intervalMs - Date.now() % intervalMs + 100);
      }
    }
    // Short pointer crossings should not start an account-history request.
    timer = setTimeout(() => void refresh(), 100);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [accountId, active]);

  const points = history?.points ?? [];
  const step = Math.max(1000, Math.ceil(Math.max(0, ...points.map(point => point.amount)) / 2000) * 1000);
  const peak = step * 2;
  const height = 80, left = 4, right = Math.max(48, money(peak).length * 6 + 12), top = 7, bottom = 21;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const x = (index: number) => left + (index + 0.5) / points.length * plotWidth;
  const y = (amount: number) => top + (1 - amount / peak) * plotHeight;
  const line = points.map((point, index) => `${x(index)},${y(point.amount)}`).join(" ");
  const area = points.length ? `${x(0)},${y(0)} ${line} ${x(points.length - 1)},${y(0)}` : "";

  return <div ref={chart} className="account-sell-preview min-w-0">
    <p className="mb-1 text-[10px]" style={{ color: "var(--text-subtle)" }}>Verkäufe · letzte 30 Minuten</p>
    {history ? <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img"
      aria-label="Verkaufsgraph der letzten 30 Minuten in 5-Minuten-Intervallen">
      <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.18" />
        <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.015" />
      </linearGradient></defs>
      {[0, peak / 2, peak].map(amount => <g key={amount}>
        <line x1={left} x2={width - right} y1={y(amount)} y2={y(amount)} stroke="var(--border)" />
        <text x={width - right + 8} y={y(amount) + 3} fontSize="9" fill="var(--text-subtle)">{money(amount)}</text>
      </g>)}
      <polygon points={area} fill={`url(#${gradientId})`} />
      <polyline points={line} fill="none" stroke="var(--accent-light)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      {points.map((point, index) => <g key={point.at}>
        {!blurred && <title>{time(point.at)} · {money(point.amount)}</title>}
        <circle cx={x(index)} cy={y(point.amount)} r="2" fill="var(--accent-light)" />
        <text x={x(index)} y={height - 5} textAnchor="middle" fontSize="9" fill="var(--text-subtle)">{time(point.at)}</text>
      </g>)}
    </svg> : <div className="flex h-20 items-center justify-center text-[10px]" role="status" style={{ color: "var(--text-subtle)" }}>
      {error ? "Verkaufsverlauf konnte nicht geladen werden." : "Verkaufsverlauf wird geladen…"}
    </div>}
    {history && error && <p className="text-[10px]" style={{ color: "var(--text-subtle)" }}>Letzter Stand · Aktualisierung fehlgeschlagen</p>}
  </div>;
}
