import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { useSniperDashboardSocket } from "../lib/sockets";
import type { SniperAccount } from "../lib/types";
import { StatusBadge } from "../components/StatusBadge";
import { CreateSniperAccountDialog } from "../components/CreateSniperAccountDialog";

/**
 * Admin-only Name Sniper list, structurally mirroring DashboardPage but
 * completely independent — no MinecraftAccount rows are shown or affected
 * here, and vice versa.
 */
export function NameSniperPage() {
  const [accounts, setAccounts] = useState<SniperAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [reorderBusy, setReorderBusy] = useState(false);
  const liveStatuses = useSniperDashboardSocket();

  async function load() {
    try {
      setAccounts(await api.get<SniperAccount[]>("/namesniper/accounts"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load Name Sniper accounts");
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
      running: statuses.filter((s) => s === "ONLINE" || s === "CONNECTING").length,
      idle: statuses.filter((s) => s === "OFFLINE").length,
      error: statuses.filter((s) => s === "ERROR").length,
    };
  }, [merged]);

  async function runAction(id: string, action: "start" | "stop") {
    setBusyIds((prev) => new Set(prev).add(id));
    try {
      await api.post(`/namesniper/accounts/${id}/${action}`);
      await load();
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

  async function deleteAccount(id: string, label: string) {
    if (!confirm(`Delete Name Sniper account "${label}"? This cannot be undone.`)) return;
    setBusyIds((prev) => new Set(prev).add(id));
    try {
      await api.delete(`/namesniper/accounts/${id}`);
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
      await api.put("/namesniper/accounts/reorder", { accountIds: next.map((a) => a.id) });
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
            Name Sniper
          </h1>
          <p className="mt-0.5 text-sm" style={{ color: "var(--text-muted)" }}>
            Continuously try to claim a desired Minecraft name for an account. Admin-only.
          </p>
        </div>
        <button onClick={() => setDialogOpen(true)} className="btn btn-primary">
          + New account
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Running" value={counts.running} accent="#38bdf8" />
        <StatCard label="Idle" value={counts.idle} accent="#8a8a93" />
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
            No Name Sniper accounts yet
          </p>
          <p className="mx-auto mt-1 max-w-sm text-sm" style={{ color: "var(--text-muted)" }}>
            Add a Microsoft account and pick a desired name to start sniping.
          </p>
          <button onClick={() => setDialogOpen(true)} className="btn btn-secondary btn-sm mt-4">
            + New account
          </button>
        </div>
      ) : (
        <div className="space-y-2.5">
          {merged.map((account, index) => {
            const status = account.live?.status ?? account.status;
            const label = account.label?.trim() || account.email;
            const busy = busyIds.has(account.id);
            return (
              <div key={account.id} className="card card-hover flex flex-wrap items-center gap-x-4 gap-y-3 p-4">
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
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2.5">
                    <span className="truncate font-medium" style={{ color: "var(--text)" }}>
                      {label}
                    </span>
                    <StatusBadge status={status} />
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
                    {account.email}
                    {account.desiredName ? ` · Wunschname: ${account.desiredName}` : " · kein Wunschname gesetzt"}
                    {account.currentName ? ` · aktuell: ${account.currentName}` : ""}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    disabled={busy || !account.desiredName.trim() || status === "ONLINE" || status === "CONNECTING"}
                    onClick={() => void runAction(account.id, "start")}
                    className="btn btn-secondary btn-sm"
                    title={!account.desiredName.trim() ? "Set a desired name first" : undefined}
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
                  <Link to={`/namesniper/${account.id}`} className="btn btn-primary btn-sm">
                    Öffnen
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
        <CreateSniperAccountDialog
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

function StatCard({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div className="card relative overflow-hidden p-4">
      <span className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: accent, opacity: 0.7 }} aria-hidden="true" />
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
