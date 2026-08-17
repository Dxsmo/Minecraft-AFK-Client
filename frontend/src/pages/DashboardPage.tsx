import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { useDashboardSocket } from "../lib/sockets";
import type { MinecraftAccount } from "../lib/types";
import { StatusBadge } from "../components/StatusBadge";
import { CreateAccountDialog } from "../components/CreateAccountDialog";

export function DashboardPage() {
  const [accounts, setAccounts] = useState<MinecraftAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const liveStatuses = useDashboardSocket();

  async function load() {
    try {
      const data = await api.get<MinecraftAccount[]>("/minecraft/accounts");
      setAccounts(data);
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
      online: statuses.filter((s) => s === "ONLINE").length,
      offline: statuses.filter((s) => s === "OFFLINE").length,
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Dashboard</h1>
          <p className="text-sm text-slate-500">Overview of all Minecraft AFK clients</p>
        </div>
        <button onClick={() => setDialogOpen(true)} className="btn-primary">
          + New account
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SummaryCard label="Online Clients" value={counts.online} tone="emerald" />
        <SummaryCard label="Offline Clients" value={counts.offline} tone="slate" />
        <SummaryCard label="Errors" value={counts.error} tone="red" />
      </div>

      {error && <p className="rounded-md bg-red-950 px-3 py-2 text-sm text-red-400">{error}</p>}

      <div className="card overflow-hidden">
        {accounts === null ? (
          <div className="p-8 text-center text-sm text-slate-500">Loading accounts...</div>
        ) : merged.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-sm font-medium text-slate-100">No Minecraft accounts yet</p>
            <p className="mt-1 text-sm text-slate-500">
              Create your first account to get started, or ask an admin to assign one to you.
            </p>
          </div>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-800 bg-slate-900/60 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Server</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {merged.map((account) => {
                const status = account.live?.status ?? account.status;
                const busy = busyIds.has(account.id);
                return (
                  <tr key={account.id}>
                    <td className="px-4 py-3 font-medium text-slate-100">{account.name}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={status} />
                    </td>
                    <td className="px-4 py-3 text-slate-500">
                      {account.serverHost}:{account.serverPort}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        <button
                          disabled={busy || status === "ONLINE" || status === "CONNECTING"}
                          onClick={() => void runAction(account.id, "start")}
                          className="btn-secondary px-2.5 py-1 text-xs"
                        >
                          Start
                        </button>
                        <button
                          disabled={busy || status === "OFFLINE"}
                          onClick={() => void runAction(account.id, "stop")}
                          className="btn-secondary px-2.5 py-1 text-xs"
                        >
                          Stop
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => void runAction(account.id, "restart")}
                          className="btn-secondary px-2.5 py-1 text-xs"
                        >
                          Restart
                        </button>
                        <Link
                          to={`/accounts/${account.id}`}
                          className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-500"
                        >
                          Console
                        </Link>
                        <button
                          disabled={busy}
                          onClick={() => void deleteAccount(account.id, account.name)}
                          className="btn-danger px-2.5 py-1 text-xs"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

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

function SummaryCard({ label, value, tone }: { label: string; value: number; tone: "emerald" | "slate" | "red" }) {
  const toneClasses = {
    emerald: "text-emerald-400",
    slate: "text-slate-300",
    red: "text-red-400",
  }[tone];
  return (
    <div className="card p-5">
      <p className="text-sm text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${toneClasses}`}>{value}</p>
    </div>
  );
}
