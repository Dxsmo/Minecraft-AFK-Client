import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";
import type { BannedIp, ManagedUser } from "../lib/types";

export function UsersPage() {
  const [users, setUsers] = useState<ManagedUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ username: "", password: "", role: "USER" as "ADMIN" | "USER" });
  const [creating, setCreating] = useState(false);

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
      setForm({ username: "", password: "", role: "USER" });
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
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold" style={{ color: "var(--text)" }}>
          Users
        </h1>
        <p className="mt-0.5 text-sm" style={{ color: "var(--text-muted)" }}>
          Create users and manage their access
        </p>
      </div>

      {error && <p className="alert-error">{error}</p>}

      <form onSubmit={handleCreate} className="card flex flex-wrap items-end gap-3 p-4" autoComplete="off">
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

      <div className="card overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <Th>Username</Th>
              <Th>Role</Th>
              <Th>Status</Th>
              <Th>Last login</Th>
              <Th>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {(users ?? []).map((u) => (
              <tr key={u.id} style={{ borderTop: "1px solid var(--border)" }}>
                <Td><span style={{ color: "var(--text)" }} className="font-medium">{u.username}</span></Td>
                <Td>{u.role}</Td>
                <Td>
                  <span style={{ color: u.status === "ACTIVE" ? "#38bdf8" : "var(--text-subtle)" }}>{u.status}</span>
                </Td>
                <Td>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "Never"}</Td>
                <Td>
                  <div className="flex gap-1.5">
                    <button onClick={() => void toggleStatus(u)} className="btn btn-secondary btn-sm">
                      {u.status === "ACTIVE" ? "Disable" : "Enable"}
                    </button>
                    <button onClick={() => void remove(u)} className="btn btn-danger btn-sm">
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

      <IpBanCard />
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-3 text-xs font-medium uppercase tracking-wide" style={{ color: "var(--text-subtle)" }}>
      {children}
    </th>
  );
}
function Td({ children }: { children: React.ReactNode }) {
  return (
    <td className="px-4 py-3" style={{ color: "var(--text-muted)" }}>
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
