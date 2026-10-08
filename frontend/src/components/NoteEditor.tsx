import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { EditorContent, useEditor, useEditorState, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { Note, NoteGrant, NoteSummary } from "../lib/notes";
import { NoteAccessDialog } from "./NoteAccessDialog";

export interface NoteEditorHandle { save: () => Promise<boolean> }
interface Draft { title: string; content: JSONContent; revision: number }
const fingerprint = (draft: Pick<Draft, "title" | "content">) => JSON.stringify([draft.title, draft.content]);

export const NoteEditor = forwardRef<NoteEditorHandle, { note: Note; onSaved: (note: NoteSummary) => void; onReload: () => void; onDeleted: () => void; onCopied: (note: Note) => void }>(
function NoteEditor({ note, onSaved, onReload, onDeleted, onCopied }, ref) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const draftKey = `afk.note-draft.${user?.id}.${note.id}`;
  const [initial] = useState<Draft>(() => {
    try {
      const stored = localStorage.getItem(draftKey);
      if (stored && note.canWrite) {
        const value = JSON.parse(stored);
        if (typeof value.title === "string" && value.content?.type === "doc" && Number.isInteger(value.revision)) return value;
      }
    } catch { /* Local drafts are optional; server storage remains authoritative. */ }
    return { title: note.title, content: note.content, revision: note.revision };
  });
  const draft = useRef<Draft>(initial);
  const saved = useRef(fingerprint(note));
  const revision = useRef(note.revision);
  const mounted = useRef(true);
  const conflict = useRef(initial.revision !== note.revision && fingerprint(initial) !== saved.current);
  const pending = useRef<Promise<boolean> | null>(null);
  const [title, setTitle] = useState(initial.title);
  const [change, setChange] = useState(0);
  const [status, setStatus] = useState(() => fingerprint(initial) === saved.current ? "Gespeichert" : "Nicht gespeichert");
  const [error, setError] = useState<string | null>(conflict.current ? "Die gespeicherte Notiz wurde inzwischen geändert. Dein lokaler Entwurf ist erhalten." : null);
  const [canWrite, setCanWrite] = useState(note.canWrite);
  const [accessOpen, setAccessOpen] = useState(false);
  const [grants, setGrants] = useState(note.grants);
  const [copying, setCopying] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkHref, setLinkHref] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const linkSelection = useRef({ from: 0, to: 0 });
  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: {
      openOnClick: false, defaultProtocol: "https", protocols: ["http", "https", "mailto"], HTMLAttributes: { target: "_blank", rel: "noopener noreferrer" },
      isAllowedUri: (uri) => { try { return ["https:", "http:", "mailto:"].includes(new URL(uri).protocol); } catch { return false; } },
    } })],
    content: initial.content,
    editable: canWrite,
    editorProps: { attributes: { class: "note-rich-text", "aria-label": "Notizinhalt", role: "textbox", "aria-multiline": "true" } },
    onUpdate: ({ editor: current }) => {
      draft.current = { ...draft.current, content: current.getJSON(), revision: revision.current };
      edited();
    },
    onBlur: () => { void save(); },
  });
  const format = useEditorState({ editor, selector: ({ editor: current }) => current ? {
    bold: current.isActive("bold"), italic: current.isActive("italic"), underline: current.isActive("underline"), strike: current.isActive("strike"),
    bulletList: current.isActive("bulletList"), orderedList: current.isActive("orderedList"), blockquote: current.isActive("blockquote"), link: current.isActive("link"),
    heading: [1, 2, 3].find((level) => current.isActive("heading", { level })) ?? 0,
  } : null });

  function persistDraft() {
    try { localStorage.setItem(draftKey, JSON.stringify({ ...draft.current, revision: revision.current })); }
    catch { /* Large notes still save to the server; don't block editing on browser quota. */ }
  }
  function edited() {
    persistDraft();
    setStatus("Nicht gespeichert");
    setChange((value) => value + 1);
  }
  async function save(): Promise<boolean> {
    if (pending.current) return pending.current;
    if (fingerprint(draft.current) === saved.current) return true;
    if (!canWrite || conflict.current) return false;
    pending.current = (async () => {
      try {
        if (mounted.current) { setStatus("Speichert…"); setError(null); }
        // Serialize writes, including edits made while a save is in flight.
        while (fingerprint(draft.current) !== saved.current) {
          const snapshot = { title: draft.current.title, content: draft.current.content };
          const updated = await api.patch<NoteSummary>(`/notes/${note.id}`, { ...snapshot, title: snapshot.title.trim() || "Neue Notiz", revision: revision.current });
          revision.current = updated.revision;
          draft.current.revision = updated.revision;
          saved.current = fingerprint(snapshot);
          if (fingerprint(draft.current) === saved.current) {
            try { localStorage.removeItem(draftKey); } catch { /* optional cache */ }
          } else persistDraft();
          if (mounted.current) onSaved(updated);
        }
        if (mounted.current) setStatus("Gespeichert");
        return true;
      } catch (err) {
        persistDraft();
        if (err instanceof ApiError && err.status === 409) conflict.current = true;
        if (mounted.current) {
          setStatus("Nicht gespeichert");
          setError(err instanceof ApiError ? err.message : "Speichern fehlgeschlagen. Dein Text bleibt hier erhalten.");
          if (err instanceof ApiError && [403, 404].includes(err.status)) setCanWrite(false);
        }
        return false;
      } finally { pending.current = null; }
    })();
    return pending.current;
  }
  useImperativeHandle(ref, () => ({ save }));
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { editor?.setEditable(canWrite); }, [canWrite, editor]);
  useEffect(() => {
    if (!canWrite || conflict.current || fingerprint(draft.current) === saved.current) return;
    const timer = setTimeout(() => { void saveRef.current(); }, 700);
    return () => clearTimeout(timer);
  }, [change, canWrite]);
  useEffect(() => {
    function unload(event: BeforeUnloadEvent) {
      if (fingerprint(draft.current) !== saved.current) { event.preventDefault(); event.returnValue = ""; }
    }
    // Save before SPA links leave the document, including sidebar navigation.
    function linkClick(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || fingerprint(draft.current) === saved.current) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target || anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href);
      if (url.origin !== location.origin || url.href === location.href) return;
      event.preventDefault();
      void save().then((ok) => { if (ok && mounted.current) navigate(url.pathname + url.search + url.hash); });
    }
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", linkClick, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", linkClick, true); };
  });

  async function copyDraft() {
    setCopying(true);
    try {
      const created = await api.post<Note>("/notes", { title: `${draft.current.title.trim() || "Neue Notiz"} (Kopie)`, content: draft.current.content });
      saved.current = fingerprint(draft.current);
      try { localStorage.removeItem(draftKey); } catch { /* optional cache */ }
      onCopied(created);
    } catch (err) { setError(err instanceof ApiError ? err.message : "Kopie konnte nicht gespeichert werden."); }
    finally { if (mounted.current) setCopying(false); }
  }
  async function remove() {
    if (!confirm("Diese Notiz dauerhaft löschen?")) return;
    try {
      await api.delete(`/notes/${note.id}`);
      saved.current = fingerprint(draft.current);
      try { localStorage.removeItem(draftKey); } catch { /* optional cache */ }
      onDeleted();
    }
    catch (err) { setError(err instanceof ApiError ? err.message : "Notiz konnte nicht gelöscht werden."); }
  }
  function reload() {
    if (fingerprint(draft.current) !== saved.current && !confirm("Aktuelle Version laden und deinen lokalen Entwurf verwerfen?")) return;
    saved.current = fingerprint(draft.current);
    try { localStorage.removeItem(draftKey); } catch { /* optional cache */ }
    onReload();
  }
  function shareSaved(value: NoteGrant[]) {
    setGrants(value);
    onSaved({ ...note, title: title.trim() || "Neue Notiz", revision: revision.current, grants: value, shared: value.length > 0 });
  }
  function link() {
    if (!editor) return;
    linkSelection.current = { from: editor.state.selection.from, to: editor.state.selection.to };
    setLinkHref(editor.getAttributes("link").href ?? "https://");
    setLinkError(null);
    setLinkOpen(true);
  }
  function applyLink() {
    if (!editor) return;
    const chain = editor.chain().focus().setTextSelection(linkSelection.current).extendMarkRange("link");
    if (!linkHref.trim()) { chain.unsetLink().run(); setLinkOpen(false); return; }
    try {
      const url = new URL(linkHref);
      if (!["https:", "http:", "mailto:"].includes(url.protocol)) throw new Error();
      chain.setLink({ href: url.href }).run();
      setLinkOpen(false);
    } catch { setLinkError("Bitte gib eine gültige https-, http- oder mailto-Adresse ein."); }
  }

  return <section className="space-y-3" aria-label="Geöffnete Notiz">
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs" style={{ color: "var(--text-muted)" }}>
      <span>{canWrite ? status : "Nur lesen"} · {note.isOwner ? (grants.length ? "Geteilt" : "Privat") : `Von ${note.owner.username}`}</span>
      <div className="flex items-center gap-1">
        {canWrite && <button className="btn btn-ghost btn-sm" disabled={status === "Speichert…" || conflict.current} onClick={() => void save()}>Speichern</button>}
        {note.isOwner && <><button className="btn btn-secondary btn-sm" onClick={() => setAccessOpen(true)}>Zugriff</button><button className="btn btn-ghost btn-sm" onClick={() => void remove()} aria-label="Notiz löschen">Löschen</button></>}
      </div>
    </div>
    {error && <div role="alert" className="alert-error"><p>{error}</p><div className="mt-2 flex flex-wrap gap-2">
      <button className="btn btn-secondary btn-sm" disabled={copying} onClick={() => void copyDraft()}>Entwurf als neue Notiz speichern</button>
      <button className="btn btn-ghost btn-sm" onClick={reload}>Aktuelle Version laden</button>
    </div></div>}
    {canWrite && editor && <div className="note-toolbar" role="toolbar" aria-label="Textformatierung">
      <select aria-label="Absatzformat" value={format?.heading ?? 0} className="note-format-select" onChange={(event) => {
        const level = Number(event.target.value);
        if (level === 0) editor.chain().focus().setParagraph().run();
        else editor.chain().focus().toggleHeading({ level: level as 1 | 2 | 3 }).run();
      }}><option value="0">Text</option><option value="1">Überschrift 1</option><option value="2">Überschrift 2</option><option value="3">Überschrift 3</option></select>
      <FormatButton label="Fett" active={format?.bold} onClick={() => editor.chain().focus().toggleBold().run()}><strong>B</strong></FormatButton>
      <FormatButton label="Kursiv" active={format?.italic} onClick={() => editor.chain().focus().toggleItalic().run()}><em>I</em></FormatButton>
      <FormatButton label="Unterstrichen" active={format?.underline} onClick={() => editor.chain().focus().toggleUnderline().run()}><u>U</u></FormatButton>
      <FormatButton label="Durchgestrichen" active={format?.strike} onClick={() => editor.chain().focus().toggleStrike().run()}><s>S</s></FormatButton>
      <span className="note-toolbar-divider" aria-hidden="true" />
      <FormatButton label="Aufzählung" active={format?.bulletList} onClick={() => editor.chain().focus().toggleBulletList().run()}>• ≡</FormatButton>
      <FormatButton label="Nummerierte Liste" active={format?.orderedList} onClick={() => editor.chain().focus().toggleOrderedList().run()}>1. ≡</FormatButton>
      <FormatButton label="Zitat" active={format?.blockquote} onClick={() => editor.chain().focus().toggleBlockquote().run()}>“</FormatButton>
      <FormatButton label="Link" active={format?.link} onClick={link}>↗</FormatButton>
      <span className="note-toolbar-divider" aria-hidden="true" />
      <FormatButton label="Rückgängig" onClick={() => editor.chain().focus().undo().run()}>↶</FormatButton>
      <FormatButton label="Wiederholen" onClick={() => editor.chain().focus().redo().run()}>↷</FormatButton>
    </div>}
    <article className="note-paper">
      {canWrite ? <input aria-label="Titel der Notiz" value={title} placeholder="Neue Notiz" className="note-title" onBlur={() => void save()}
        onChange={(event) => { setTitle(event.target.value); draft.current = { ...draft.current, title: event.target.value }; edited(); }} /> : <h2 className="note-title">{title}</h2>}
      <EditorContent editor={editor} />
    </article>
    {accessOpen && <NoteAccessDialog noteId={note.id} grants={grants} onClose={() => setAccessOpen(false)} onSaved={shareSaved} />}
    {linkOpen && <dialog className="note-access-dialog" aria-label="Link bearbeiten" ref={(element) => { if (element && !element.open) element.showModal(); }}
      onCancel={(event) => { event.preventDefault(); setLinkOpen(false); }}>
      <form className="p-6" onSubmit={(event) => { event.preventDefault(); applyLink(); }}>
        <h2 className="text-lg font-semibold">Link bearbeiten</h2>
        <label className="label mt-4" htmlFor={`note-link-${note.id}`}>Link-Adresse</label>
        <input id={`note-link-${note.id}`} className="input" autoFocus value={linkHref} onChange={(event) => setLinkHref(event.target.value)} placeholder="https://…" />
        <p className="mt-2 text-xs" style={{ color: "var(--text-subtle)" }}>Leere Adresse entfernt den Link.</p>
        {linkError && <p role="alert" className="alert-error mt-3">{linkError}</p>}
        <div className="mt-5 flex justify-end gap-2"><button type="button" className="btn btn-ghost" onClick={() => setLinkOpen(false)}>Abbrechen</button><button className="btn btn-primary" type="submit">Übernehmen</button></div>
      </form>
    </dialog>}
  </section>;
});

function FormatButton({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" className="note-format-button" title={label} aria-label={label} aria-pressed={active}
    onMouseDown={(event) => event.preventDefault()} onClick={onClick}>{children}</button>;
}
