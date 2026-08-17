import { useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";

export function CreateAccountDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({
    name: "",
    serverHost: "",
    serverPort: 25565,
    minecraftVersion: "1.20.4",
    authType: "OFFLINE" as "OFFLINE" | "MICROSOFT",
    afkEnabled: true,
    movementEnabled: false,
    afkIntervalSeconds: 30,
    autoReconnect: true,
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.post("/minecraft/accounts", form);
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create account");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-lg">
        <h2 className="text-base font-semibold text-slate-900">New Minecraft account</h2>
        <form onSubmit={handleSubmit} className="mt-4 space-y-3">
          <Field label="Bot name">
            <input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="input"
              placeholder="Bot_01"
            />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Field label="Server host">
                <input
                  required
                  value={form.serverHost}
                  onChange={(e) => setForm({ ...form, serverHost: e.target.value })}
                  className="input"
                  placeholder="play.example.com"
                />
              </Field>
            </div>
            <Field label="Port">
              <input
                type="number"
                value={form.serverPort}
                onChange={(e) => setForm({ ...form, serverPort: Number(e.target.value) })}
                className="input"
              />
            </Field>
          </div>
          <Field label="Minecraft version">
            <input
              value={form.minecraftVersion}
              onChange={(e) => setForm({ ...form, minecraftVersion: e.target.value })}
              className="input"
            />
          </Field>
          <Field label="Auth type">
            <select
              value={form.authType}
              onChange={(e) => setForm({ ...form, authType: e.target.value as "OFFLINE" | "MICROSOFT" })}
              className="input"
            >
              <option value="OFFLINE">Offline</option>
              <option value="MICROSOFT">Microsoft</option>
            </select>
          </Field>

          <div className="flex items-center gap-4 pt-1 text-sm text-slate-700">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.afkEnabled}
                onChange={(e) => setForm({ ...form, afkEnabled: e.target.checked })}
              />
              AFK
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.movementEnabled}
                onChange={(e) => setForm({ ...form, movementEnabled: e.target.checked })}
              />
              Movement
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.autoReconnect}
                onChange={(e) => setForm({ ...form, autoReconnect: e.target.checked })}
              />
              Auto-reconnect
            </label>
          </div>

          {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? "Creating..." : "Create account"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-slate-700">{label}</label>
      {children}
    </div>
  );
}
