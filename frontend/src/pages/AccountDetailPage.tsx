import { useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useAccountConsole } from "../lib/sockets";
import type { ManagedUser, MinecraftAccount } from "../lib/types";
import { StatusBadge } from "../components/StatusBadge";
import { ConsoleView } from "../components/ConsoleView";
import { AccountSettingsPanel } from "../components/AccountSettingsPanel";

export function AccountDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const [account, setAccount] = useState<MinecraftAccount | null>(null);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [command, setCommand] = useState("");
  const { logs, status, sendCommand } = useAccountConsole(id);
  const inputRef = useRef<HTMLInputElement>(null);

  async function load() {
    if (!id) return;
    try {
      const data = await api.get<MinecraftAccount>(`/minecraft/accounts/${id}`);
      setAccount(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load account");
    }
  }

  useEffect(() => {
    void load();
    if (user?.role === "ADMIN") {
      void api.get<ManagedUser[]>("/users").then(setUsers).catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function runAction(action: "start" | "stop" | "restart") {
    if (!id) return;
    try {
      await api.post(`/minecraft/accounts/${id}/${action}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Failed to ${action}`);
    }
  }

  function handleSendCommand(e: React.FormEvent) {
    e.preventDefault();
    if (!command.trim()) return;
    sendCommand(command.trim());
    setCommand("");
    inputRef.current?.focus();
  }

  if (!account) {
    return <p className="text-sm text-slate-500">{error ?? "Loading..."}</p>;
  }

  const liveStatus = status?.status ?? account.status;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link to="/dashboard" className="text-xs font-medium text-slate-500 hover:text-slate-700">
            &larr; Back to dashboard
          </Link>
          <div className="mt-1 flex items-center gap-3">
            <h1 className="text-xl font-semibold text-slate-900">{account.name}</h1>
            <StatusBadge status={liveStatus} />
          </div>
          <p className="text-sm text-slate-500">
            {account.serverHost}:{account.serverPort} &middot; {account.minecraftVersion}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => void runAction("start")} className="btn-secondary">
            Start
          </button>
          <button onClick={() => void runAction("stop")} className="btn-secondary">
            Stop
          </button>
          <button onClick={() => void runAction("restart")} className="btn-secondary">
            Restart
          </button>
        </div>
      </div>

      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-3">
          <h2 className="text-sm font-semibold text-slate-900">Live Console</h2>
          <ConsoleView logs={logs} />
          <form onSubmit={handleSendCommand} className="flex gap-2">
            <input
              ref={inputRef}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="/gamemode creative"
              className="input font-mono"
            />
            <button type="submit" className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:opacity-90">
              Send
            </button>
          </form>
        </div>

        <div className="space-y-4">
          {status && (
            <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
              <h3 className="mb-2 font-semibold text-slate-900">Live info</h3>
              <dl className="space-y-1 text-slate-600">
                {status.health !== undefined && <Row label="Health" value={`${status.health}/20`} />}
                {status.food !== undefined && <Row label="Food" value={`${status.food}/20`} />}
                {status.position && (
                  <Row
                    label="Position"
                    value={`${status.position.x.toFixed(1)}, ${status.position.y.toFixed(1)}, ${status.position.z.toFixed(1)}`}
                  />
                )}
                <Row label="Reconnect attempts" value={String(status.reconnectAttempt)} />
                {status.lastError && <Row label="Last error" value={status.lastError} />}
              </dl>
            </div>
          )}

          {user?.role === "ADMIN" && (
            <AccountSettingsPanel account={account} users={users} onUpdated={load} />
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right font-medium text-slate-900">{value}</dd>
    </div>
  );
}
