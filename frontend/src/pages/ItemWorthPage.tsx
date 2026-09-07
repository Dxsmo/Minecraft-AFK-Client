import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../lib/api";
import type {
  ItemWorthAccount,
  ItemWorthRunDetail,
  ItemWorthRunSummary,
  ItemWorthState,
  ItemWorthValue,
  SuspiciousItem,
} from "../lib/types";

/** How often to re-poll while a scan is actually moving. */
const POLL_INTERVAL_MS = 4000;
/** Slower heartbeat when idle, just to keep the online badges honest. */
const IDLE_POLL_INTERVAL_MS = 15000;

type Filter = "changed" | "priced" | "all";
type Tab = "prices" | "suspicious" | "history";

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
  const [tab, setTab] = useState<Tab>("prices");
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
    const online = new Set((state.accounts ?? []).filter((a) => a.online).map((a) => a.id));
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
  // Defensive: a payload without `accounts` must degrade to an empty picker,
  // never take the whole page down with it.
  const allAccounts = state.accounts ?? [];
  const recentItems = state.recent ?? [];
  const suspiciousItems = state.suspicious ?? [];
  const onlineAccounts = allAccounts.filter((a) => a.online);
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
            {onlineAccounts.length} von {allAccounts.length} online
          </span>
        </div>

        {allAccounts.length === 0 ? (
          <p className="text-xs" style={{ color: "var(--text-subtle)" }}>
            Es gibt noch keine Minecraft-Accounts.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {allAccounts.map((account) => {
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

        {/* The exact /worth wording is server-specific. When nothing is
            understood, show what actually came back instead of leaving the
            admin with an unexplainable "no answer". */}
        {state.missedCount > 0 && state.lastSamples && (
          <details className="mt-3">
            <summary className="cursor-pointer text-[11px]" style={{ color: "var(--text-muted)" }}>
              Warum kam keine Antwort? Serverausgabe zu{" "}
              <code>{state.lastSamples.command}</code> ansehen
            </summary>
            <div
              className="mt-2 rounded-lg p-2 text-[10px] leading-relaxed"
              style={{
                backgroundColor: "var(--bg-elev)",
                border: "1px solid var(--border)",
                color: "var(--text-muted)",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              }}
            >
              {state.lastSamples.lines.length === 0 ? (
                <span style={{ color: "var(--text-subtle)" }}>
                  Der Server hat im Zeitfenster überhaupt nichts geschrieben — der Befehl kam
                  vermutlich nicht an oder heißt anders.
                </span>
              ) : (
                state.lastSamples.lines.map((line, index) => (
                  <div key={index} className="truncate">
                    {line}
                  </div>
                ))
              )}
            </div>
          </details>
        )}

        {error && <p className="alert-error mt-3">{error}</p>}
      </div>

      {/* Live feed of what the bots are checking right now. */}
      {recentItems.length > 0 && (
        <div
          className="rounded-xl border p-4"
          style={{ borderColor: "var(--border)", backgroundColor: "var(--surface)" }}
        >
          <h2 className="mb-2 text-sm font-medium">
            Zuletzt geprüft{running && <span className="item-worth-pulse"> ·</span>}
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {recentItems.map((entry, index) => (
              <span
                key={entry.itemId}
                className="item-worth-recent"
                style={{ animationDelay: `${Math.min(index, 12) * 25}ms` }}
                title={`${entry.itemId} · ${new Date(entry.recordedAt).toLocaleTimeString("de-DE")}`}
              >
                {entry.itemName}
                <b
                  style={{
                    marginLeft: 6,
                    color: entry.value === null ? "var(--text-subtle)" : "var(--accent-light)",
                  }}
                >
                  {formatMoney(entry.value)}
                </b>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Tabs. */}
      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            ["prices", `Preise (${scanned})`],
            ["suspicious", `Verdächtig (${suspiciousItems.length})`],
            ["history", "Verlauf"],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            data-active={tab === key}
            className="item-worth-chip"
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "suspicious" && <SuspiciousList items={suspiciousItems} />}
      {tab === "history" && <RunHistory currentScanNumber={state.scanNumber} />}

      {/* Results. */}
      {tab === "prices" && scanned > 0 && (
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

function formatDeviation(deviation: number | null): string {
  if (deviation === null) return "kein Preis";
  const percent = deviation * 100;
  return `${percent > 0 ? "+" : ""}${percent.toFixed(0)}%`;
}

/**
 * Items whose price does not fit the rest of their cosmetic variant family
 * (every boat costs $1, one costs $2.50). That pattern is the clearest signal
 * of a deliberate, unannounced price change.
 */
function SuspiciousList({ items }: { items: SuspiciousItem[] }) {
  if (items.length === 0) {
    return (
      <p className="text-xs" style={{ color: "var(--text-subtle)" }}>
        Keine Auffälligkeiten. Hier landen Items, die aus der Reihe tanzen — z. B. wenn alle
        Boote $1 kosten, ein einzelnes aber plötzlich $2,50. Dafür muss der Scan die jeweilige
        Item-Familie erst einmal komplett erfasst haben.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs" style={{ color: "var(--text-subtle)" }}>
        Diese Items weichen vom Preis ihrer eigenen Familie ab. Verglichen wird nur innerhalb
        rein kosmetischer Varianten (Holzarten, Farben) — Eisen und Gold landen bewusst nie in
        derselben Gruppe.
      </p>

      <div
        className="max-h-[32rem] overflow-y-auto rounded-xl border"
        style={{ borderColor: "var(--border)" }}
      >
        {items.map((item, index) => {
          const up = (item.deviation ?? 0) > 0;
          return (
            <div
              key={item.itemId}
              className="item-worth-row"
              style={{ animationDelay: `${Math.min(index, 15) * 18}ms` }}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs">{item.itemName}</span>
                <span className="block truncate text-[10px]" style={{ color: "var(--text-subtle)" }}>
                  {item.agreeing} von {item.familySize} in „{item.family}" kosten{" "}
                  {formatMoney(item.expected)}
                </span>
              </span>

              <span
                className="shrink-0 text-[10px] tabular-nums"
                style={{ color: "var(--text-subtle)" }}
              >
                {formatMoney(item.expected)} →
              </span>

              <span
                className="w-20 shrink-0 text-right text-xs tabular-nums"
                style={{ color: item.value === null ? "var(--text-subtle)" : "var(--text)" }}
              >
                {formatMoney(item.value)}
              </span>

              <span className="w-16 shrink-0 text-right">
                <span
                  className="item-worth-delta"
                  style={{
                    color: up ? "#4ade80" : "#f87171",
                    backgroundColor: up ? "rgba(74, 222, 128, 0.12)" : "rgba(248, 113, 113, 0.12)",
                  }}
                >
                  {formatDeviation(item.deviation)}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const RUN_STATUS_LABEL: Record<string, string> = {
  RUNNING: "Läuft",
  COMPLETED: "Abgeschlossen",
  CANCELLED: "Abgebrochen",
  PAUSED: "Pausiert",
};

/**
 * Archive of every scan ever run. The live price table only holds the newest
 * value per item, so without this a second scan would make the first one's
 * numbers unrecoverable.
 */
function RunHistory({ currentScanNumber }: { currentScanNumber: number }) {
  const [runs, setRuns] = useState<ItemWorthRunSummary[] | null>(null);
  const [openRun, setOpenRun] = useState<ItemWorthRunDetail | null>(null);
  const [loadingRun, setLoadingRun] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        setRuns(await api.get<ItemWorthRunSummary[]>("/item-worth/runs"));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Verlauf konnte nicht geladen werden");
      }
    })();
    // Refetch whenever a scan finishes, so a fresh run shows up without a reload.
  }, [currentScanNumber]);

  async function open(scanNumber: number) {
    if (openRun?.scanNumber === scanNumber) {
      setOpenRun(null);
      return;
    }
    setLoadingRun(scanNumber);
    setError(null);
    try {
      setOpenRun(await api.get<ItemWorthRunDetail>(`/item-worth/runs/${scanNumber}`));
      setQuery("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Scan konnte nicht geladen werden");
    } finally {
      setLoadingRun(null);
    }
  }

  const openRows = useMemo(() => {
    if (!openRun) return [];
    const needle = query.trim().toLowerCase();
    if (!needle) return openRun.values;
    return openRun.values.filter(
      (item) => item.itemName.toLowerCase().includes(needle) || item.itemId.includes(needle),
    );
  }, [openRun, query]);

  if (error) return <p className="alert-error">{error}</p>;
  if (!runs) {
    return (
      <p className="text-xs" style={{ color: "var(--text-subtle)" }}>
        Lade Verlauf…
      </p>
    );
  }
  if (runs.length === 0) {
    return (
      <p className="text-xs" style={{ color: "var(--text-subtle)" }}>
        Noch keine Scans archiviert. Jeder gestartete Scan wird hier dauerhaft abgelegt und
        bleibt abrufbar, auch nachdem ein neuerer Scan die aktuellen Preise überschrieben hat.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs" style={{ color: "var(--text-subtle)" }}>
        Jeder Scan wird komplett archiviert. Ein neuer Scan überschreibt die alten Listen nicht —
        du kommst jederzeit an jeden früheren Preisstand.
      </p>

      <div className="space-y-2">
        {runs.map((run) => {
          const isOpen = openRun?.scanNumber === run.scanNumber;
          return (
            <div
              key={run.scanNumber}
              className="rounded-xl border"
              style={{ borderColor: "var(--border)", backgroundColor: "var(--surface)" }}
            >
              <button
                type="button"
                onClick={() => void open(run.scanNumber)}
                className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left"
              >
                <span className="text-sm font-medium">Scan #{run.scanNumber}</span>
                <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                  {formatTimestamp(run.startedAt)}
                </span>
                <span className="text-[11px]" style={{ color: "var(--text-subtle)" }}>
                  {run.itemCount} Items
                </span>
                {run.changedCount > 0 && (
                  <span className="text-[11px]" style={{ color: "#fbbf24" }}>
                    {run.changedCount} Änderungen
                  </span>
                )}
                {run.missedCount > 0 && (
                  <span className="text-[11px]" style={{ color: "var(--text-subtle)" }}>
                    {run.missedCount} ohne Antwort
                  </span>
                )}
                <span className="ml-auto text-[11px]" style={{ color: "var(--text-subtle)" }}>
                  {loadingRun === run.scanNumber
                    ? "Lädt…"
                    : (RUN_STATUS_LABEL[run.status] ?? run.status)}
                </span>
                <span className="text-[11px]" style={{ color: "var(--text-subtle)" }}>
                  {isOpen ? "▲" : "▼"}
                </span>
              </button>

              {isOpen && openRun && (
                <div className="border-t px-4 py-3" style={{ borderColor: "var(--border)" }}>
                  {openRun.suspicious.length > 0 && (
                    <p className="mb-2 text-[11px]" style={{ color: "#fbbf24" }}>
                      {openRun.suspicious.length} verdächtige Items in diesem Scan
                    </p>
                  )}
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Item suchen…"
                    className="mb-2 w-full rounded-lg px-2 py-1 text-xs"
                    style={{
                      backgroundColor: "var(--bg-elev)",
                      border: "1px solid var(--border)",
                      color: "var(--text)",
                    }}
                  />
                  <div
                    className="max-h-80 overflow-y-auto rounded-lg border"
                    style={{ borderColor: "var(--border)" }}
                  >
                    {openRows.map((item) => (
                      <div key={item.itemId} className="item-worth-row">
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
                          style={{
                            color: item.value === null ? "var(--text-subtle)" : "var(--text)",
                          }}
                        >
                          {formatMoney(item.value)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
