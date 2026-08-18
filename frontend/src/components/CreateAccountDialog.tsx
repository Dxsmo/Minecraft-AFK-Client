import { useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError } from "../lib/api";
import { MINECRAFT_VERSIONS, AUTO_DETECT_VERSION } from "../lib/minecraftVersions";

type AuthType = "OFFLINE" | "MICROSOFT";

export function CreateAccountDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [authType, setAuthType] = useState<AuthType>("OFFLINE");
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [serverHost, setServerHost] = useState("");
  const [serverPort, setServerPort] = useState(25565);
  const [minecraftVersion, setMinecraftVersion] = useState(AUTO_DETECT_VERSION);
  const [afkEnabled, setAfkEnabled] = useState(true);
  const [movementEnabled, setMovementEnabled] = useState(false);
  const [autoReconnect, setAutoReconnect] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.post("/minecraft/accounts", {
        // The display name shown on the website. For offline accounts the
        // in-game username doubles as the name; Microsoft accounts get their
        // own free-form name chosen here.
        name: authType === "OFFLINE" ? username : name,
        authType,
        credentialsSecret: authType === "MICROSOFT" ? email : undefined,
        credentialsPassword: authType === "MICROSOFT" ? password : undefined,
        serverHost,
        serverPort,
        minecraftVersion,
        afkEnabled,
        movementEnabled,
        autoReconnect,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create account");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: "rgba(0,0,0,0.6)" }}>
      <div className="card w-full max-w-md p-6" style={{ boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}>
        <h2 className="text-base font-semibold" style={{ color: "var(--text)" }}>
          New Minecraft account
        </h2>
        <p className="mt-0.5 text-xs" style={{ color: "var(--text-subtle)" }}>
          Account credentials are set once and can't be edited later.
        </p>

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          <div>
            <label className="label">Account type</label>
            <div
              className="grid grid-cols-2 gap-1 rounded-lg p-1"
              style={{ backgroundColor: "var(--bg-elev)", border: "1px solid var(--border-strong)" }}
            >
              <SegButton active={authType === "OFFLINE"} onClick={() => setAuthType("OFFLINE")}>
                Offline
              </SegButton>
              <SegButton active={authType === "MICROSOFT"} onClick={() => setAuthType("MICROSOFT")}>
                Microsoft
              </SegButton>
            </div>
          </div>

          {authType === "OFFLINE" ? (
            <Field label="Minecraft username">
              <input
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="input"
                placeholder="Desmodus"
                pattern="[a-zA-Z0-9_\-]+"
                minLength={2}
                maxLength={32}
              />
            </Field>
          ) : (
            <>
              <Field label="Account name">
                <input
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="input"
                  placeholder="Desmodus"
                  pattern="[a-zA-Z0-9_\-]+"
                  minLength={2}
                  maxLength={32}
                />
              </Field>
              <Field label="Microsoft account email">
                <input
                  required
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="input"
                  placeholder="bot@example.com"
                />
              </Field>
              <Field label="Microsoft account password">
                <input
                  required
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input"
                  placeholder="••••••••"
                  autoComplete="new-password"
                />
              </Field>
            </>
          )}

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Field label="Server host">
                <input
                  required
                  value={serverHost}
                  onChange={(e) => setServerHost(e.target.value)}
                  className="input"
                  placeholder="play.example.com"
                />
              </Field>
            </div>
            <Field label="Port">
              <input
                type="number"
                value={serverPort}
                onChange={(e) => setServerPort(Number(e.target.value))}
                className="input"
              />
            </Field>
          </div>

          <Field label="Minecraft version">
            <select
              value={minecraftVersion}
              onChange={(e) => setMinecraftVersion(e.target.value)}
              className="input"
            >
              <option value={AUTO_DETECT_VERSION}>Auto-detect (recommended)</option>
              {MINECRAFT_VERSIONS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </Field>

          <div className="flex flex-wrap gap-x-5 gap-y-2 pt-0.5 text-sm" style={{ color: "var(--text-muted)" }}>
            <Toggle checked={afkEnabled} onChange={setAfkEnabled} label="AFK" />
            <Toggle checked={movementEnabled} onChange={setMovementEnabled} label="Movement" />
            <Toggle checked={autoReconnect} onChange={setAutoReconnect} label="Auto-reconnect" />
          </div>

          {error && <p className="alert-error">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="btn btn-ghost">
              Cancel
            </button>
            <button type="submit" disabled={submitting} className="btn btn-primary">
              {submitting ? "Creating…" : "Create account"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function SegButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md py-1.5 text-sm font-medium transition-colors"
      style={
        active
          ? { backgroundColor: "var(--surface-hover)", color: "var(--text)" }
          : { color: "var(--text-subtle)" }
      }
    >
      {children}
    </button>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-emerald-500" />
      {label}
    </label>
  );
}
