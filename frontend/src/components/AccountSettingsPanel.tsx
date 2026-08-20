import { useState, type ReactNode } from "react";
import { api, ApiError } from "../lib/api";
import type { ManagedUser, MinecraftAccount } from "../lib/types";
import { MINECRAFT_VERSIONS, AUTO_DETECT_VERSION } from "../lib/minecraftVersions";

export function AccountSettingsPanel({
  account,
  users,
  canManageAccess,
  currentUserId,
  onUpdated,
}: {
  account: MinecraftAccount;
  users: ManagedUser[];
  canManageAccess: boolean;
  currentUserId?: string;
  onUpdated: () => void;
}) {
  const [afkEnabled, setAfkEnabled] = useState(account.afkEnabled);
  const [movementEnabled, setMovementEnabled] = useState(account.movementEnabled);
  const [crouchEnabled, setCrouchEnabled] = useState(account.crouchEnabled);
  const [displayName, setDisplayName] = useState(account.displayName ?? "");
  const [serverHost, setServerHost] = useState(account.serverHost);
  const [serverPort, setServerPort] = useState(account.serverPort);
  const [afkIntervalSeconds, setAfkIntervalSeconds] = useState(account.afkIntervalSeconds);
  const [autoReconnect, setAutoReconnect] = useState(account.autoReconnect);
  const [autoCommandEnabled, setAutoCommandEnabled] = useState(account.autoCommandEnabled);
  const [autoCommandText, setAutoCommandText] = useState(account.autoCommandText);
  const [autoCommandIntervalMinutes, setAutoCommandIntervalMinutes] = useState(account.autoCommandIntervalMinutes);
  const [dailyCommandEnabled, setDailyCommandEnabled] = useState(account.dailyCommandEnabled);
  const [dailyCommandTimes, setDailyCommandTimes] = useState<string[]>(account.dailyCommandTimes ?? []);
  const [dailyTimeDraft, setDailyTimeDraft] = useState("08:00");
  const [balanceEnabled, setBalanceEnabled] = useState(account.balanceEnabled);
  const [balanceCommand, setBalanceCommand] = useState(account.balanceCommand);
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
  const [activeCat, setActiveCat] = useState<string>("general");

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
        displayName,
        afkEnabled,
        movementEnabled,
        crouchEnabled,
        afkIntervalSeconds,
        autoReconnect,
        serverHost,
        serverPort,
        autoCommandEnabled,
        autoCommandText,
        autoCommandIntervalMinutes,
        dailyCommandEnabled,
        dailyCommandTimes,
        balanceEnabled,
        balanceCommand,
        tpAutoEnabled,
        tpAutoAllowlist,
        autoSellEnabled,
        autoSellIntervalSeconds,
        autoSellCommand,
      });
      if (canManageAccess) {
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

  function addDailyTime() {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(dailyTimeDraft)) {
      setError("Invalid time (use HH:MM)");
      return;
    }
    if (!dailyCommandTimes.includes(dailyTimeDraft)) {
      setDailyCommandTimes([...dailyCommandTimes, dailyTimeDraft].sort());
    }
  }

  function removeDailyTime(time: string) {
    setDailyCommandTimes(dailyCommandTimes.filter((t) => t !== time));
  }

  function toggleUser(userId: string) {    setAssigned((prev) => {
      const next = new Set(prev);
      next.has(userId) ? next.delete(userId) : next.add(userId);
      return next;
    });
  }

  const categories: { id: string; label: string; icon: CatIcon; meta?: string; on?: boolean }[] = [
    { id: "general", label: "General", icon: "user", meta: displayName.trim() || account.name },
    { id: "connection", label: "Connection", icon: "server", meta: `${serverHost}:${serverPort}` },
    { id: "behavior", label: "Behavior", icon: "activity", on: afkEnabled || movementEnabled || crouchEnabled },
    { id: "autocommand", label: "Auto-command", icon: "terminal", on: autoCommandEnabled || dailyCommandEnabled },
    { id: "balance", label: "Balance", icon: "coin", on: balanceEnabled },
    { id: "autotpa", label: "Auto-TPA", icon: "portal", on: tpAutoEnabled },
    { id: "autosell", label: "Auto-sell", icon: "tag", on: autoSellEnabled },
    ...(canManageAccess ? [{ id: "users", label: "Access", icon: "users" as CatIcon, meta: `${assigned.size} assigned` }] : []),
  ];
  const active = categories.find((c) => c.id === activeCat) ?? categories[0];

  return (
    <div className="card overflow-hidden p-0 text-sm">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 border-b p-5 py-4" style={{ borderColor: "var(--border)" }}>
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

      {/* Master-detail: category list on the left, selected category on the right. */}
      <div className="grid md:grid-cols-[210px_1fr]">
        <nav
          className="flex gap-1 overflow-x-auto border-b p-3 md:flex-col md:overflow-visible md:border-b-0 md:border-r"
          style={{ borderColor: "var(--border)" }}
        >
          {categories.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => setActiveCat(cat.id)}
              data-active={activeCat === cat.id}
              className="settings-nav-btn"
            >
              <CatGlyph name={cat.icon} />
              <span className="flex min-w-0 flex-1 flex-col text-left">
                <span className="truncate">{cat.label}</span>
                {cat.meta && (
                  <span className="truncate text-[11px] font-normal" style={{ color: "var(--text-subtle)" }}>
                    {cat.meta}
                  </span>
                )}
              </span>
              {cat.on && <span className="settings-nav-dot" aria-label="enabled" />}
              <svg
                className="settings-nav-chevron hidden shrink-0 md:block"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="9 6 15 12 9 18" />
              </svg>
            </button>
          ))}
        </nav>

        <div className="min-h-[340px] p-5">
          <div key={activeCat} className="tab-panel space-y-3.5">
            <div className="mb-1 flex items-center gap-2">
              <CatGlyph name={active.icon} />
              <h4 className="text-sm font-semibold" style={{ color: "var(--text)" }}>
                {active.label}
              </h4>
            </div>

            {activeCat === "general" && (
              <div>
                <label className="label">Display name</label>
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder={account.name}
                  maxLength={48}
                  className="input"
                />
                <p className="mt-1 text-xs" style={{ color: "var(--text-subtle)" }}>
                  Website label only — does not change the Minecraft login name. Leave empty to use “{account.name}”.
                </p>
              </div>
            )}

            {activeCat === "connection" && (
              <>
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
              </>
            )}

            {activeCat === "behavior" && (
              <>
                <Toggle label="AFK behavior" checked={afkEnabled} onChange={setAfkEnabled} />
                <Toggle label="Movement behavior" checked={movementEnabled} onChange={setMovementEnabled} />
                <Toggle label="Crouch" description="Continuously sneak while connected." checked={crouchEnabled} onChange={setCrouchEnabled} />
                <Toggle label="Auto-reconnect" checked={autoReconnect} onChange={setAutoReconnect} />
                <Field label="AFK interval">
                  <NumberInput value={afkIntervalSeconds} onChange={setAfkIntervalSeconds} min={5} max={3600} suffix="s" />
                </Field>
              </>
            )}

            {activeCat === "autocommand" && (
              <>
                <div>
                  <label className="label">Command / message</label>
                  <input
                    value={autoCommandText}
                    onChange={(e) => setAutoCommandText(e.target.value)}
                    placeholder="/hub or a chat message"
                    className="input"
                  />
                  <p className="mt-1 text-xs" style={{ color: "var(--text-subtle)" }}>
                    Used by both schedules below. Enable interval, daily, or both.
                  </p>
                </div>

                {/* Interval schedule — independent from the daily schedule. */}
                <div className="border-t pt-3" style={{ borderColor: "var(--border)" }}>
                  <Toggle
                    label="Interval"
                    description="Run the command repeatedly on a fixed timer."
                    checked={autoCommandEnabled}
                    onChange={setAutoCommandEnabled}
                  />
                  {autoCommandEnabled && (
                    <div className="mt-2">
                      <Field label="Every">
                        <NumberInput value={autoCommandIntervalMinutes} onChange={setAutoCommandIntervalMinutes} min={1} max={1440} suffix="min" />
                      </Field>
                    </div>
                  )}
                </div>

                {/* Daily schedule — independent from the interval schedule. */}
                <div className="border-t pt-3" style={{ borderColor: "var(--border)" }}>
                  <Toggle
                    label="Daily"
                    description="Run the command once each day at the times below (server local time)."
                    checked={dailyCommandEnabled}
                    onChange={setDailyCommandEnabled}
                  />
                  {dailyCommandEnabled && (
                    <div className="mt-2">
                      {dailyCommandTimes.length > 0 && (
                        <div className="mb-2 flex flex-wrap gap-1.5">
                          {dailyCommandTimes.map((time) => (
                            <span
                              key={time}
                              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums"
                              style={{ backgroundColor: "var(--accent-soft)", color: "var(--accent)" }}
                            >
                              {time}
                              <button
                                type="button"
                                onClick={() => removeDailyTime(time)}
                                className="leading-none opacity-70 hover:opacity-100"
                                aria-label={`Remove ${time}`}
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="flex gap-2">
                        <input
                          type="time"
                          value={dailyTimeDraft}
                          onChange={(e) => setDailyTimeDraft(e.target.value)}
                          className="input w-32"
                        />
                        <button type="button" onClick={addDailyTime} className="btn btn-secondary btn-sm shrink-0">
                          + Add time
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}

            {activeCat === "balance" && (
              <>
                <Toggle
                  label="Show balance"
                  description="Queries the balance every 5 minutes and shows it above health/hunger."
                  checked={balanceEnabled}
                  onChange={setBalanceEnabled}
                />
                <div>
                  <label className="label">Balance command</label>
                  <input
                    value={balanceCommand}
                    onChange={(e) => setBalanceCommand(e.target.value)}
                    placeholder="/balance"
                    className="input"
                  />
                </div>
              </>
            )}

            {activeCat === "autotpa" && (
              <>
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
              </>
            )}

            {activeCat === "autosell" && (
              <>
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
              </>
            )}

            {activeCat === "users" && canManageAccess && (
              <>
                <p className="mb-2 text-xs" style={{ color: "var(--text-subtle)" }}>
                  Choose which users may view and control this account. Admins always
                  have access.
                </p>
                {users.length === 0 && (
                  <p className="text-xs" style={{ color: "var(--text-subtle)" }}>
                    No users created yet.
                  </p>
                )}
                <div className="max-h-64 space-y-1.5 overflow-y-auto">
                  {users.map((u) => {
                    const alwaysAccess = u.role === "ADMIN";
                    const isSelf = u.id === currentUserId;
                    // Admins always have access; the managing operator can't drop
                    // their own access — both are shown locked & checked.
                    const locked = alwaysAccess || isSelf;
                    return (
                      <label
                        key={u.id}
                        className="flex items-center gap-2"
                        style={{ color: "var(--text-muted)", cursor: locked ? "default" : "pointer" }}
                      >
                        <input
                          type="checkbox"
                          checked={locked || assigned.has(u.id)}
                          disabled={locked}
                          onChange={() => toggleUser(u.id)}
                          className="accent-emerald-500"
                        />
                        <span>{u.username}</span>
                        {alwaysAccess && (
                          <span className="text-[10px]" style={{ color: "var(--text-subtle)" }}>
                            · admin · always access
                          </span>
                        )}
                        {isSelf && !alwaysAccess && (
                          <span className="text-[10px]" style={{ color: "var(--text-subtle)" }}>
                            · you
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Footer: save + status. */}
      <div className="border-t p-4" style={{ borderColor: "var(--border)" }}>
        {error && <p className="alert-error mb-3">{error}</p>}
        {message && <p className="alert-success mb-3">{message}</p>}
        <button onClick={() => void saveSettings()} disabled={saving} className="btn btn-primary w-full">
          {saving ? "Saving…" : "Save settings"}
        </button>
      </div>
    </div>
  );
}

type CatIcon = "user" | "server" | "activity" | "terminal" | "coin" | "portal" | "tag" | "users";

/** Small line icon used in the settings category navigation. */
function CatGlyph({ name }: { name: CatIcon }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: "shrink-0",
  };
  switch (name) {
    case "user":
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" />
        </svg>
      );
    case "server":
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="7" rx="2" />
          <rect x="3" y="13" width="18" height="7" rx="2" />
          <line x1="7" y1="7.5" x2="7" y2="7.5" />
          <line x1="7" y1="16.5" x2="7" y2="16.5" />
        </svg>
      );
    case "activity":
      return (
        <svg {...common}>
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
        </svg>
      );
    case "terminal":
      return (
        <svg {...common}>
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
      );
    case "coin":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M9.5 9.5a2.5 2.5 0 0 1 5 0c0 2-2.5 1.5-2.5 3.5" />
          <line x1="12" y1="16.5" x2="12" y2="16.5" />
        </svg>
      );
    case "portal":
      return (
        <svg {...common}>
          <ellipse cx="12" cy="12" rx="6" ry="9" />
          <ellipse cx="12" cy="12" rx="2.5" ry="5" />
        </svg>
      );
    case "tag":
      return (
        <svg {...common}>
          <path d="M20.5 12.5 12 21l-9-9V4a1 1 0 0 1 1-1h8z" />
          <line x1="7.5" y1="7.5" x2="7.5" y2="7.5" />
        </svg>
      );
    case "users":
      return (
        <svg {...common}>
          <circle cx="9" cy="8" r="3.5" />
          <path d="M2.5 20v-1a5 5 0 0 1 5-5h3a5 5 0 0 1 5 5v1" />
          <path d="M16 4.5a3.5 3.5 0 0 1 0 7" />
          <path d="M17 14.2a5 5 0 0 1 4.5 4.8v1" />
        </svg>
      );
  }
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
