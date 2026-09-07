import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { ItemWorthState, ItemWorthValue } from "../lib/types";

/** How often to re-poll while a scan is actually moving. */
const POLL_INTERVAL_MS = 4000;

type Filter = "changed" | "priced" | "all";

const STATUS_LABEL: Record<ItemWorthState["status"], string> = {
  IDLE: "Noch kein Scan",
  RUNNING: "Läuft",
  PAUSED: "Pausiert",
  COMPLETED: "Abgeschlossen",
  CANCELLED: "Abgebrochen",
};

const STATUS_COLOR: Record<ItemWorthState["status"], string> = {
  IDLE: "var(--text-subtle)",
  RUNNING: "var(--accent-light)",
  PAUSED: "#fbbf24",
  COMPLETED: "#4ade80",
  CANCELLED: "#f87171",
};

function formatMoney(value: number | null): string {
  if (value === null) return "—";
  return `$${value.toLocaleString("de-DE", { maximumFractionDigits: 2 })}`;
}

function formatEta(seconds: number | null): string | null {
  if (seconds === null || seconds <= 0) return null;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (hours > 0) return `noch ca. ${hours} h ${minutes} min`;
  return `noch ca. ${Math.max(1, minutes)} min`;
}

/**
 * Relative change between two prices. Returns null when a percentage is
 * meaningless (an item gained or lost its price, or came off zero) — the
 * caller shows a "neu"/"weg" badge for those instead.
 */
function deltaPercent(item: ItemWorthValue): number | null {
  if (!item.changed) return null;
  const { previousValue: prev, value: next } = item;
  if (prev === null || next === null || prev === 0) return null;
  return ((next - prev) / Math.abs(prev)) * 100;
}

/** Badge text + direction for a changed item. Derived from the values, not
 *  from the percentage, so a newly-priced item is not rendered as a removal. */
function changeBadge(item: ItemWorthValue): { label: string; up: boolean } | null {
  if (!item.changed) return null;
  const { previousValue: prev, value: next } = item;
  if (next === null) return { label: "weg", up: false };
  if (prev === null) return { label: "neu", up: true };
  const delta = deltaPercent(item);
  if (delta === null) return { label: next > prev ? "neu" : "weg", up: next > prev };
  return { label: `${delta > 0 ? "+" : ""}${delta.toFixed(0)}%`, up: delta > 0 };
}

/**
 * Admin-only "Item Wert" tab: kicks off a full `/worth` sweep of the item
 * registry and shows the resulting price table, highlighting everything that
 * moved since the previous sweep so silent price changes become obvious.
 */
export function ItemWorthPanel({ accountId }: { accountId: string }) {
  const [state, setState] = useState<ItemWorthState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>("changed");
  const [query, setQuery] = useState("");
  // Avoids a stale poll from a previous account overwriting fresh state.
  const accountRef = useRef(accountId);
  accountRef.current = accountId;

  const load = useCallback(async () => {
    try {
      const next = await api.get<ItemWorthState>(`/minecraft/accounts/${accountId}/item-worth`);
      if (accountRef.current === accountId) setState(next);
    } catch (err) {
      if (accountRef.current === accountId) {
        setError(err instanceof ApiError ? err.message : "Item-Werte konnten nicht geladen werden");
      }
    }
  }, [accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll only while there is something to watch, so an idle tab is free.
  const active = state?.status === "RUNNING" || state?.status === "PAUSED";
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active, load]);

  async function control(action: "start" | "stop") {
    setBusy(true);
    setError(null);
    try {
      const next = await api.post<ItemWorthState>(
        `/minecraft/accounts/${accountId}/item-worth/${action}`,
      );
      setState(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Aktion fehlgeschlagen");
    } finally {
      setBusy(false);
    }
  }

  const rows = useMemo(() => {
    if (!state) return [];
    const needle = query.trim().toLowerCase();
    let list = state.values;
    if (filter === "changed") list = list.filter((item) => item.changed);
    else if (filter === "priced") list = list.filter((item) => item.value !== null);
    if (needle) {
      list = list.filter(
        (item) =>
          item.itemName.toLowerCase().includes(needle) || item.itemId.includes(needle),
      );
    }
    return [...list].sort((a, b) => {
      // Biggest movers first, then most valuable, then alphabetical.
      if (a.changed !== b.changed) return a.changed ? -1 : 1;
      const da = Math.abs(deltaPercent(a) ?? 0);
      const db = Math.abs(deltaPercent(b) ?? 0);
      if (da !== db) return db - da;
      if ((b.value ?? -1) !== (a.value ?? -1)) return (b.value ?? -1) - (a.value ?? -1);
      return a.itemName.localeCompare(b.itemName);
    });
  }, [state, filter, query]);

  if (!state) {
    return (
      <p className="text-xs" style={{ color: "var(--text-subtle)" }}>
        {error ?? "Lade Item-Werte…"}
      </p>
    );
  }

  const total = state.total || state.registryTotal;
  const percent = total > 0 ? Math.min(100, (state.cursor / total) * 100) : 0;
  const running = state.status === "RUNNING";
  const paused = state.status === "PAUSED";
  const eta = formatEta(state.etaSeconds);
  const scanned = state.values.length;

  return (
    <>
      <p className="text-xs" style={{ color: "var(--text-subtle)" }}>
        Fragt nacheinander <b>jedes</b> der {state.registryTotal} Items mit{" "}
        <code>/worth &lt;item&gt;</code> ab und speichert den Preis. Zwischen zwei Abfragen
        liegen zufällig 5–10 Sekunden, ein kompletter Durchlauf dauert daher rund 3 Stunden.
        Ab dem zweiten Scan werden alle Preisänderungen markiert — so fallen auch{" "}
        <b>Off-Metas</b> auf, die nicht angekündigt wurden. Der Scan startet nur, wenn du ihn
        hier startest.
      </p>

      {/* Progress card. */}
      <div
        className="rounded-xl border p-4"
        style={{ borderColor: "var(--border)", backgroundColor: "var(--surface)" }}
      >
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span
              className={running ? "item-worth-pulse" : ""}
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                backgroundColor: STATUS_COLOR[state.status],
                display: "inline-block",
              }}
            />
            <span className="text-sm font-medium">{STATUS_LABEL[state.status]}</span>
            {state.scanNumber > 0 && (
              <span className="text-[11px]" style={{ color: "var(--text-subtle)" }}>
                Scan #{state.scanNumber}
              </span>
            )}
          </div>

          {running || (paused && state.resumable) ? (
            <button
              type="button"
              onClick={() => void control("stop")}
              disabled={busy}
              className="btn btn-danger btn-sm"
            >
              Scan stoppen
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void control("start")}
              disabled={busy}
              className="btn btn-primary btn-sm"
            >
              {state.scanNumber > 0 ? "Neuen Scan starten" : "Scan starten"}
            </button>
          )}
        </div>

        <div className="item-worth-track">
          <div
            className={`item-worth-fill${running ? " is-running" : ""}`}
            style={{ width: `${percent}%` }}
          />
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
          <span style={{ color: "var(--text-muted)" }}>
            {state.cursor} / {total} Items
          </span>
          {state.changedCount > 0 && (
            <span style={{ color: "#fbbf24" }}>{state.changedCount} Änderungen</span>
          )}
          {state.missedCount > 0 && (
            <span style={{ color: "var(--text-subtle)" }}>
              {state.missedCount} ohne Antwort
            </span>
          )}
          {running && eta && <span style={{ color: "var(--text-subtle)" }}>{eta}</span>}
        </div>

        {paused && state.lastError && (
          <p className="mt-3 text-[11px]" style={{ color: state.resumable ? "#fbbf24" : "#f87171" }}>
            {state.lastError}
            {state.resumable
              ? " — der Scan macht automatisch weiter, sobald der Bot wieder online ist."
              : " — bitte prüfen und den Scan danach neu starten."}
          </p>
        )}
        {error && <p className="alert-error mt-3">{error}</p>}
      </div>

      {/* Results. */}
      {scanned > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {(
              [
                ["changed", `Änderungen (${state.values.filter((v) => v.changed).length})`],
                ["priced", `Mit Preis (${state.values.filter((v) => v.value !== null).length})`],
                ["all", `Alle (${scanned})`],
              ] as [Filter, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                data-active={filter === key}
                className="item-worth-chip"
              >
                {label}
              </button>
            ))}
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Item suchen…"
              className="ml-auto min-w-[8rem] flex-1 rounded-lg px-2 py-1 text-xs"
              style={{
                backgroundColor: "var(--bg-elev)",
                border: "1px solid var(--border)",
                color: "var(--text)",
              }}
            />
          </div>

          {rows.length === 0 ? (
            <p className="text-xs" style={{ color: "var(--text-subtle)" }}>
              {filter === "changed" && state.scanNumber < 2
                ? "Der erste Scan legt nur die Ausgangswerte an. Änderungen erscheinen nach dem nächsten Scan."
                : "Keine Items für diesen Filter."}
            </p>
          ) : (
            <div
              className="max-h-96 overflow-y-auto rounded-xl border"
              style={{ borderColor: "var(--border)" }}
            >
              {rows.map((item, index) => {
                const badge = changeBadge(item);
                return (
                  <div
                    key={item.itemId}
                    className="item-worth-row"
                    style={{ animationDelay: `${Math.min(index, 15) * 18}ms` }}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs">{item.itemName}</span>
                      <span
                        className="block truncate text-[10px]"
                        style={{ color: "var(--text-subtle)" }}
                      >
                        {item.itemId}
                      </span>
                    </span>

                    {item.changed && (
                      <span
                        className="shrink-0 text-[10px] tabular-nums"
                        style={{ color: "var(--text-subtle)" }}
                      >
                        {formatMoney(item.previousValue)} →
                      </span>
                    )}

                    <span
                      className="w-20 shrink-0 text-right text-xs tabular-nums"
                      style={{ color: item.value === null ? "var(--text-subtle)" : "var(--text)" }}
                    >
                      {formatMoney(item.value)}
                    </span>

                    <span className="w-16 shrink-0 text-right">
                      {badge && (
                        <span
                          className="item-worth-delta"
                          style={{
                            color: badge.up ? "#4ade80" : "#f87171",
                            backgroundColor: badge.up
                              ? "rgba(74, 222, 128, 0.12)"
                              : "rgba(248, 113, 113, 0.12)",
                          }}
                        >
                          {badge.label}
                        </span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </>
  );
}
