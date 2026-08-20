import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { MINECRAFT_VERSIONS, AUTO_DETECT_VERSION } from "../lib/minecraftVersions";
import { useAccountConsole } from "../lib/sockets";
import type { MinecraftAccount } from "../lib/types";

type Edition = "JAVA" | "BEDROCK";

export function CreateAccountDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const navigate = useNavigate();
  const [edition, setEdition] = useState<Edition>("JAVA");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [serverHost, setServerHost] = useState("");
  const [serverPort, setServerPort] = useState(25565);
  const [portTouched, setPortTouched] = useState(false);
  const [minecraftVersion, setMinecraftVersion] = useState(AUTO_DETECT_VERSION);
  const [afkEnabled, setAfkEnabled] = useState(true);
  const [movementEnabled, setMovementEnabled] = useState(false);
  const [autoReconnect, setAutoReconnect] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Step 2 — after the account is created we start it, then watch its live
  // status for the Microsoft device-code prompt and for the "authenticated"
  // signal (profile resolved). Once signed in, jump straight to its settings.
  const [createdId, setCreatedId] = useState<string | null>(null);
  const { status } = useAccountConsole(createdId ?? undefined);
  const msaSignIn = status?.msaSignIn;

  // Switch the default port with the edition unless the user set one explicitly.
  function changeEdition(next: Edition) {
    setEdition(next);
    if (!portTouched) setServerPort(next === "BEDROCK" ? 19132 : 25565);
  }

  useEffect(() => {
    if (createdId && status?.authenticated) {
      onCreated();
      navigate(`/accounts/${createdId}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createdId, status?.authenticated]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const account = await api.post<MinecraftAccount>("/minecraft/accounts", {
        name,
        edition,
        // The Microsoft account email. No password — sign-in happens through the
        // interactive device-code link shown in the next step.
        credentialsSecret: email,
        serverHost,
        serverPort,
        minecraftVersion,
        afkEnabled,
        movementEnabled,
        autoReconnect,
      });
      // Kick off the bot so the device-code sign-in flow starts right away.
      await api.post(`/minecraft/accounts/${account.id}/start`).catch(() => undefined);
      setCreatedId(account.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create account");
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: "rgba(0,0,0,0.6)" }}>
      <div className="card w-full max-w-md p-6" style={{ boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}>
        {createdId ? (
          <SignInStep
            name={name}
            verificationUri={msaSignIn?.verificationUri}
            userCode={msaSignIn?.userCode}
            lastError={status?.lastError}
            onClose={onCreated}
          />
        ) : (
          <>
            <h2 className="text-base font-semibold" style={{ color: "var(--text)" }}>
              New Minecraft account
            </h2>
            <p className="mt-0.5 text-xs" style={{ color: "var(--text-subtle)" }}>
              Sign in once with Microsoft — no password is stored.
            </p>

            <form onSubmit={handleSubmit} className="mt-5 space-y-4">
              <div>
                <label className="label">Edition</label>
                <div
                  className="grid grid-cols-2 gap-1 rounded-lg p-1"
                  style={{ backgroundColor: "var(--bg-elev)", border: "1px solid var(--border-strong)" }}
                >
                  <SegButton active={edition === "JAVA"} onClick={() => changeEdition("JAVA")}>
                    Java
                  </SegButton>
                  <SegButton active={edition === "BEDROCK"} onClick={() => changeEdition("BEDROCK")}>
                    Bedrock
                  </SegButton>
                </div>
                {edition === "BEDROCK" && (
                  <p className="mt-1.5 text-xs" style={{ color: "var(--text-subtle)" }}>
                    Bedrock support is experimental. Container features (auto-sell menus, clean-spawner,
                    live inventory moves) are limited — see the docs.
                  </p>
                )}
              </div>

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

              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <Field label="Server IP:">
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
                    onChange={(e) => {
                      setServerPort(Number(e.target.value));
                      setPortTouched(true);
                    }}
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
                  {edition === "JAVA" &&
                    MINECRAFT_VERSIONS.map((v) => (
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
                  {submitting ? "Creating…" : "Continue"}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

/** Step 2: interactive Microsoft device-code sign-in. */
function SignInStep({
  name,
  verificationUri,
  userCode,
  lastError,
  onClose,
}: {
  name: string;
  verificationUri?: string;
  userCode?: string;
  lastError?: string;
  onClose: () => void;
}) {
  const ready = !!verificationUri && !!userCode;

  return (
    <div className="animate-fadein">
      <h2 className="text-base font-semibold" style={{ color: "var(--text)" }}>
        Sign in to Microsoft
      </h2>
      <p className="mt-0.5 text-xs" style={{ color: "var(--text-subtle)" }}>
        Link <span style={{ color: "var(--text)" }}>{name}</span> once — the account opens automatically when done.
      </p>

      {!ready ? (
        <div className="mt-6 flex flex-col items-center gap-3 py-6">
          <span className="spinner" />
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>
            Preparing sign-in link…
          </p>
        </div>
      ) : (
        <div className="mt-5 space-y-4">
          <a
            href={verificationUri}
            target="_blank"
            rel="noreferrer"
            className="btn btn-primary w-full justify-center"
          >
            Open Microsoft sign-in ↗
          </a>
          <div className="text-center">
            <p className="text-xs" style={{ color: "var(--text-subtle)" }}>
              Enter this code on the opened page:
            </p>
            <div className="mt-2 flex items-center justify-center gap-2">
              <code
                className="rounded-lg px-4 py-2 text-2xl font-bold tracking-widest"
                style={{ backgroundColor: "rgba(0,0,0,0.35)", color: "var(--text)" }}
              >
                {userCode}
              </code>
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(userCode!)}
                className="btn btn-ghost btn-sm"
              >
                Copy
              </button>
            </div>
          </div>
          <div className="flex items-center justify-center gap-2 pt-1">
            <span className="spinner spinner-sm" />
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              Waiting for sign-in…
            </p>
          </div>
        </div>
      )}

      {lastError && (
        <p className="mt-4 text-xs" style={{ color: "var(--danger)" }}>
          {lastError}
        </p>
      )}

      <div className="mt-5 flex justify-end">
        <button type="button" onClick={onClose} className="btn btn-ghost btn-sm">
          Finish later
        </button>
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
