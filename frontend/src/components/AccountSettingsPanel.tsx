import { useState, type ReactNode } from "react";
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
  const [tpAutoEnabled, setTpAutoEnabled] = useState(account.tpAutoEnabled);
  const [tpAutoAllowlist, setTpAutoAllowlist] = useState<string[]>(account.tpAutoAllowlist ?? []);
  const [allowlistDraft, setAllowlistDraft] = useState("");
  const [autoSellEnabled, setAutoSellEnabled] = useState(account.autoSellEnabled);
  const [autoSellIntervalSeconds, setAutoSellIntervalSeconds] = useState(account.autoSellIntervalSeconds);
  const [autoSellCommand, setAutoSellCommand] = useState(account.autoSellCommand);
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
        tpAutoEnabled,
        tpAutoAllowlist,
        autoSellEnabled,
        autoSellIntervalSeconds,
        autoSellCommand,
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

  function addAllowlistName() {
    const name = allowlistDraft.trim();
    if (!name) return;
    if (name.length > 16 || !/^[A-Za-z0-9_]+$/.test(name)) {
      setError("Invalid Minecraft name");
      return;
    }
    if (!tpAutoAllowlist.some((n) => n.toLowerCase() === name.toLowerCase())) {
      setTpAutoAllowlist([...tpAutoAllowlist, name]);
    }
    setAllowlistDraft("");
  }

  function removeAllowlistName(name: string) {
    setTpAutoAllowlist(tpAutoAllowlist.filter((n) => n !== name));
  }

  function toggleUser(userId: string) {    setAssigned((prev) => {
      const next = new Set(prev);
      next.has(userId) ? next.delete(userId) : next.add(userId);
      return next;
    });
  }

  return (
    <div className="card p-5 text-sm">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 border-b pb-4" style={{ borderColor: "var(--border)" }}>
        <div>
          <h3 className="text-sm font-semibold" style={{ color: "var(--text)" }}>
            Settings
          </h3>
          <p className="mt-0.5 text-xs" style={{ color: "var(--text-subtle)" }}>
            {account.name}
          </p>
        </div>
        {account.createdBy && (
          <div className="flex shrink-0 items-center gap-1.5 text-[11px]">
            <span style={{ color: "var(--text-subtle)" }}>Erstellt von</span>
            <span
              className="rounded-full px-2 py-0.5 font-semibold"
              style={{ backgroundColor: "var(--accent-soft)", color: "var(--accent)" }}
            >
              {account.createdBy.username}
            </span>
          </div>
        )}
      </div>

      {/* Connection */}
      <Section title="Connection" defaultOpen>
        <Field label="Minecraft version" hint={versionMessage ?? undefined}>
          <select
            value={version}
            disabled={versionSaving}
            onChange={(e) => void applyVersion(e.target.value)}
            className="input w-44"
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
        </Field>
        <div>
          <label className="label">Server host</label>
          <input
            value={serverHost}
            onChange={(e) => setServerHost(e.target.value)}
            placeholder="play.example.com"
            className="input"
          />
        </div>
        <Field label="Server port">
          <input
            type="number"
            min={1}
            max={65535}
            value={serverPort}
            onChange={(e) => setServerPort(Number(e.target.value))}
            className="input w-24 text-right"
          />
        </Field>
        <p className="text-xs" style={{ color: "var(--text-subtle)" }}>
          Restart the account to connect to a new server.
        </p>
      </Section>

      {/* Behavior */}
      <Section title="Behavior">
        <Toggle label="AFK behavior" checked={afkEnabled} onChange={setAfkEnabled} />
        <Toggle label="Movement behavior" checked={movementEnabled} onChange={setMovementEnabled} />
        <Toggle label="Auto-reconnect" checked={autoReconnect} onChange={setAutoReconnect} />
        <Field label="AFK interval">
          <NumberInput value={afkIntervalSeconds} onChange={setAfkIntervalSeconds} min={5} max={3600} suffix="s" />
        </Field>
      </Section>

      {/* Auto-command */}
      <Section title="Auto-command">
        <Toggle label="Enabled" checked={autoCommandEnabled} onChange={setAutoCommandEnabled} />
        <div>
          <label className="label">Command / message</label>
          <input
            value={autoCommandText}
            onChange={(e) => setAutoCommandText(e.target.value)}
            placeholder="/hub or a chat message"
            className="input"
          />
        </div>
        <Field label="Interval">
          <NumberInput value={autoCommandIntervalMinutes} onChange={setAutoCommandIntervalMinutes} min={1} max={1440} suffix="min" />
        </Field>
      </Section>

      {/* Auto-TPA */}
      <Section title="Auto-TPA">
        <Toggle
          label="Accept incoming /tpa"
          description="Accepts players teleporting to the bot. Ignores /tpahere."
          checked={tpAutoEnabled}
          onChange={setTpAutoEnabled}
        />
        <div>
          <label className="label">Allowed names</label>
          <p className="mb-2 text-xs" style={{ color: "var(--text-subtle)" }}>
            Leave empty to accept from anyone, or add names to accept only from them.
          </p>
          {tpAutoAllowlist.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {tpAutoAllowlist.map((name) => (
                <span
                  key={name}
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
                  style={{ backgroundColor: "var(--accent-soft)", color: "var(--accent)" }}
                >
                  {name}
                  <button
                    type="button"
                    onClick={() => removeAllowlistName(name)}
                    className="leading-none opacity-70 hover:opacity-100"
                    aria-label={`Remove ${name}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input
              value={allowlistDraft}
              onChange={(e) => setAllowlistDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addAllowlistName();
                }
              }}
              placeholder="Add a Minecraft name…"
              className="input"
            />
            <button type="button" onClick={addAllowlistName} className="btn btn-secondary btn-sm shrink-0">
              Add
            </button>
          </div>
        </div>
      </Section>

      {/* Auto-sell */}
      <Section title="Auto-sell">
        <Toggle
          label="Enabled"
          description="Runs the sell command, then moves all inventory items into the sell menu."
          checked={autoSellEnabled}
          onChange={setAutoSellEnabled}
        />
        <div>
          <label className="label">Sell command</label>
          <input
            value={autoSellCommand}
            onChange={(e) => setAutoSellCommand(e.target.value)}
            placeholder="/sell"
            className="input"
          />
        </div>
        <Field label="Interval">
          <NumberInput value={autoSellIntervalSeconds} onChange={setAutoSellIntervalSeconds} min={1} max={3600} suffix="s" />
        </Field>
      </Section>

      {/* Assigned users (admin only) */}
      {isAdmin && (
        <Section title="Assigned users">
          {users.length === 0 && (
            <p className="text-xs" style={{ color: "var(--text-subtle)" }}>
              No users created yet.
            </p>
          )}
          <div className="max-h-40 space-y-1.5 overflow-y-auto">
            {users.map((u) => (
              <label
                key={u.id}
                className="flex cursor-pointer items-center gap-2"
                style={{ color: "var(--text-muted)" }}
              >
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
        </Section>
      )}

      {error && <p className="alert-error mt-4">{error}</p>}
      {message && <p className="alert-success mt-4">{message}</p>}

      <button onClick={() => void saveSettings()} disabled={saving} className="btn btn-primary mt-5 w-full">
        {saving ? "Saving…" : "Save settings"}
      </button>
    </div>
  );
}

/** A titled, collapsible group of related settings, separated from its neighbours. */
function Section({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="mt-4 rounded-xl border p-3.5" style={{ borderColor: "var(--border)", backgroundColor: "var(--bg-elev)" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2"
        aria-expanded={open}
      >
        <h4 className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-subtle)" }}>
          {title}
        </h4>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0 transition-transform duration-200"
          style={{ color: "var(--text-subtle)", transform: open ? "rotate(180deg)" : "none" }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && <div className="mt-3 space-y-3">{children}</div>}
    </section>
  );
}

/** A label + control row, with an optional hint line below. */
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span style={{ color: "var(--text-muted)" }}>{label}</span>
        {children}
      </div>
      {hint && (
        <p className="mt-1 text-right text-xs" style={{ color: "var(--accent)" }}>
          {hint}
        </p>
      )}
    </div>
  );
}

/** A compact number input with a trailing unit suffix. */
function NumberInput({
  value,
  onChange,
  min,
  max,
  suffix,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  suffix?: string;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="input w-20 text-right"
      />
      {suffix && (
        <span className="text-xs" style={{ color: "var(--text-subtle)" }}>
          {suffix}
        </span>
      )}
    </span>
  );
}

/** A labelled toggle switch with an optional description line. */
function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div>
      <label className="flex cursor-pointer items-center justify-between">
        <span style={{ color: "var(--text-muted)" }}>{label}</span>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="accent-emerald-500"
        />
      </label>
      {description && (
        <p className="mt-1 text-xs" style={{ color: "var(--text-subtle)" }}>
          {description}
        </p>
      )}
    </div>
  );
}
