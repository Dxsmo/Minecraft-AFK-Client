import { useState } from "react";
import { api, ApiError } from "../lib/api";
import type { ManagedUser, MinecraftAccount } from "../lib/types";
import { MINECRAFT_VERSIONS, AUTO_DETECT_VERSION } from "../lib/minecraftVersions";

export function AccountSettingsPanel({
  account,
  users,
  isAdmin,
  onUpdated,
}: {
  account: MinecraftAccount;
  users: ManagedUser[];
  isAdmin: boolean;
  onUpdated: () => void;
}) {
  const [afkEnabled, setAfkEnabled] = useState(account.afkEnabled);
  const [movementEnabled, setMovementEnabled] = useState(account.movementEnabled);
  const [serverHost, setServerHost] = useState(account.serverHost);
  const [serverPort, setServerPort] = useState(account.serverPort);
  const [afkIntervalSeconds, setAfkIntervalSeconds] = useState(account.afkIntervalSeconds);
  const [autoReconnect, setAutoReconnect] = useState(account.autoReconnect);
  const [autoCommandEnabled, setAutoCommandEnabled] = useState(account.autoCommandEnabled);
  const [autoCommandText, setAutoCommandText] = useState(account.autoCommandText);
  const [autoCommandIntervalMinutes, setAutoCommandIntervalMinutes] = useState(account.autoCommandIntervalMinutes);
  const [assigned, setAssigned] = useState<Set<string>>(new Set(account.assignments.map((a) => a.userId)));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Minecraft version has its own instantly-applied control, separate from the
  // general "Save settings" button.
  const [version, setVersion] = useState(account.minecraftVersion);
  const [versionSaving, setVersionSaving] = useState(false);
  const [versionMessage, setVersionMessage] = useState<string | null>(null);

  async function saveSettings() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await api.patch(`/minecraft/accounts/${account.id}`, {
        afkEnabled,
        movementEnabled,
        afkIntervalSeconds,
        autoReconnect,
        serverHost,
        serverPort,
        autoCommandEnabled,
        autoCommandText,
        autoCommandIntervalMinutes,
      });
      if (isAdmin) {
        await api.put(`/minecraft/accounts/${account.id}/assignments`, { userIds: Array.from(assigned) });
      }
      setMessage("Settings saved");
      onUpdated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  async function applyVersion(newVersion: string) {
    setVersion(newVersion);
    setVersionSaving(true);
    setVersionMessage(null);
    setError(null);
    try {
      await api.patch(`/minecraft/accounts/${account.id}`, { minecraftVersion: newVersion });
      setVersionMessage(newVersion === AUTO_DETECT_VERSION ? "Set to auto-detect" : `Version set to ${newVersion}`);
      onUpdated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to change version");
    } finally {
      setVersionSaving(false);
    }
  }

  function toggleUser(userId: string) {
    setAssigned((prev) => {
      const next = new Set(prev);
      next.has(userId) ? next.delete(userId) : next.add(userId);
      return next;
    });
  }

  return (
    <div className="card p-4 text-sm">
      {account.createdBy && (
        <div className="mb-2 flex items-center gap-1.5 text-[11px]" style={{ color: "var(--text-muted)" }}>
          <span style={{ color: "var(--text-subtle)" }}>Erstellt von</span>
          <span
            className="rounded-full px-2 py-0.5 font-semibold"
            style={{ backgroundColor: "var(--accent-soft)", color: "var(--accent)" }}
          >
            {account.createdBy.username}
          </span>
        </div>
      )}
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-subtle)" }}>
        Settings
      </h3>

      <label className="flex items-center justify-between gap-2">
        <span className="shrink-0" style={{ color: "var(--text-muted)" }}>
          Minecraft version
        </span>
        <select
          value={version}
          disabled={versionSaving}
          onChange={(e) => void applyVersion(e.target.value)}
          className="input w-40"
        >
          <option value={AUTO_DETECT_VERSION}>Auto-detect</option>
          {!MINECRAFT_VERSIONS.includes(version) && version !== AUTO_DETECT_VERSION && (
            <option value={version}>{version}</option>
          )}
          {MINECRAFT_VERSIONS.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
      {versionMessage && <p className="mt-1 text-xs" style={{ color: "#34d399" }}>{versionMessage}</p>}

      <h4 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-subtle)" }}>
        Server
      </h4>
      <div className="space-y-2.5">
        <div>
          <label className="label">Host</label>
          <input
            value={serverHost}
            onChange={(e) => setServerHost(e.target.value)}
            placeholder="play.example.com"
            className="input"
          />
        </div>
        <label className="flex items-center justify-between">
          <span style={{ color: "var(--text-muted)" }}>Port</span>
          <input
            type="number"
            min={1}
            max={65535}
            value={serverPort}
            onChange={(e) => setServerPort(Number(e.target.value))}
            className="input w-24"
          />
        </label>
        <p className="text-xs" style={{ color: "var(--text-subtle)" }}>
          Restart the account to connect to the new server.
        </p>
      </div>

      <div className="mt-4 space-y-2.5">
        <Switch label="AFK behavior" checked={afkEnabled} onChange={setAfkEnabled} />
        <Switch label="Movement behavior" checked={movementEnabled} onChange={setMovementEnabled} />
        <Switch label="Auto-reconnect" checked={autoReconnect} onChange={setAutoReconnect} />
        <label className="flex items-center justify-between">
          <span style={{ color: "var(--text-muted)" }}>AFK interval (s)</span>
          <input
            type="number"
            min={5}
            max={3600}
            value={afkIntervalSeconds}
            onChange={(e) => setAfkIntervalSeconds(Number(e.target.value))}
            className="input w-20"
          />
        </label>
      </div>

      <h4 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-subtle)" }}>
        Auto-command
      </h4>
      <div className="space-y-2.5">
        <Switch label="Enabled" checked={autoCommandEnabled} onChange={setAutoCommandEnabled} />
        <div>
          <label className="label">Command / message</label>
          <input
            value={autoCommandText}
            onChange={(e) => setAutoCommandText(e.target.value)}
            placeholder="/hub or a chat message"
            className="input"
          />
        </div>
        <label className="flex items-center justify-between">
          <span style={{ color: "var(--text-muted)" }}>Every (minutes)</span>
          <input
            type="number"
            min={1}
            max={1440}
            value={autoCommandIntervalMinutes}
            onChange={(e) => setAutoCommandIntervalMinutes(Number(e.target.value))}
            className="input w-20"
          />
        </label>
      </div>

      {isAdmin && (
        <>
          <h4 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-subtle)" }}>
            Assigned users
          </h4>
          <div className="max-h-40 space-y-1.5 overflow-y-auto">
            {users.length === 0 && <p className="text-xs" style={{ color: "var(--text-subtle)" }}>No users created yet.</p>}
            {users.map((u) => (
              <label key={u.id} className="flex cursor-pointer items-center gap-2" style={{ color: "var(--text-muted)" }}>
                <input
                  type="checkbox"
                  checked={assigned.has(u.id)}
                  onChange={() => toggleUser(u.id)}
                  className="accent-emerald-500"
                />
                {u.username}
              </label>
            ))}
          </div>
        </>
      )}

      {error && <p className="alert-error mt-3">{error}</p>}
      {message && <p className="alert-success mt-3">{message}</p>}

      <button onClick={() => void saveSettings()} disabled={saving} className="btn btn-primary mt-4 w-full">
        {saving ? "Saving…" : "Save settings"}
      </button>
    </div>
  );
}

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between">
      <span style={{ color: "var(--text-muted)" }}>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-emerald-500" />
    </label>
  );
}
