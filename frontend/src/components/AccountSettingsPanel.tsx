import { useState } from "react";
import { api, ApiError } from "../lib/api";
import type { ManagedUser, MinecraftAccount } from "../lib/types";

export function AccountSettingsPanel({
  account,
  users,
  onUpdated,
}: {
  account: MinecraftAccount;
  users: ManagedUser[];
  onUpdated: () => void;
}) {
  const [afkEnabled, setAfkEnabled] = useState(account.afkEnabled);
  const [movementEnabled, setMovementEnabled] = useState(account.movementEnabled);
  const [afkIntervalSeconds, setAfkIntervalSeconds] = useState(account.afkIntervalSeconds);
  const [autoReconnect, setAutoReconnect] = useState(account.autoReconnect);
  const [assigned, setAssigned] = useState<Set<string>>(new Set(account.assignments.map((a) => a.userId)));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      });
      await api.put(`/minecraft/accounts/${account.id}/assignments`, { userIds: Array.from(assigned) });
      setMessage("Settings saved");
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
    <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
      <h3 className="mb-3 font-semibold text-slate-900">Settings</h3>

      <div className="space-y-2">
        <label className="flex items-center justify-between">
          <span className="text-slate-600">AFK behavior</span>
          <input type="checkbox" checked={afkEnabled} onChange={(e) => setAfkEnabled(e.target.checked)} />
        </label>
        <label className="flex items-center justify-between">
          <span className="text-slate-600">Movement behavior</span>
          <input type="checkbox" checked={movementEnabled} onChange={(e) => setMovementEnabled(e.target.checked)} />
        </label>
        <label className="flex items-center justify-between">
          <span className="text-slate-600">Auto-reconnect</span>
          <input type="checkbox" checked={autoReconnect} onChange={(e) => setAutoReconnect(e.target.checked)} />
        </label>
        <label className="flex items-center justify-between">
          <span className="text-slate-600">AFK interval (s)</span>
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

      <h4 className="mb-2 mt-4 text-xs font-semibold uppercase text-slate-500">Assigned users</h4>
      <div className="max-h-40 space-y-1 overflow-y-auto">
        {users.length === 0 && <p className="text-xs text-slate-400">No users created yet.</p>}
        {users.map((u) => (
          <label key={u.id} className="flex items-center gap-2 text-slate-700">
            <input type="checkbox" checked={assigned.has(u.id)} onChange={() => toggleUser(u.id)} />
            {u.username}
          </label>
        ))}
      </div>

      {error && <p className="mt-3 rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-700">{error}</p>}
      {message && <p className="mt-3 rounded-md bg-emerald-50 px-2 py-1.5 text-xs text-emerald-700">{message}</p>}

      <button
        onClick={() => void saveSettings()}
        disabled={saving}
        className="mt-4 w-full rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        {saving ? "Saving..." : "Save settings"}
      </button>
    </div>
  );
}
