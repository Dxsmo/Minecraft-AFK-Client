import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useDashboardSocket } from "../lib/sockets";
import type { MinecraftAccount } from "../lib/types";
import { StatusBadge } from "../components/StatusBadge";
import { CreateAccountDialog } from "../components/CreateAccountDialog";

export function DashboardPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";
  const [accounts, setAccounts] = useState<MinecraftAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [reorderBusy, setReorderBusy] = useState(false);
  // Admin-only: locally censor (blur) individual account cards, e.g. while
  // screen-sharing. Persisted per admin in localStorage so it survives reloads.
  const blurKey = user ? `afk.blurredAccounts.${user.id}` : null;
  const [blurred, setBlurred] = useState<Set<string>>(new Set());
  const liveStatuses = useDashboardSocket();

  useEffect(() => {
    if (!blurKey) return;
    try {
      const raw = localStorage.getItem(blurKey);
      setBlurred(new Set(raw ? (JSON.parse(raw) as string[]) : []));
    } catch {
      setBlurred(new Set());
    }
  }, [blurKey]);

  function toggleBlur(id: string) {
    setBlurred((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      if (blurKey) localStorage.setItem(blurKey, JSON.stringify(Array.from(next)));
      return next;
    });
  }

  async function load() {
    try {
      setAccounts(await api.get<MinecraftAccount[]>("/minecraft/accounts"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load accounts");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const merged = useMemo(
    () => (accounts ?? []).map((a) => ({ ...a, live: liveStatuses[a.id] ?? a.live })),
    [accounts, liveStatuses],
  );

  const counts = useMemo(() => {
    const statuses = merged.map((a) => a.live?.status ?? a.status);
    return {
      total: statuses.length,
      online: statuses.filter((s) => s === "ONLINE").length,
      offline: statuses.filter((s) => s === "OFFLINE" || s === "DISCONNECTING").length,
      error: statuses.filter((s) => s === "ERROR").length,
    };
  }, [merged]);

  async function runAction(id: string, action: "start" | "stop" | "restart") {
    setBusyIds((prev) => new Set(prev).add(id));
    try {
      await api.post(`/minecraft/accounts/${id}/${action}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Failed to ${action}`);
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  async function deleteAccount(id: string, name: string) {
    if (!confirm(`Delete Minecraft account "${name}"? This cannot be undone.`)) return;
    setBusyIds((prev) => new Set(prev).add(id));
    try {
      await api.delete(`/minecraft/accounts/${id}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to delete account");
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  async function moveAccount(id: string, direction: -1 | 1) {
    if (!accounts || reorderBusy) return;
    const idx = accounts.findIndex((a) => a.id === id);
    const nextIdx = idx + direction;
    if (idx < 0 || nextIdx < 0 || nextIdx >= accounts.length) return;
    const next = [...accounts];
    [next[idx], next[nextIdx]] = [next[nextIdx], next[idx]];
    setAccounts(next);
    setReorderBusy(true);
    try {
      await api.put("/minecraft/accounts/reorder", { accountIds: next.map((a) => a.id) });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to reorder accounts");
      await load();
    } finally {
      setReorderBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold" style={{ color: "var(--text)" }}>
            Dashboard
          </h1>
          <p className="mt-0.5 text-sm" style={{ color: "var(--text-muted)" }}>
            Overview of your Minecraft AFK clients
          </p>
        </div>
        <button onClick={() => setDialogOpen(true)} className="btn btn-primary">
          + New account
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Online" value={counts.online} accent="#34d399" />
        <StatCard label="Offline" value={counts.offline} accent="#8a8a93" />
        <StatCard label="Errors" value={counts.error} accent="#f87171" />
      </div>

      {error && <p className="alert-error">{error}</p>}

      {accounts === null ? (
        <div className="card p-10 text-center text-sm" style={{ color: "var(--text-subtle)" }}>
          Loading accounts…
        </div>
      ) : merged.length === 0 ? (
        <div className="card p-14 text-center">
          <p className="text-sm font-medium" style={{ color: "var(--text)" }}>
            No Minecraft accounts yet
          </p>
          <p className="mx-auto mt-1 max-w-sm text-sm" style={{ color: "var(--text-muted)" }}>
            Create your first account to get started, or ask an admin to assign one to you.
          </p>
          <button onClick={() => setDialogOpen(true)} className="btn btn-secondary btn-sm mt-4">
            + New account
          </button>
        </div>
      ) : (
        <div className="space-y-2.5">
          {merged.map((account, index) => {
            const status = account.live?.status ?? account.status;
            const label = account.displayName?.trim() || account.live?.name || account.name;
            const busy = busyIds.has(account.id);
            const isBlurred = blurred.has(account.id);
            return (
              <div
                key={account.id}
                className="card card-hover flex flex-wrap items-center gap-x-4 gap-y-3 p-4"
              >
                <div className="flex items-center gap-2.5">
                  <div className="mr-0.5 flex shrink-0 flex-col gap-1">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm px-2"
                      onClick={() => void moveAccount(account.id, -1)}
                      disabled={reorderBusy || index === 0}
                      title="Move up"
                      aria-label="Move up"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm px-2"
                      onClick={() => void moveAccount(account.id, 1)}
                      disabled={reorderBusy || index === merged.length - 1}
                      title="Move down"
                      aria-label="Move down"
                    >
                      ↓
                    </button>
                  </div>
                </div>
                <div
                  className="min-w-0 flex-1"
                  style={{
                    filter: isBlurred ? "blur(6px)" : undefined,
                    userSelect: isBlurred ? "none" : undefined,
                    pointerEvents: isBlurred ? "none" : undefined,
                    transition: "filter 150ms ease",
                  }}
                  aria-hidden={isBlurred}
                >
                  <div className="flex items-center gap-2.5">
                    <span className="truncate font-medium" style={{ color: "var(--text)" }}>
                      {label}
                    </span>
                    <StatusBadge status={status} />
                    {account.edition === "BEDROCK" ? (
                      <span
                        className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                        style={{ backgroundColor: "rgba(245,158,11,0.15)", color: "var(--warning)" }}
                      >
                        Bedrock
                      </span>
                    ) : (
                      <span
                        className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                        style={{ backgroundColor: "rgba(96,165,250,0.15)", color: "#60a5fa" }}
                      >
                        Java
                      </span>
                    )}
                    {account.createdBy && (
                      <span className="shrink-0 text-[11px]" style={{ color: "var(--text-subtle)" }}>
                        Erstellt von{" "}
                        <span className="font-medium" style={{ color: "var(--text-muted)" }}>
                          {account.createdBy.username}
                        </span>
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-xs" style={{ color: "var(--text-subtle)" }}>
                    {account.serverHost}
                    {account.minecraftVersion ? ` · ${account.minecraftVersion}` : " · auto"}
                  </p>
                  <NotesField accountId={account.id} initial={account.notes ?? ""} />
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {isAdmin && (
                    <button
                      onClick={() => toggleBlur(account.id)}
                      className="btn btn-ghost btn-sm"
                      title={isBlurred ? "Reveal account" : "Blur / censor account"}
                      aria-label={isBlurred ? "Reveal account" : "Blur account"}
                    >
                      <EyeIcon off={isBlurred} />
                    </button>
                  )}
                  <button
                    disabled={busy || status === "ONLINE" || status === "CONNECTING"}
                    onClick={() => void runAction(account.id, "start")}
                    className="btn btn-secondary btn-sm"
                  >
                    Start
                  </button>
                  <button
                    disabled={busy || status === "OFFLINE"}
                    onClick={() => void runAction(account.id, "stop")}
                    className="btn btn-secondary btn-sm"
                  >
                    Stop
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => void runAction(account.id, "restart")}
                    className="btn btn-ghost btn-sm"
                  >
                    Restart
                  </button>
                  <Link to={`/accounts/${account.id}`} className="btn btn-primary btn-sm">
                    Settings
                  </Link>
                  <button
                    disabled={busy}
                    onClick={() => void deleteAccount(account.id, label)}
                    className="btn btn-danger btn-sm"
                    title="Delete account"
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {dialogOpen && (
        <CreateAccountDialog
          onClose={() => setDialogOpen(false)}
          onCreated={() => {
            setDialogOpen(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

/** Inline, debounced-autosave note line for an account (no save button). */
function NotesField({ accountId, initial }: { accountId: string; initial: string }) {
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState(false);
  const savedRef = useRef(initial);

  useEffect(() => {
    setValue(initial);
    savedRef.current = initial;
  }, [initial, accountId]);

  useEffect(() => {
    if (value === savedRef.current) return;
    const t = setTimeout(async () => {
      try {
        await api.patch(`/minecraft/accounts/${accountId}`, { notes: value });
        savedRef.current = value;
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
      } catch {
        /* ignore transient autosave errors; will retry on next edit */
      }
    }, 600);
    return () => clearTimeout(t);
  }, [value, accountId]);

  return (
    <div className="mt-1.5 flex items-center gap-2">
      <input
        value={value}
        maxLength={50}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Add a note…"
        className="w-full max-w-xs bg-transparent text-xs outline-none"
        style={{ color: "var(--text-muted)" }}
      />
      {saved && (
        <span className="shrink-0 text-[10px]" style={{ color: "var(--accent)" }}>
          saved
        </span>
      )}
    </div>
  );
}

/** Eye / eye-off icon used for the admin blur toggle. */
function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {off ? (
        <>
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
          <line x1="1" y1="1" x2="23" y2="23" />
        </>
      ) : (
        <>
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </svg>
  );
}

function StatCard({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div className="card relative overflow-hidden p-4">
      <span
        className="absolute inset-y-0 left-0 w-1"
        style={{ backgroundColor: accent, opacity: 0.7 }}
        aria-hidden="true"
      />
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: accent, boxShadow: `0 0 0 3px ${accent}22` }} />
        <p className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
          {label}
        </p>
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums" style={{ color: "var(--text)" }}>
        {value}
      </p>
    </div>
  );
}
