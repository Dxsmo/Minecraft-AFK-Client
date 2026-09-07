import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { ItemWorthAccount, ItemWorthState, ItemWorthValue } from "../lib/types";

/** How often to re-poll while a scan is actually moving. */
const POLL_INTERVAL_MS = 4000;
/** Slower heartbeat when idle, just to keep the online badges honest. */
const IDLE_POLL_INTERVAL_MS = 15000;

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

function formatDuration(seconds: number | null): string | null {
  if (seconds === null || seconds <= 0) return null;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (hours > 0) return `${hours} h ${minutes} min`;
  return `${Math.max(1, minutes)} min`;
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

function accountLabel(account: ItemWorthAccount): string {
  return account.displayName?.trim() || account.name;
}

/**
 * Admin-only "Item Wert" page: sweeps `/worth <item>` over the whole item
 * registry, spread round-robin across several bots, and shows the resulting
 * price table with everything that moved since the previous sweep highlighted.
 */
export function ItemWorthPage() {
  const [state, setState] = useState<ItemWorthState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>("changed");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [delay, setDelay] = useState(5);
  // The selection is only pre-filled once, so polling never fights the user.
  const [selectionInit, setSelectionInit] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await api.get<ItemWorthState>("/item-worth"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Item-Werte konnten nicht geladen werden");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Adopt the running scan's settings so a page reload shows what is going on.
  useEffect(() => {
    if (!state || selectionInit) return;
    setDelay(state.delaySeconds);
    const online = new Set(state.accounts.filter((a) => a.online).map((a) => a.id));
    const previous = state.accountIds.filter((id) => online.has(id));
    setSelected(new Set(previous.length > 0 ? previous : online));
    setSelectionInit(true);
  }, [state, selectionInit]);

  const active = state?.status === "RUNNING" || state?.status === "PAUSED";
  useEffect(() => {
    const timer = setInterval(
      () => void load(),
      active ? POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS,
    );
    return () => clearInterval(timer);
  }, [active, load]);

  function toggleAccount(account: ItemWorthAccount) {
    if (!account.online) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(account.id)) next.delete(account.id);
      else next.add(account.id);
      return next;
    });
  }

  async function control(action: "start" | "stop") {
    setBusy(true);
    setError(null);
    try {
      const body =
        action === "start"
          ? { accountIds: [...selected], delaySeconds: delay }
          : undefined;
      const next = await api.post<ItemWorthState>(`/item-worth/${action}`, body);
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
        (item) => item.itemName.toLowerCase().includes(needle) || item.itemId.includes(needle),
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
      <p className="text-sm" style={{ color: "var(--text-subtle)" }}>
        {error ?? "Lade Item-Werte…"}
      </p>
    );
  }

  const total = state.total || state.registryTotal;
  const percent = total > 0 ? Math.min(100, (state.cursor / total) * 100) : 0;
  const running = state.status === "RUNNING";
  const paused = state.status === "PAUSED";
  const eta = formatDuration(state.etaSeconds);
  const scanned = state.values.length;
  const onlineAccounts = state.accounts.filter((a) => a.online);
  const canStart = selected.size > 0 && !busy;
  // Each bot only speaks every (delay * bots) seconds — that is the whole point
  // of spreading the scan, so show it explicitly.
  const perBotSeconds = delay * Math.max(1, selected.size);
  const fullRunSeconds = state.registryTotal * delay;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold" style={{ color: "var(--text)" }}>
          Item Wert
        </h1>
        <p className="mt-0.5 max-w-3xl text-sm" style={{ color: "var(--text-muted)" }}>
          Fragt nacheinander <b>jedes</b> der {state.registryTotal} Items mit{" "}
          <code>/worth &lt;item&gt;</code> ab und speichert den Preis. Die Abfragen werden
          reihum auf die gewählten Accounts verteilt (Acc 1 → Item A, Acc 2 → Item B, …), so
          bleibt das Tempo hoch, ohne dass ein einzelner Bot auffällt. Ab dem zweiten Scan
          werden alle Preisänderungen markiert — so fallen auch <b>Off-Metas</b> auf, die nicht
          angekündigt wurden.
        </p>
      </div>

      {/* Configuration. */}
      <div
        className="rounded-xl border p-4"
        style={{ borderColor: "var(--border)", backgroundColor: "var(--surface)" }}
      >
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-medium">Accounts für den Scan</h2>
          <span className="text-[11px]" style={{ color: "var(--text-subtle)" }}>
            {onlineAccounts.length} von {state.accounts.length} online
          </span>
        </div>

        {state.accounts.length === 0 ? (
          <p className="text-xs" style={{ color: "var(--text-subtle)" }}>
            Es gibt noch keine Minecraft-Accounts.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {state.accounts.map((account) => {
              const isSelected = selected.has(account.id);
              return (
                <button
                  key={account.id}
                  type="button"
                  disabled={!account.online || running}
                  onClick={() => toggleAccount(account)}
                  data-active={isSelected && account.online}
                  className="item-worth-chip"
                  title={account.online ? undefined : `Offline (${account.status})`}
                  style={
                    account.online
                      ? undefined
                      : { opacity: 0.4, cursor: "not-allowed", textDecoration: "line-through" }
                  }
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 999,
                      display: "inline-block",
                      marginRight: 6,
                      backgroundColor: account.online ? "#4ade80" : "var(--text-subtle)",
                    }}
                  />
                  {accountLabel(account)}
                </button>
              );
            })}
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-end gap-4">
          <label className="min-w-[16rem] flex-1">
            <span className="mb-1 block text-xs" style={{ color: "var(--text-muted)" }}>
              Pause zwischen zwei Abfragen: <b>{delay}s</b>
            </span>
            <input
              type="range"
              min={state.minDelaySeconds}
              max={state.maxDelaySeconds}
              step={1}
              value={delay}
              disabled={running}
              onChange={(event) => setDelay(Number(event.target.value))}
              className="w-full accent-indigo-500"
            />
          </label>

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
              disabled={!canStart}
              className="btn btn-primary btn-sm"
            >
              {state.scanNumber > 0 ? "Neuen Scan starten" : "Scan starten"}
            </button>
          )}
        </div>

        <p className="mt-2 text-[11px]" style={{ color: "var(--text-subtle)" }}>
          {selected.size === 0
            ? "Wähle mindestens einen Online-Account aus."
            : `${selected.size} Account${selected.size === 1 ? "" : "s"} · ein Item alle ${delay}s · jeder Bot schreibt nur alle ${perBotSeconds}s · kompletter Durchlauf ca. ${formatDuration(fullRunSeconds)}`}
        </p>
      </div>

      {/* Progress. */}
      <div
        className="rounded-xl border p-4"
        style={{ borderColor: "var(--border)", backgroundColor: "var(--surface)" }}
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
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
            <span style={{ color: "var(--text-subtle)" }}>{state.missedCount} ohne Antwort</span>
          )}
          {running && eta && <span style={{ color: "var(--text-subtle)" }}>noch ca. {eta}</span>}
        </div>

        {paused && state.lastError && (
          <p className="mt-3 text-[11px]" style={{ color: state.resumable ? "#fbbf24" : "#f87171" }}>
            {state.lastError}
            {state.resumable
              ? " — der Scan macht automatisch weiter, sobald wieder ein Bot online ist."
              : " — bitte prüfen und den Scan danach neu starten."}
          </p>
        )}
        {error && <p className="alert-error mt-3">{error}</p>}
      </div>

      {/* Results. */}
      {scanned > 0 && (
        <div className="space-y-3">
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
              className="ml-auto min-w-[8rem] max-w-xs flex-1 rounded-lg px-2 py-1 text-xs"
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
              className="max-h-[32rem] overflow-y-auto rounded-xl border"
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
        </div>
      )}
    </div>
  );
}
