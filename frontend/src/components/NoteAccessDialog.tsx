import { useId, useState } from "react";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { NoteGrant, NoteUser } from "../lib/notes";
import { AccessUsernameInput } from "./AccessUsernameInput";

export function NoteAccessDialog({ noteId, grants, onClose, onSaved }: {
  noteId: string; grants: NoteGrant[]; onClose: () => void; onSaved: (grants: NoteGrant[]) => void;
}) {
  const { user } = useAuth();
  const headingId = useId();
  const [users, setUsers] = useState<NoteUser[]>(() => grants.map((grant) => grant.user));
  const [access, setAccess] = useState<Record<string, "none" | "read" | "write">>(() => Object.fromEntries(grants.map((grant) => [grant.userId, grant.canWrite ? "write" : "read"])));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true); setError(null);
    try {
      const selected = Object.entries(access).filter(([, value]) => value !== "none").map(([userId, value]) => ({ userId, canWrite: value === "write" }));
      onSaved(await api.put<NoteGrant[]>(`/notes/${noteId}/access`, { users: selected }));
      onClose();
    } catch (err) { setError(err instanceof ApiError ? err.message : "Zugriff konnte nicht gespeichert werden."); }
    finally { setSaving(false); }
  }

  return <dialog ref={(element) => { if (element && !element.open) element.showModal(); }} className="note-access-dialog" aria-labelledby={headingId} onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}>
    <div className="p-6">
      <h2 id={headingId} className="text-lg font-semibold">Zugriff verwalten</h2>
      <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>Du bleibst der Ersteller. Nur du kannst Freigaben ändern.</p>
      <AccessUsernameInput endpoint={`/notes/${noteId}/access/lookup`} disabled={saving} onAdd={(entry) => {
        if (entry.id === user?.id) return "Du hast als Ersteller bereits Zugriff.";
        if (users.some((existing) => existing.id === entry.id)) return "Dieser Benutzer ist bereits aufgelistet.";
        setUsers((prev) => [...prev, entry]);
        setAccess((prev) => ({ ...prev, [entry.id]: "read" }));
      }} />
      <div className="mt-3 max-h-80 space-y-1 overflow-y-auto">
        {!users.length && <p className="py-3 text-sm" style={{ color: "var(--text-subtle)" }}>Noch keine Freigaben.</p>}
        {users.map((entry) => (
          <label key={entry.id} className="flex items-center justify-between gap-4 rounded-lg py-2">
            <span className="min-w-0 truncate text-sm">{entry.username}</span>
            <select aria-label={`Zugriff für ${entry.username}`} className="input !w-auto text-sm" value={access[entry.id] ?? "none"} disabled={saving}
              onChange={(event) => setAccess((prev) => ({ ...prev, [entry.id]: event.target.value as "none" | "read" | "write" }))}>
              <option value="none">Kein Zugriff</option><option value="read">Nur lesen</option><option value="write">Lesen & schreiben</option>
            </select>
          </label>
        ))}
      </div>
      {error && <p role="alert" className="alert-error mt-3">{error}</p>}
      <div className="mt-5 flex justify-end gap-2"><button className="btn btn-ghost" disabled={saving} onClick={onClose}>Abbrechen</button><button className="btn btn-primary" disabled={saving} onClick={() => void save()}>{saving ? "Speichert…" : "Speichern"}</button></div>
    </div>
  </dialog>;
}
