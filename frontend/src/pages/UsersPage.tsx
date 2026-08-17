import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";
import type { ManagedUser } from "../lib/types";

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
        <h1 className="text-xl font-semibold text-slate-100">Users</h1>
        <p className="text-sm text-slate-500">Create users and manage their access</p>
      </div>

      {error && <p className="rounded-md bg-red-950 px-3 py-2 text-sm text-red-400">{error}</p>}

      <form onSubmit={handleCreate} className="card flex flex-wrap items-end gap-3 p-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-300">Username</label>
          <input
            required
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            className="input w-40"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-300">Password</label>
          <input
            required
            type="password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            className="input w-40"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-300">Role</label>
          <select
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value as "ADMIN" | "USER" })}
            className="input w-32"
          >
            <option value="USER">User</option>
            <option value="ADMIN">Admin</option>
          </select>
        </div>
        <button type="submit" disabled={creating} className="btn-primary">
          {creating ? "Creating..." : "Add user"}
        </button>
      </form>

      <div className="card overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-800 bg-slate-900/60 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-3 font-medium">Username</th>
              <th className="px-4 py-3 font-medium">Role</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Last login</th>
              <th className="px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {(users ?? []).map((u) => (
              <tr key={u.id}>
                <td className="px-4 py-3 font-medium text-slate-100">{u.username}</td>
                <td className="px-4 py-3 text-slate-400">{u.role}</td>
                <td className="px-4 py-3">
                  <span className={u.status === "ACTIVE" ? "text-emerald-400" : "text-slate-500"}>{u.status}</span>
                </td>
                <td className="px-4 py-3 text-slate-500">
                  {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "Never"}
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-2">
                    <button onClick={() => void toggleStatus(u)} className="btn-secondary text-xs">
                      {u.status === "ACTIVE" ? "Disable" : "Enable"}
                    </button>
                    <button onClick={() => void remove(u)} className="btn-danger text-xs">
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {users?.length === 0 && <div className="p-8 text-center text-sm text-slate-500">No users yet.</div>}
      </div>
    </div>
  );
}
