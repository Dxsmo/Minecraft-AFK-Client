import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useDashboardSocket } from "../lib/sockets";
import type { MinecraftAccount } from "../lib/types";
import { StatusBadge } from "../components/StatusBadge";
import { CreateAccountDialog } from "../components/CreateAccountDialog";

export function DashboardPage() {
  const { user } = useAuth();
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Dashboard</h1>
          <p className="text-sm text-slate-500">Overview of all Minecraft AFK clients</p>
        </div>
        {user?.role === "ADMIN" && (
          <button
            onClick={() => setDialogOpen(true)}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            + New account
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SummaryCard label="Online Clients" value={counts.online} tone="emerald" />
        <SummaryCard label="Offline Clients" value={counts.offline} tone="slate" />
        <SummaryCard label="Errors" value={counts.error} tone="red" />
      </div>

      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        {accounts === null ? (
          <div className="p-8 text-center text-sm text-slate-500">Loading accounts...</div>
        ) : merged.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-sm font-medium text-slate-900">No Minecraft accounts yet</p>
            <p className="mt-1 text-sm text-slate-500">
              {user?.role === "ADMIN"
                ? "Create your first account to get started."
                : "Ask an admin to assign a Minecraft account to your user."}
            </p>
          </div>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Server</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {merged.map((account) => {
                const status = account.live?.status ?? account.status;
                const busy = busyIds.has(account.id);
                return (
                  <tr key={account.id}>
                    <td className="px-4 py-3 font-medium text-slate-900">{account.name}</td>
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
                          className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                        >
                          Start
                        </button>
                        <button
                          disabled={busy || status === "OFFLINE"}
                          onClick={() => void runAction(account.id, "stop")}
                          className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                        >
                          Stop
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => void runAction(account.id, "restart")}
                          className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                        >
                          Restart
                        </button>
                        <Link
                          to={`/accounts/${account.id}`}
                          className="rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white hover:opacity-90"
                        >
                          Console
                        </Link>
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
    emerald: "text-emerald-600",
    slate: "text-slate-600",
    red: "text-red-600",
  }[tone];
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <p className="text-sm text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${toneClasses}`}>{value}</p>
    </div>
  );
}
