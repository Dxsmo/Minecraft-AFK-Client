import { useEffect, useRef, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import type { Note, NoteSummary } from "../lib/notes";
import { NoteEditor, type NoteEditorHandle } from "../components/NoteEditor";

export function NotesPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [note, setNote] = useState<Note | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const editor = useRef<NoteEditorHandle | null>(null);

  async function loadList() {
    try { setNotes(await api.get<NoteSummary[]>("/notes")); }
    catch (err) { setError(err instanceof ApiError ? err.message : "Notizen konnten nicht geladen werden."); }
  }
  useEffect(() => {
    void loadList();
    const refresh = () => { if (document.visibilityState === "visible") void loadList(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setNote(null);
    setError(null);
    if (!id) { setLoading(false); return; }
    setLoading(true);
    void api.get<Note>(`/notes/${id}`).then((value) => { if (!cancelled) setNote(value); })
      .catch((err) => { if (!cancelled) setError(err instanceof ApiError ? err.message : "Notiz konnte nicht geladen werden."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  async function create() {
    if (editor.current && !await editor.current.save()) return;
    setCreating(true);
    setError(null);
    try {
      const created = await api.post<Note>("/notes", {});
      setNotes((prev) => [created, ...prev]);
      navigate(`/notes/${created.id}`);
    } catch (err) { setError(err instanceof ApiError ? err.message : "Notiz konnte nicht erstellt werden."); }
    finally { setCreating(false); }
  }
  function saved(value: NoteSummary) {
    setNotes((prev) => [value, ...prev.filter((entry) => entry.id !== value.id)]);
  }
  async function reload() {
    if (!id) return;
    try { setNote(null); setLoading(true); setNote(await api.get<Note>(`/notes/${id}`)); await loadList(); }
    catch (err) { setError(err instanceof ApiError ? err.message : "Notiz konnte nicht geladen werden."); }
    finally { setLoading(false); }
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-xl font-semibold">Notizen</h1><p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>Deine Gedanken. Gemeinsam, wenn du möchtest.</p></div>
        <button type="button" className="btn btn-primary" disabled={creating} onClick={() => void create()}>+ Neue Notiz</button>
      </header>
      {error && <p role="alert" className="alert-error">{error}</p>}
      <div className={id ? "grid min-w-0 gap-5 lg:grid-cols-[280px_minmax(0,1fr)]" : "min-w-0"}>
        <nav aria-label="Notizenliste" className={id ? "flex gap-3 overflow-x-auto lg:flex-col lg:overflow-visible" : "grid gap-4 sm:grid-cols-2 xl:grid-cols-3"}>
          {notes.map((entry) => <NavLink key={entry.id} to={`/notes/${entry.id}`}
            className={({ isActive }) => `note-list-item ${id ? "w-[280px] shrink-0 lg:w-full" : ""} ${isActive ? "note-list-active" : ""}`}>
            <span className="block min-h-12 line-clamp-2 text-base font-medium" title={entry.title}>{entry.title}</span>
            <span className="mt-3 block truncate text-xs" style={{ color: "var(--text-muted)" }} title={`Erstellt von ${entry.owner.username}`}>Erstellt von {entry.owner.username}</span>
            <span className="mt-2 block truncate text-[11px]" style={{ color: "var(--text-subtle)" }}>
              {entry.shared ? "Geteilt" : "Privat"} · {entry.canWrite ? "Bearbeiten" : "Nur lesen"}
            </span>
          </NavLink>)}
          {!notes.length && <p className="p-3 text-sm" style={{ color: "var(--text-subtle)" }}>Noch keine Notizen.</p>}
        </nav>
        {id && <div className="min-w-0">
          {loading ? <div className="card p-10 text-center text-sm">Notiz wird geladen…</div> : note ? (
            <NoteEditor key={note.id} ref={editor} note={note} onSaved={saved} onReload={() => void reload()}
              onDeleted={() => { setNotes((prev) => prev.filter((entry) => entry.id !== note.id)); navigate("/notes"); }}
              onCopied={(created) => { setNotes((prev) => [created, ...prev]); navigate(`/notes/${created.id}`); }} />
          ) : null}
        </div>}
      </div>
    </div>
  );
}
