import { useState } from "react";
import { api, ApiError } from "../lib/api";
import type { ManagedUser, MinecraftAccount } from "../lib/types";
import { MINECRAFT_VERSIONS } from "../lib/minecraftVersions";

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
  const [afkIntervalSeconds, setAfkIntervalSeconds] = useState(account.afkIntervalSeconds);
  const [autoReconnect, setAutoReconnect] = useState(account.autoReconnect);
  const [autoCommandEnabled, setAutoCommandEnabled] = useState(account.autoCommandEnabled);
  const [autoCommandText, setAutoCommandText] = useState(account.autoCommandText);
  const [autoCommandIntervalMinutes, setAutoCommandIntervalMinutes] = useState(account.autoCommandIntervalMinutes);
  const [assigned, setAssigned] = useState<Set<string>>(new Set(account.assignments.map((a) => a.userId)));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Minecraft version has its own instantly-applied control (see below),
  // separate from the general "Save settings" button.
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
        autoCommandEnabled,
        autoCommandText,
        autoCommandIntervalMinutes,
      });
      // Only admins are allowed to grant/revoke access for other users.
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
      setVersionMessage(`Version set to ${newVersion}`);
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
      <h3 className="mb-3 font-semibold text-slate-100">Settings</h3>

      <label className="flex items-center justify-between gap-2">
        <span className="shrink-0 text-slate-400">Minecraft version</span>
        <select
          value={version}
          disabled={versionSaving}
          onChange={(e) => void applyVersion(e.target.value)}
          className="input w-32"
        >
          {!MINECRAFT_VERSIONS.includes(version) && <option value={version}>{version}</option>}
          {MINECRAFT_VERSIONS.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
      {versionMessage && <p className="mt-1 text-xs text-emerald-400">{versionMessage}</p>}
      <p className="mt-1 text-xs text-slate-500">Applies immediately and restarts the client if it's online.</p>

      <div className="mt-4 rounded-md border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-400">
        <span className="font-medium text-slate-300">Auth type: {account.authType}</span>
        {account.authType === "MICROSOFT" && (
          <p className="mt-1">
            Microsoft email/password are set once at creation and cannot be changed. Delete this account and
            create a new one to use different credentials.
          </p>
        )}
      </div>

      <div className="mt-4 space-y-2">
        <label className="flex items-center justify-between">
          <span className="text-slate-400">AFK behavior</span>
          <input type="checkbox" checked={afkEnabled} onChange={(e) => setAfkEnabled(e.target.checked)} />
        </label>
        <label className="flex items-center justify-between">
          <span className="text-slate-400">Movement behavior</span>
          <input type="checkbox" checked={movementEnabled} onChange={(e) => setMovementEnabled(e.target.checked)} />
        </label>
        <label className="flex items-center justify-between">
          <span className="text-slate-400">Auto-reconnect</span>
          <input type="checkbox" checked={autoReconnect} onChange={(e) => setAutoReconnect(e.target.checked)} />
        </label>
        <label className="flex items-center justify-between">
          <span className="text-slate-400">AFK interval (s)</span>
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

      <h4 className="mb-2 mt-4 text-xs font-semibold uppercase text-slate-500">Auto-command</h4>
      <div className="space-y-2">
        <label className="flex items-center justify-between">
          <span className="text-slate-400">Enabled</span>
          <input
            type="checkbox"
            checked={autoCommandEnabled}
            onChange={(e) => setAutoCommandEnabled(e.target.checked)}
          />
        </label>
        <label className="flex items-center justify-between gap-2">
          <span className="shrink-0 text-slate-400">Command / message</span>
          <input
            value={autoCommandText}
            onChange={(e) => setAutoCommandText(e.target.value)}
            placeholder="/hub or a chat message"
            className="input"
          />
        </label>
        <label className="flex items-center justify-between">
          <span className="text-slate-400">Every (minutes)</span>
          <input
            type="number"
            min={1}
            max={1440}
            value={autoCommandIntervalMinutes}
            onChange={(e) => setAutoCommandIntervalMinutes(Number(e.target.value))}
            className="input w-20"
          />
        </label>
        <p className="text-xs text-slate-500">
          Sent automatically to chat at this interval whenever the client is online, independent of the AFK
          behavior above.
        </p>
      </div>

      {isAdmin && (
        <>
          <h4 className="mb-2 mt-4 text-xs font-semibold uppercase text-slate-500">Assigned users</h4>
          <div className="max-h-40 space-y-1 overflow-y-auto">
            {users.length === 0 && <p className="text-xs text-slate-500">No users created yet.</p>}
            {users.map((u) => (
              <label key={u.id} className="flex items-center gap-2 text-slate-300">
                <input type="checkbox" checked={assigned.has(u.id)} onChange={() => toggleUser(u.id)} />
                {u.username}
              </label>
            ))}
          </div>
        </>
      )}

      {error && <p className="mt-3 rounded-md bg-red-950 px-2 py-1.5 text-xs text-red-400">{error}</p>}
      {message && <p className="mt-3 rounded-md bg-emerald-950 px-2 py-1.5 text-xs text-emerald-400">{message}</p>}

      <button onClick={() => void saveSettings()} disabled={saving} className="btn-primary mt-4 w-full">
        {saving ? "Saving..." : "Save settings"}
      </button>
    </div>
  );
}
