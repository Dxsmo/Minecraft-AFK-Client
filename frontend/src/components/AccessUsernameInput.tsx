import { useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";

export type AccessUser = { id: string; username: string };

export function AccessUsernameInput({ endpoint, disabled, onAdd }: {
  endpoint: string; disabled?: boolean; onAdd: (user: AccessUser) => string | undefined;
}) {
  const [username, setUsername] = useState("");
  const [checking, setChecking] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  async function add(event: FormEvent) {
    event.preventDefault();
    if (!username.trim() || checking || disabled) return;
    setChecking(true); setFeedback(null);
    try {
      const found = await api.post<AccessUser>(endpoint, { username: username.trim() });
      const message = onAdd(found);
      setFeedback(message ?? `${found.username} hinzugefügt. Bitte speichern, um den Zugriff freizugeben.`);
      if (!message) setUsername("");
    } catch (err) { setFeedback(err instanceof ApiError ? err.message : "Benutzername konnte nicht geprüft werden."); }
    finally { setChecking(false); }
  }
  return <div className="my-4">
    <form onSubmit={(event) => void add(event)} className="flex gap-2">
      <input className="input min-w-0" aria-label="Benutzername hinzufügen" placeholder="Benutzername eingeben" autoComplete="off" maxLength={64}
        value={username} disabled={disabled || checking} onChange={(event) => { setUsername(event.target.value); setFeedback(null); }} />
      <button type="submit" className="btn btn-secondary shrink-0" disabled={disabled || checking || !username.trim()}>{checking ? "Prüft…" : "Hinzufügen"}</button>
    </form>
    {feedback && <p role="status" className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>{feedback}</p>}
  </div>;
}
