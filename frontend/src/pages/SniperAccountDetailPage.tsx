import { useEffect, useRef, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { useSniperConsole } from "../lib/sockets";
import type { SniperAccount } from "../lib/types";
import { StatusBadge } from "../components/StatusBadge";
import { ConsoleView } from "../components/ConsoleView";

const MIN_COOLDOWN = 1;
const MAX_COOLDOWN = 60;

export function SniperAccountDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [account, setAccount] = useState<SniperAccount | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [desiredName, setDesiredName] = useState("");
  const [cooldown, setCooldown] = useState(5);
  const [rateLimitProtection, setRateLimitProtection] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const savedRef = useRef({ desiredName: "", cooldown: 5, rateLimitProtection: false });
  const { logs, status } = useSniperConsole(id);

  async function load() {
    if (!id) return;
    try {
      const a = await api.get<SniperAccount>(`/namesniper/accounts/${id}`);
      setAccount(a);
      setDesiredName(a.desiredName);
      setCooldown(a.cooldownSeconds);
      setRateLimitProtection(a.rateLimitProtection);
      savedRef.current = { desiredName: a.desiredName, cooldown: a.cooldownSeconds, rateLimitProtection: a.rateLimitProtection };
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load account");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Debounced autosave for the desired name + cooldown + rate-limit
  // protection, mirroring the dashboard's inline notes field.
  useEffect(() => {
    if (!id) return;
    if (
      desiredName === savedRef.current.desiredName &&
      cooldown === savedRef.current.cooldown &&
      rateLimitProtection === savedRef.current.rateLimitProtection
    )
      return;
    // Mirror the backend's Mojang username rule so we don't fire off requests
    // that are guaranteed to 400 while the user is still mid-typing a short name.
    if (desiredName !== "" && desiredName.length < 3) return;
    const t = setTimeout(async () => {
      try {
        await api.patch(`/namesniper/accounts/${id}`, { desiredName, cooldownSeconds: cooldown, rateLimitProtection });
        savedRef.current = { desiredName, cooldown, rateLimitProtection };
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
        void load();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Failed to save");
      }
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desiredName, cooldown, rateLimitProtection, id]);

  async function toggleEnabled(next: boolean) {
    if (!id) return;
    setBusy(true);
    try {
      await api.post(`/namesniper/accounts/${id}/${next ? "start" : "stop"}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Failed to ${next ? "start" : "stop"}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!id || !account) return;
    const label = account.label?.trim() || account.email;
    if (!confirm(`Delete Name Sniper account "${label}"? This cannot be undone.`)) return;
    try {
      await api.delete(`/namesniper/accounts/${id}`);
      navigate("/namesniper", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to delete account");
    }
  }

  if (!account) {
    return <p className="text-sm" style={{ color: "var(--text-subtle)" }}>{error ?? "Loading…"}</p>;
  }

  const liveStatus = status?.status ?? account.status;
  const label = account.label?.trim() || account.email;
  const msaSignIn = status?.msaSignIn;
  const isRunning = liveStatus === "ONLINE" || liveStatus === "CONNECTING";
  const canStart = desiredName.trim().length >= 3;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/namesniper" className="text-xs font-medium transition-colors" style={{ color: "var(--text-subtle)" }}>
            ← Back to Name Sniper
          </Link>
          <div className="mt-1.5 flex items-center gap-3">
            <h1 className="text-xl font-semibold" style={{ color: "var(--text)" }}>
              {label}
            </h1>
            <StatusBadge status={liveStatus} />
          </div>
          <p className="mt-0.5 text-sm" style={{ color: "var(--text-muted)" }}>
            {account.email}
            {account.currentName ? ` · aktuell: ${account.currentName}` : ""}
          </p>
        </div>
        <div className="flex gap-1.5">
          <button onClick={() => void handleDelete()} className="btn btn-danger btn-sm">
            Delete
          </button>
        </div>
      </div>

      {error && <p className="alert-error">{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <StatPill label="Cooldown" value={`${account.cooldownSeconds}s`} />
        {account.lastAttemptAt && (
          <StatPill label="Last attempt" value={new Date(account.lastAttemptAt).toLocaleTimeString([], { hour12: false })} />
        )}
        {account.lastResult && (
          <StatPill label="Last result" value={account.lastResult} danger={!account.lastSuccess} accent={account.lastSuccess} />
        )}
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
            and enter the code below to authorize this account.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code
              className="rounded-lg px-3 py-1.5 text-xl font-bold tracking-widest"
              style={{ backgroundColor: "rgba(0,0,0,0.35)", color: "#fde68a" }}
            >
              {msaSignIn.userCode}
            </code>
            <button onClick={() => void navigator.clipboard?.writeText(msaSignIn.userCode)} className="btn btn-ghost btn-sm">
              Copy
            </button>
          </div>
        </div>
      )}

      <div className="card p-5 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold" style={{ color: "var(--text)" }}>
              Name Sniper konfigurieren
            </h2>
            <p className="mt-0.5 text-xs" style={{ color: "var(--text-subtle)" }}>
              Solange aktiviert, wird im konfigurierten Intervall versucht, den Namen zu übernehmen.
            </p>
          </div>
          {saved && (
            <span className="text-[11px]" style={{ color: "var(--accent)" }}>
              gespeichert
            </span>
          )}
        </div>

        <div>
          <label className="label">Wunschname</label>
          <input
            value={desiredName}
            onChange={(e) => setDesiredName(e.target.value.replace(/[^A-Za-z0-9_]/g, ""))}
            className="input"
            placeholder="Desmodus"
            minLength={3}
            maxLength={16}
          />
          <p className="mt-1 text-xs" style={{ color: "var(--text-subtle)" }}>
            3-16 Zeichen, nur Buchstaben, Zahlen und Unterstriche.
          </p>
        </div>

        <div>
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
              Cooldown zwischen Versuchen
            </span>
            <span className="text-sm font-semibold tabular-nums" style={{ color: "var(--text)" }}>
              {cooldown}s
            </span>
          </div>
          <input
            type="range"
            min={MIN_COOLDOWN}
            max={MAX_COOLDOWN}
            value={cooldown}
            onChange={(e) => setCooldown(Number(e.target.value))}
            className="slider mt-2"
          />
          <div className="mt-1 flex justify-between text-[11px]" style={{ color: "var(--text-subtle)" }}>
            <span>1s</span>
            <span>60s</span>
          </div>
        </div>

        <div className="flex items-center justify-between rounded-lg p-3.5" style={{ border: "1px solid var(--border)", backgroundColor: "var(--bg-elev)" }}>
          <div>
            <p className="text-sm font-medium" style={{ color: "var(--text)" }}>
              Rate-Limit-Schutz
            </p>
            <p className="mt-0.5 text-xs" style={{ color: "var(--text-subtle)" }}>
              Erkennt HTTP 429 (zu viele Anfragen) und wartet automatisch länger statt weiter zu hämmern.
            </p>
          </div>
          <label className="flex cursor-pointer items-center">
            <input
              type="checkbox"
              checked={rateLimitProtection}
              onChange={(e) => setRateLimitProtection(e.target.checked)}
              className="accent-blue-500"
              style={{ width: 20, height: 20 }}
            />
          </label>
        </div>

        <div className="flex items-center justify-between rounded-lg p-3.5" style={{ border: "1px solid var(--border)", backgroundColor: "var(--bg-elev)" }}>
          <div>
            <p className="text-sm font-medium" style={{ color: "var(--text)" }}>
              Name Sniper aktiv
            </p>
            <p className="mt-0.5 text-xs" style={{ color: "var(--text-subtle)" }}>
              {canStart ? "Startet die Anmeldung und den Versuchs-Loop." : "Erst einen Wunschnamen (min. 3 Zeichen) eingeben."}
            </p>
          </div>
          <label className="flex cursor-pointer items-center">
            <input
              type="checkbox"
              checked={isRunning || account.enabled}
              disabled={busy || (!canStart && !isRunning && !account.enabled)}
              onChange={(e) => void toggleEnabled(e.target.checked)}
              className="accent-blue-500"
              style={{ width: 20, height: 20 }}
            />
          </label>
        </div>
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-semibold" style={{ color: "var(--text)" }}>
          Konsole
        </h2>
        <ConsoleView logs={logs} className="h-[420px]" />
      </div>
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
