import { useState, type ReactNode } from "react";
import { api, ApiError } from "../lib/api";
import type { MinecraftAccount } from "../lib/types";
import { useAuth } from "../lib/auth";
import { AccessUsernameInput, type AccessUser } from "./AccessUsernameInput";
import { MINECRAFT_VERSIONS, AUTO_DETECT_VERSION } from "../lib/minecraftVersions";
import { SPAWNER_TYPES, getSpawnerType, spawnerItemTexture, type SpawnerAction } from "../lib/spawners";

export function AccountSettingsPanel({
  account,
  canManageAccess,
  currentUserId,
  onUpdated,
}: {
  account: MinecraftAccount;
  canManageAccess: boolean;
  currentUserId?: string;
  onUpdated: () => void;
}) {
  const { user } = useAuth();
  const [users, setUsers] = useState<AccessUser[]>(() => account.assignments.map((assignment) => assignment.user));
  const [crouchEnabled, setCrouchEnabled] = useState(account.crouchEnabled);
  const [displayName, setDisplayName] = useState(account.displayName ?? "");
  const [serverHost, setServerHost] = useState(account.serverHost);
  const [serverPort, setServerPort] = useState(account.serverPort);
  const [autoReconnect, setAutoReconnect] = useState(account.autoReconnect);
  const [autoSellEnabled, setAutoSellEnabled] = useState(account.autoSellEnabled);
  const [autoSellIntervalSeconds, setAutoSellIntervalSeconds] = useState(account.autoSellIntervalSeconds);
  const [autoSellCommand, setAutoSellCommand] = useState(account.autoSellCommand);
  const [spawnerType, setSpawnerType] = useState(account.spawnerType ?? "");
  const [spawnerActions, setSpawnerActions] = useState<Record<string, SpawnerAction>>(
    account.spawnerActions ?? {},
  );
  const [spawnerClearEnabled, setSpawnerClearEnabled] = useState(account.spawnerClearEnabled ?? false);
  const [spawnerClearTimes, setSpawnerClearTimes] = useState<string[]>(account.spawnerClearTimes ?? []);
  const [spawnerTimeDraft, setSpawnerTimeDraft] = useState("04:00");
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
        crouchEnabled,
        autoReconnect,
        serverHost,
        serverPort,
        autoSellEnabled,
        autoSellIntervalSeconds,
        autoSellCommand,
        spawnerType,
        spawnerActions,
        spawnerClearEnabled,
        spawnerClearTimes,
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

  function addSpawnerTime() {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(spawnerTimeDraft)) {
      setError("Invalid time (use HH:MM)");
      return;
    }
    if (!spawnerClearTimes.includes(spawnerTimeDraft)) {
      setSpawnerClearTimes([...spawnerClearTimes, spawnerTimeDraft].sort());
    }
  }

  function setSpawnerAction(itemId: string, action: SpawnerAction) {
    setSpawnerActions((prev) => ({ ...prev, [itemId]: action }));
  }

  function removeUser(userId: string) {
    setUsers((prev) => prev.filter((entry) => entry.id !== userId));
    setAssigned((prev) => {
      const next = new Set(prev);
      next.delete(userId);
      return next;
    });
  }

  const categories: { id: string; label: string; icon: CatIcon; meta?: string; on?: boolean }[] = [
    { id: "general", label: "General", icon: "user", meta: displayName.trim() || account.name },
    { id: "connection", label: "Connection", icon: "server", meta: `${serverHost}:${serverPort}` },
    {
      id: "behavior",
      label: "Behavior",
      icon: "activity",
      on: crouchEnabled,
    },
    { id: "autosell", label: "Auto-sell", icon: "tag", on: autoSellEnabled },
    {
      id: "spawner",
      label: "Spawner",
      icon: "cube",
      on: spawnerType !== "",
      meta: getSpawnerType(spawnerType)?.label,
    },
    ...(canManageAccess ? [{ id: "users", label: "Access", icon: "users" as CatIcon, meta: `${assigned.size} assigned` }] : []),
  ];
  const active = categories.find((c) => c.id === activeCat) ?? categories[0];
  const selectedSpawner = getSpawnerType(spawnerType);

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
                <Toggle label="Crouch" description="Continuously sneak while connected." checked={crouchEnabled} onChange={setCrouchEnabled} />
                <Toggle label="Auto-reconnect" checked={autoReconnect} onChange={setAutoReconnect} />
              </>
            )}

            {activeCat === "autosell" && (
              <>
                <Toggle
                  label="Enabled"
                  description="Öffnet das Verkaufsmenü einmalig und lässt es offen: Items werden hineingeschoben, der Bestätigen-Knopf gedrückt, und das wiederholt sich. Bei einem Fehler wird das Menü automatisch neu geöffnet."
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
                  <NumberInput value={autoSellIntervalSeconds} onChange={setAutoSellIntervalSeconds} min={0.25} max={3600} step={0.05} suffix="s" />
                </Field>
              </>
            )}

            {activeCat === "spawner" && (
              <>
                <p className="text-xs" style={{ color: "var(--text-subtle)" }}>
                  Wähle den Spawner-Typ, vor dem dieser Account steht. Danach kannst du für
                  jede Item-Art festlegen, ob sie aus dem Spawner <b>gedroppt</b> oder über
                  den grünen Knopf <b>verkauft</b> wird. Gedroppt wird immer zuerst, und beides
                  stoppt, sobald weniger als 2 Stacks der Art übrig sind.
                </p>

                <div>
                  <label className="label">Spawner-Typ</label>
                  <div className="spawner-grid">
                    {SPAWNER_TYPES.map((type) => {
                      const selected = spawnerType === type.id;
                      return (
                        <button
                          key={type.id}
                          type="button"
                          onClick={() => setSpawnerType(selected ? "" : type.id)}
                          className={`spawner-chip${selected ? " spawner-chip-active" : ""}`}
                          aria-pressed={selected}
                        >
                          <span className="spawner-chip-emoji">{type.emoji}</span>
                          <span className="spawner-chip-label">{type.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Per-item drop/sell picker, revealed once a type is chosen. */}
                {selectedSpawner && (
                  <div className="spawner-items">
                    <label className="label">Items im {selectedSpawner.label}-Spawner</label>
                    <div className="space-y-2">
                      {selectedSpawner.items.map((item) => {
                        const action = spawnerActions[item.id] ?? "keep";
                        return (
                          <div key={item.id} className="spawner-item-row">
                            <div className="flex min-w-0 items-center gap-2">
                              <img
                                src={spawnerItemTexture(item.id)}
                                alt=""
                                aria-hidden
                                className="spawner-item-icon"
                                onError={(e) => (e.currentTarget.style.visibility = "hidden")}
                              />
                              <span className="truncate text-xs font-medium" style={{ color: "var(--text)" }}>
                                {item.label}
                              </span>
                            </div>
                            <div className="spawner-actions">
                              {(["keep", "drop", "sell"] as SpawnerAction[]).map((value) => (
                                <button
                                  key={value}
                                  type="button"
                                  onClick={() => setSpawnerAction(item.id, value)}
                                  className={`spawner-action${action === value ? ` spawner-action-${value}` : ""}`}
                                  aria-pressed={action === value}
                                >
                                  {value === "keep" ? "Lassen" : value === "drop" ? "Droppen" : "Verkaufen"}
                                </button>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="border-t pt-3" style={{ borderColor: "var(--border)" }}>
                  <Toggle
                    label="Nach Zeit leeren"
                    description="Startet den Leer-Vorgang automatisch zu festen Uhrzeiten (Server-Ortszeit)."
                    checked={spawnerClearEnabled}
                    onChange={setSpawnerClearEnabled}
                  />
                  {spawnerClearEnabled && (
                    <div className="mt-2">
                      {spawnerClearTimes.length > 0 && (
                        <div className="mb-2 flex flex-wrap gap-1.5">
                          {spawnerClearTimes.map((time) => (
                            <span key={time} className="time-pill">
                              {time}
                              <button
                                type="button"
                                onClick={() => setSpawnerClearTimes(spawnerClearTimes.filter((t) => t !== time))}
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
                          value={spawnerTimeDraft}
                          onChange={(e) => setSpawnerTimeDraft(e.target.value)}
                          className="input w-32"
                        />
                        <button type="button" onClick={addSpawnerTime} className="btn btn-secondary btn-sm shrink-0">
                          + Uhrzeit
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}

            {activeCat === "users" && canManageAccess && (
              <>
                <p className="mb-2 text-xs" style={{ color: "var(--text-subtle)" }}>
                  Gib den Benutzernamen ein, um Zugriff auf diesen Account freizugeben. Admins haben immer Zugriff.
                </p>
                <AccessUsernameInput endpoint={`/minecraft/accounts/${account.id}/assignments/lookup`} disabled={saving} onAdd={(entry) => {
                  if (users.some((existing) => existing.id === entry.id)) return "Dieser Benutzer hat bereits Zugriff.";
                  setUsers((prev) => [...prev, entry]);
                  setAssigned((prev) => new Set([...prev, entry.id]));
                }} />
                {users.length === 0 && (
                  <p className="text-xs" style={{ color: "var(--text-subtle)" }}>
                    Noch keine Freigaben.
                  </p>
                )}
                <div className="max-h-64 space-y-1.5 overflow-y-auto">
                  {users.map((u) => {
                    const isSelf = u.id === currentUserId;
                    // A non-admin creator retains their own access. Admins may
                    // remove any explicit assignment.
                    const locked = isSelf && user?.role !== "ADMIN";
                    return (
                      <div
                        key={u.id}
                        className="flex items-center justify-between gap-2 py-1"
                        style={{ color: "var(--text-muted)" }}
                      >
                        <span className="min-w-0 truncate">{u.username}</span>
                        {isSelf && (
                          <span className="text-[10px]" style={{ color: "var(--text-subtle)" }}>
                            · du
                          </span>
                        )}
                        {!locked && <button type="button" className="btn btn-ghost text-xs" aria-label={`Zugriff für ${u.username} entfernen`} disabled={saving} onClick={() => removeUser(u.id)}>Entfernen</button>}
                      </div>
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

type CatIcon =
  | "user"
  | "server"
  | "activity"
  | "tag"
  | "users"
  | "cube";

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
    case "tag":
      return (
        <svg {...common}>
          <path d="M20.5 12.5 12 21l-9-9V4a1 1 0 0 1 1-1h8z" />
          <line x1="7.5" y1="7.5" x2="7.5" y2="7.5" />
        </svg>
      );
    case "cube":
      return (
        <svg {...common}>
          <path d="M12 2.8 20.5 7v10L12 21.2 3.5 17V7z" />
          <path d="M3.5 7 12 11.5 20.5 7" />
          <line x1="12" y1="11.5" x2="12" y2="21.2" />
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
  step = 1,
  suffix,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <input
        type="number"
        min={min}
        max={max}
        step={step}
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
          className="accent-[var(--accent)]"
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
