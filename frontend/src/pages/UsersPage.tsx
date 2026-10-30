import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";
import type { BannedIp, ManagedUser } from "../lib/types";
import { useCompactLayout } from "../lib/useCompactLayout";
import { useAuth } from "../lib/useAuth";

export function UsersPage() {
  const { user: currentUser } = useAuth();
  const compact = useCompactLayout();
  const [users, setUsers] = useState<ManagedUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ username: "", password: "", minecraftUsername: "", role: "USER" as "ADMIN" | "USER" });
  const [creating, setCreating] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartMessage, setRestartMessage] = useState<string | null>(null);

  async function restartAll() {
    if (restarting) return;
    setRestarting(true);
    setRestartMessage(null);
    setError(null);
    try {
      const result = await api.post<{ restartedCount: number; failedCount: number; cooldownSeconds: number }>("/admin/restart-all");
      setRestartMessage(result.restartedCount
        ? `${result.restartedCount} Online-Accounts werden mit ${result.cooldownSeconds} Sekunden Offline-Pause neu gestartet.`
        : "Derzeit sind keine Accounts online.");
      if (result.failedCount) setError(`${result.failedCount} Accounts konnten nicht neu gestartet werden.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Accounts konnten nicht neu gestartet werden.");
    } finally {
      setRestarting(false);
    }
  }

  async function load() {
    try {
      setUsers(await api.get<ManagedUser[]>("/users"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load users");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await api.post("/users", form);
      setForm({ username: "", password: "", minecraftUsername: "", role: "USER" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create user");
    } finally {
      setCreating(false);
    }
  }

  async function toggleStatus(user: ManagedUser) {
    try {
      await api.patch(`/users/${user.id}`, { status: user.status === "ACTIVE" ? "DISABLED" : "ACTIVE" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to update user");
    }
  }

  async function remove(user: ManagedUser) {
    if (!confirm(`Delete user "${user.username}"? This cannot be undone.`)) return;
    try {
      await api.delete(`/users/${user.id}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to delete user");
    }
  }

  return (
    <div className="admin-panel space-y-6">
      <div>
        <h1 className="text-xl font-semibold" style={{ color: "var(--text)" }}>
          Admin Panel
        </h1>
        <p className="mt-0.5 text-sm" style={{ color: "var(--text-muted)" }}>
          Accounts und Benutzer verwalten
        </p>
      </div>

      {error && <p className="alert-error">{error}</p>}
      {currentUser?.role === "ADMIN" && <section className="card admin-restart flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <h2 className="font-semibold">Online-Accounts neu starten</h2>
          <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>Alle aktuell online befindlichen Minecraft-Accounts starten nach 5 Sekunden Offline-Pause erneut.</p>
        </div>
        <button type="button" onClick={() => void restartAll()} disabled={restarting} className="btn btn-primary">
          {restarting ? "Restarting…" : "Restart all"}
        </button>
      </section>}
      {restartMessage && <p role="status" className="text-sm" style={{ color: "var(--text-muted)" }}>{restartMessage}</p>}

      <form onSubmit={handleCreate} className="desktop-only card flex flex-wrap items-end gap-3 p-4" autoComplete="off">
        <div>
          <label className="label">Username</label>
          <input
            required
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            className="input w-44"
            autoComplete="off"
          />
        </div>
        <div>
          <label className="label">Password</label>
          <input
            required
            type="password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            className="input w-44"
            autoComplete="new-password"
            minLength={8}
          />
        </div>
        <div>
          <label className="label" htmlFor="new-user-minecraft">Minecraft-Name (optional)</label>
          <input id="new-user-minecraft" value={form.minecraftUsername}
            onChange={(e) => setForm({ ...form, minecraftUsername: e.target.value })}
            className="input w-44" autoComplete="off" maxLength={16} pattern="[a-zA-Z0-9_]{3,16}"
            placeholder="z. B. Desmodus" />
        </div>
        <div>
          <label className="label">Role</label>
          <select
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value as "ADMIN" | "USER" })}
            className="input w-32"
          >
            <option value="USER">User</option>
            <option value="ADMIN">Admin</option>
          </select>
        </div>
        <button type="submit" disabled={creating} className="btn btn-primary">
          {creating ? "Creating…" : "Add user"}
        </button>
      </form>

      <div className="card min-w-0 overflow-x-auto">
        <table className="responsive-table w-full text-left text-sm">
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <Th>Username</Th>
              <Th>Minecraft-Name</Th>
              <Th>Role</Th>
              <Th>Status</Th>
              <Th>Last login</Th>
              <Th>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {(users ?? []).map((u) => (
              <tr key={u.id} style={{ borderTop: "1px solid var(--border)" }}>
                <Td label="Benutzer"><span style={{ color: "var(--text)" }} className="font-medium">{u.username}</span></Td>
                <Td secondary>
                  <MinecraftUsernameField user={u} onSaved={(updated) =>
                    setUsers((previous) => previous?.map((entry) => entry.id === updated.id ? updated : entry) ?? null)} />
                </Td>
                <Td label="Rolle">{u.role}</Td>
                <Td label="Status">
                  <span style={{ color: u.status === "ACTIVE" ? "#38bdf8" : "var(--text-subtle)" }}>{u.status}</span>
                </Td>
                <Td secondary>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "Never"}</Td>
                <Td label="Aktionen">
                  <div className="flex gap-1.5">
                    <button onClick={() => void toggleStatus(u)} className="btn btn-secondary btn-sm">
                      {u.status === "ACTIVE" ? "Disable" : "Enable"}
                    </button>
                    <button onClick={() => void remove(u)} className="desktop-only btn btn-danger btn-sm">
                      Delete
                    </button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
        {users?.length === 0 && (
          <div className="p-8 text-center text-sm" style={{ color: "var(--text-subtle)" }}>
            No users yet.
          </div>
        )}
      </div>

      {!compact && <IpBanCard />}
    </div>
  );
}

function MinecraftUsernameField({ user, onSaved }: { user: ManagedUser; onSaved: (user: ManagedUser) => void }) {
  const [value, setValue] = useState(user.minecraftUsername ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const changed = (value.trim() || null) !== user.minecraftUsername;

  useEffect(() => { setValue(user.minecraftUsername ?? ""); }, [user.minecraftUsername]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !changed) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await api.patch<ManagedUser>(`/users/${user.id}`, { minecraftUsername: value.trim() || null });
      onSaved(updated);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Minecraft-Name konnte nicht gespeichert werden");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void save(event)} className="min-w-64">
      <div className="flex items-center gap-2">
        <input value={value} onChange={(event) => { setValue(event.target.value); setSaved(false); setError(null); }}
          aria-label={`Minecraft-Name für ${user.username}`} placeholder="Nicht zugewiesen" disabled={busy}
          className="input w-40" autoComplete="off" spellCheck={false} maxLength={16} pattern="[a-zA-Z0-9_]{3,16}" />
        <button type="submit" disabled={busy || !changed} className="btn btn-secondary btn-sm">
          {busy ? "Speichern…" : "Speichern"}
        </button>
      </div>
      {error && <p className="mt-1 text-xs" role="alert" style={{ color: "var(--danger)" }}>{error}</p>}
      {saved && <p className="mt-1 text-xs" role="status" style={{ color: "var(--text-muted)" }}>Gespeichert</p>}
    </form>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-3 text-xs font-medium uppercase tracking-wide" style={{ color: "var(--text-subtle)" }}>
      {children}
    </th>
  );
}
function Td({ children, label, secondary = false }: { children: React.ReactNode; label?: string; secondary?: boolean }) {
  return (
    <td data-label={label} className={`${secondary ? "desktop-only " : ""}px-4 py-3`} style={{ color: "var(--text-muted)" }}>
      {children}
    </td>
  );
}

function IpBanCard() {
  const [bans, setBans] = useState<BannedIp[] | null>(null);
  const [ip, setIp] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setBans(await api.get<BannedIp[]>("/security/ip-bans"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load IP bans");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function addBan(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/security/ip-bans", { ip: ip.trim(), reason: reason.trim() || undefined });
      setIp("");
      setReason("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to ban IP");
    } finally {
      setBusy(false);
    }
  }

  async function removeBan(addr: string) {
    try {
      await api.delete(`/security/ip-bans/${encodeURIComponent(addr)}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to unban IP");
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold" style={{ color: "var(--text)" }}>
          IP bans
        </h2>
        <p className="mt-0.5 text-sm" style={{ color: "var(--text-muted)" }}>
          Block addresses from reaching the service. Repeated failed logins are
          auto-banned.
        </p>
      </div>

      {error && <p className="alert-error">{error}</p>}

      <form onSubmit={addBan} className="card flex flex-wrap items-end gap-3 p-4" autoComplete="off">
        <div>
          <label className="label">IP address</label>
          <input
            required
            value={ip}
            onChange={(e) => setIp(e.target.value)}
            placeholder="203.0.113.7"
            className="input w-48"
            autoComplete="off"
          />
        </div>
        <div>
          <label className="label">Reason (optional)</label>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="input w-56"
            autoComplete="off"
          />
        </div>
        <button type="submit" disabled={busy} className="btn btn-primary">
          {busy ? "Banning…" : "Ban IP"}
        </button>
      </form>

      <div className="card overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <Th>IP address</Th>
              <Th>Reason</Th>
              <Th>Source</Th>
              <Th>Banned</Th>
              <Th>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {(bans ?? []).map((b) => (
              <tr key={b.ip} style={{ borderTop: "1px solid var(--border)" }}>
                <Td><span style={{ color: "var(--text)" }} className="font-medium">{b.ip}</span></Td>
                <Td>{b.reason || "—"}</Td>
                <Td>{b.auto ? "Auto" : b.createdBy?.username ?? "Manual"}</Td>
                <Td>{new Date(b.createdAt).toLocaleString()}</Td>
                <Td>
                  <button onClick={() => void removeBan(b.ip)} className="btn btn-secondary btn-sm">
                    Unban
                  </button>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
        {bans?.length === 0 && (
          <div className="p-8 text-center text-sm" style={{ color: "var(--text-subtle)" }}>
            No banned IPs.
          </div>
        )}
      </div>
    </div>
  );
}
