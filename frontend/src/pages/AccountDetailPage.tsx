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
      setAccount(await api.get<MinecraftAccount>(`/minecraft/accounts/${id}`));
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
    return <p className="text-sm" style={{ color: "var(--text-subtle)" }}>{error ?? "Loading…"}</p>;
  }

  const liveStatus = status?.status ?? account.status;
  const displayName = status?.name ?? account.name;
  const msaSignIn = status?.msaSignIn;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            to="/dashboard"
            className="text-xs font-medium transition-colors"
            style={{ color: "var(--text-subtle)" }}
          >
            ← Back to dashboard
          </Link>
          <div className="mt-1.5 flex items-center gap-3">
            <h1 className="text-xl font-semibold" style={{ color: "var(--text)" }}>
              {displayName}
            </h1>
            <StatusBadge status={liveStatus} />
          </div>
          <p className="mt-0.5 text-sm" style={{ color: "var(--text-muted)" }}>
            {account.serverHost}:{account.serverPort} · {account.minecraftVersion || "auto-detect"}
          </p>
        </div>
        <div className="flex gap-1.5">
          <button onClick={() => void runAction("start")} className="btn btn-secondary btn-sm">
            Start
          </button>
          <button onClick={() => void runAction("stop")} className="btn btn-secondary btn-sm">
            Stop
          </button>
          <button onClick={() => void runAction("restart")} className="btn btn-ghost btn-sm">
            Restart
          </button>
          <button onClick={() => void handleDelete()} className="btn btn-danger btn-sm">
            Delete
          </button>
        </div>
      </div>

      {error && <p className="alert-error">{error}</p>}

      {msaSignIn && (
        <div
          className="rounded-xl p-4"
          style={{ border: "1px solid rgba(251,191,36,0.3)", backgroundColor: "rgba(251,191,36,0.07)" }}
        >
          <p className="text-sm font-semibold" style={{ color: "#fcd34d" }}>
            Microsoft sign-in required
          </p>
          <p className="mt-1 text-sm" style={{ color: "rgba(253,230,138,0.9)" }}>
            Open{" "}
            <a
              href={msaSignIn.verificationUri}
              target="_blank"
              rel="noreferrer"
              className="font-medium underline"
              style={{ color: "#fcd34d" }}
            >
              {msaSignIn.verificationUri}
            </a>{" "}
            and enter the code below to authorize this bot.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code
              className="rounded-lg px-3 py-1.5 text-xl font-bold tracking-widest"
              style={{ backgroundColor: "rgba(0,0,0,0.35)", color: "#fde68a" }}
            >
              {msaSignIn.userCode}
            </code>
            <button
              onClick={() => void navigator.clipboard?.writeText(msaSignIn.userCode)}
              className="btn btn-ghost btn-sm"
            >
              Copy
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          <h2 className="text-sm font-semibold" style={{ color: "var(--text)" }}>
            Live console
          </h2>
          <ConsoleView logs={logs} />
          <form onSubmit={handleSendCommand} className="flex gap-2">
            <input
              ref={inputRef}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="/gamemode creative"
              className="input font-mono"
              disabled={liveStatus !== "ONLINE"}
            />
            <button type="submit" className="btn btn-primary" disabled={liveStatus !== "ONLINE"}>
              Send
            </button>
          </form>
        </div>

        <div className="space-y-4">
          {status && (
            <div className="card p-4 text-sm">
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-subtle)" }}>
                Live info
              </h3>
              <dl className="space-y-2">
                {status.health !== undefined && <Row label="Health" value={`${status.health}/20`} />}
                {status.food !== undefined && <Row label="Food" value={`${status.food}/20`} />}
                {status.position && (
                  <Row
                    label="Position"
                    value={`${status.position.x.toFixed(0)}, ${status.position.y.toFixed(0)}, ${status.position.z.toFixed(0)}`}
                  />
                )}
                <Row label="Reconnects" value={String(status.reconnectAttempt)} />
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
      <dt style={{ color: "var(--text-subtle)" }}>{label}</dt>
      <dd className="text-right font-medium" style={{ color: "var(--text)" }}>
        {value}
      </dd>
    </div>
  );
}
