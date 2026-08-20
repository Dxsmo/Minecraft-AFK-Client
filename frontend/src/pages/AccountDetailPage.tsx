import { useEffect, useRef, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useAccountConsole } from "../lib/sockets";
import type { ManagedUser, MinecraftAccount } from "../lib/types";
import { StatusBadge } from "../components/StatusBadge";
import { ConsoleView } from "../components/ConsoleView";
import { AccountSettingsPanel } from "../components/AccountSettingsPanel";
import { InventoryPanel } from "../components/InventoryPanel";

export function AccountDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [account, setAccount] = useState<MinecraftAccount | null>(null);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [command, setCommand] = useState("");
  const [tab, setTab] = useState<"console" | "inventory" | "settings">("console");
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

  async function handleCleanSpawner() {
    if (!id) return;
    try {
      await api.post(`/minecraft/accounts/${id}/clean-spawner`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to start clean spawner");
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
  const displayName = account.displayName?.trim() || status?.name || account.name;
  const msaSignIn = status?.msaSignIn;
  const balance = status?.balance ?? account.lastBalance ?? undefined;

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
            {account.edition === "BEDROCK" && (
              <span
                className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                style={{ backgroundColor: "rgba(245,158,11,0.15)", color: "var(--warning)" }}
              >
                Bedrock
              </span>
            )}
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
          <button
            onClick={() => void handleCleanSpawner()}
            className="btn btn-ghost btn-sm"
            disabled={liveStatus !== "ONLINE"}
            title="Right-click a nearby spawner and drop its items"
          >
            Clean spawner
          </button>
          <button onClick={() => void handleDelete()} className="btn btn-danger btn-sm">
            Delete
          </button>
        </div>
      </div>

      {error && <p className="alert-error">{error}</p>}

      {/* Live telemetry strip — always visible across tabs. */}
      <div className="flex flex-wrap items-center gap-2">
        {balance !== null && balance !== undefined && (
          <StatPill label="Balance" value={`$${balance.toLocaleString("en-US")}`} accent />
        )}
        {status?.health !== undefined && <StatPill label="Health" value={`${status.health}/20`} />}
        {status?.food !== undefined && <StatPill label="Food" value={`${status.food}/20`} />}
        {status?.position && (
          <StatPill
            label="Position"
            value={`${status.position.x.toFixed(0)}, ${status.position.y.toFixed(0)}, ${status.position.z.toFixed(0)}`}
          />
        )}
        <StatPill label="Reconnects" value={String(status?.reconnectAttempt ?? 0)} />
        {status?.lastError && <StatPill label="Last error" value={status.lastError} danger />}
      </div>

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

      {/* Tab bar */}
      <div className="tab-bar">
        <button className="tab-btn" data-active={tab === "console"} onClick={() => setTab("console")}>
          <TabIcon name="console" />
          Console
        </button>
        <button className="tab-btn" data-active={tab === "inventory"} onClick={() => setTab("inventory")}>
          <TabIcon name="inventory" />
          Inventory
        </button>
        <button className="tab-btn" data-active={tab === "settings"} onClick={() => setTab("settings")}>
          <TabIcon name="settings" />
          Einstellungen
        </button>
      </div>

      {/* Tab content — keyed so it re-mounts and animates on switch. */}
      {tab === "console" && (
        <div key="console" className="tab-panel space-y-3">
          <ConsoleView logs={logs} className="h-[560px]" />
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
          {account.autoSellEnabled && id && <EarningsBox accountId={id} />}
        </div>
      )}

      {tab === "inventory" && (
        <div key="inventory" className="tab-panel">
          <div className="card flex justify-center p-6">
            <InventoryPanel accountId={account.id} online={liveStatus === "ONLINE"} />
          </div>
        </div>
      )}

      {tab === "settings" && (
        <div key="settings" className="tab-panel">
          <AccountSettingsPanel account={account} users={users} isAdmin={isAdmin} onUpdated={load} />
        </div>
      )}
    </div>
  );
}

function StatPill({
  label,
  value,
  accent,
  danger,
}: {
  label: string;
  value: string;
  accent?: boolean;
  danger?: boolean;
}) {
  const valueColor = danger ? "var(--danger)" : accent ? "var(--accent)" : "var(--text)";
  return (
    <span className="stat-pill">
      <span className="text-[11px] uppercase tracking-wide" style={{ color: "var(--text-subtle)" }}>
        {label}
      </span>
      <span className="font-semibold tabular-nums" style={{ color: valueColor }}>
        {value}
      </span>
    </span>
  );
}

function TabIcon({ name }: { name: "console" | "inventory" | "settings" }) {
  const common = {
    width: 15,
    height: 15,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (name === "console") {
    return (
      <svg {...common}>
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </svg>
    );
  }
  if (name === "inventory") {
    return (
      <svg {...common}>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

interface Earnings {
  last5m: number;
  last1h: number;
  last24h: number;
}

/** Rolling auto-sell earnings box, polled every 15s. Shown under the console. */
function EarningsBox({ accountId }: { accountId: string }) {
  const [earnings, setEarnings] = useState<Earnings | null>(null);

  useEffect(() => {
    let active = true;
    async function poll() {
      try {
        const data = await api.get<Earnings>(`/minecraft/accounts/${accountId}/earnings`);
        if (active) setEarnings(data);
      } catch {
        /* transient; retry on next tick */
      }
    }
    void poll();
    const t = setInterval(poll, 15_000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [accountId]);

  const fmt = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

  return (
    <div className="card p-3.5 text-sm">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-subtle)" }}>
        Auto-sell earnings
      </h3>
      <div className="grid grid-cols-3 gap-2 text-center">
        <EarningStat label="5 min" value={earnings ? fmt(earnings.last5m) : "—"} />
        <EarningStat label="1 h" value={earnings ? fmt(earnings.last1h) : "—"} />
        <EarningStat label="24 h" value={earnings ? fmt(earnings.last24h) : "—"} />
      </div>
    </div>
  );
}

function EarningStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px]" style={{ color: "var(--text-subtle)" }}>
        {label}
      </p>
      <p className="mt-0.5 font-semibold tabular-nums" style={{ color: "var(--accent)" }}>
        {value}
      </p>
    </div>
  );
}
