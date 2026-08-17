import { useState } from "react";
import { api, ApiError } from "../lib/api";
import type { ManagedUser, MinecraftAccount } from "../lib/types";

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
  const [authType, setAuthType] = useState(account.authType);
  const [credentialsSecret, setCredentialsSecret] = useState("");
  const [autoCommandEnabled, setAutoCommandEnabled] = useState(account.autoCommandEnabled);
  const [autoCommandText, setAutoCommandText] = useState(account.autoCommandText);
  const [autoCommandIntervalMinutes, setAutoCommandIntervalMinutes] = useState(account.autoCommandIntervalMinutes);
  const [assigned, setAssigned] = useState<Set<string>>(new Set(account.assignments.map((a) => a.userId)));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function saveSettings() {
    setSaving(true);
    setError(null);
    setMessage(null);

    if (authType === "MICROSOFT" && account.authType !== "MICROSOFT" && !credentialsSecret) {
      setError("Enter the Microsoft account email before switching to Microsoft auth.");
      setSaving(false);
      return;
    }

    try {
      await api.patch(`/minecraft/accounts/${account.id}`, {
        afkEnabled,
        movementEnabled,
        afkIntervalSeconds,
        autoReconnect,
        authType,
        autoCommandEnabled,
        autoCommandText,
        autoCommandIntervalMinutes,
        // Only sent when someone actually typed something, so leaving it
        // blank does not wipe out an already-configured Microsoft account.
        ...(authType === "MICROSOFT" && credentialsSecret ? { credentialsSecret } : {}),
      });
      // Only admins are allowed to grant/revoke access for other users.
      if (isAdmin) {
        await api.put(`/minecraft/accounts/${account.id}/assignments`, { userIds: Array.from(assigned) });
      }
      setMessage("Settings saved");
      setCredentialsSecret("");
      onUpdated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
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

      <div className="space-y-2">
        <label className="flex items-center justify-between">
          <span className="text-slate-400">Auth type</span>
          <select
            value={authType}
            onChange={(e) => setAuthType(e.target.value as "OFFLINE" | "MICROSOFT")}
            className="input w-32"
          >
            <option value="OFFLINE">Offline</option>
            <option value="MICROSOFT">Microsoft</option>
          </select>
        </label>
        {authType === "MICROSOFT" && (
          <>
            <label className="flex items-center justify-between gap-2">
              <span className="shrink-0 text-slate-400">Microsoft email</span>
              <input
                type="email"
                value={credentialsSecret}
                onChange={(e) => setCredentialsSecret(e.target.value)}
                placeholder={account.authType === "MICROSOFT" ? "(unchanged)" : "bot@example.com"}
                className="input"
              />
            </label>
            <p className="text-xs text-slate-500">
              After saving, start this account — a Microsoft sign-in link + code will appear directly above
              the console once required.
            </p>
          </>
        )}
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
