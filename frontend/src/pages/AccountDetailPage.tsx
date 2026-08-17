import { useEffect, useRef, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
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
  const navigate = useNavigate();
  const [account, setAccount] = useState<MinecraftAccount | null>(null);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [command, setCommand] = useState("");
  const { logs, status, sendCommand } = useAccountConsole(id);
  const inputRef = useRef<HTMLInputElement>(null);
  const isAdmin = user?.role === "ADMIN";

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
    if (isAdmin) {
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

  async function handleDelete() {
    if (!id || !account) return;
    if (!confirm(`Delete Minecraft account "${account.name}"? This cannot be undone.`)) return;
    try {
      await api.delete(`/minecraft/accounts/${id}`);
      navigate("/dashboard", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to delete account");
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
  const msaSignIn = status?.msaSignIn;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link to="/dashboard" className="text-xs font-medium text-slate-500 hover:text-slate-300">
            &larr; Back to dashboard
          </Link>
          <div className="mt-1 flex items-center gap-3">
            <h1 className="text-xl font-semibold text-slate-100">{account.name}</h1>
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
          <button onClick={() => void handleDelete()} className="btn-danger">
            Delete
          </button>
        </div>
      </div>

      {error && <p className="rounded-md bg-red-950 px-3 py-2 text-sm text-red-400">{error}</p>}

      {msaSignIn && (
        <div className="rounded-xl border border-amber-800 bg-amber-950/40 p-4 text-sm">
          <p className="font-semibold text-amber-300">Microsoft sign-in required</p>
          <p className="mt-1 text-amber-200/90">
            Open{" "}
            <a
              href={msaSignIn.verificationUri}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-amber-300 underline"
            >
              {msaSignIn.verificationUri}
            </a>{" "}
            and enter the code below to authorize this bot account.
          </p>
          <p className="mt-2 text-2xl font-bold tracking-widest text-amber-200">{msaSignIn.userCode}</p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-3">
          <h2 className="text-sm font-semibold text-slate-100">Live Console</h2>
          <ConsoleView logs={logs} />
          <form onSubmit={handleSendCommand} className="flex gap-2">
            <input
              ref={inputRef}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="/gamemode creative"
              className="input font-mono"
            />
            <button type="submit" className="btn-primary">
              Send
            </button>
          </form>
        </div>

        <div className="space-y-4">
          {status && (
            <div className="card p-4 text-sm">
              <h3 className="mb-2 font-semibold text-slate-100">Live info</h3>
              <dl className="space-y-1 text-slate-400">
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

          <AccountSettingsPanel account={account} users={users} isAdmin={isAdmin} onUpdated={load} />
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right font-medium text-slate-100">{value}</dd>
    </div>
  );
}
