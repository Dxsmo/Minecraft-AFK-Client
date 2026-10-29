import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, ApiError } from "../lib/api";

/** Normalize photos locally; the server only stores a small, validated PNG. */
async function prepareImage(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp|gif|avif)$/.test(file.type)) {
    throw new Error("Choose a PNG, JPEG, WebP, GIF or AVIF image.");
  }
  if (file.size > 10 * 1024 * 1024) throw new Error("The image must be smaller than 10 MB.");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not prepare the image.");
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
    return canvas.toDataURL("image/png").split(",")[1];
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function AccountImageButton({ accountId, imageUrl, blurred, onUpdated, onError }: {
  accountId: string;
  imageUrl: string | null;
  blurred: boolean;
  onUpdated: (update: { id: string; imageUrl: string }) => void;
  onError: (message: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Array<{ id: string; name: string; url: string }>>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [visible, setVisible] = useState(120);
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal(); search.current?.focus();
    let cancelled = false;
    setLoading(true); setCatalogError(null);
    void api.get<Array<{ id: string; name: string; url: string }>>("/minecraft/account-items")
      .then(result => { if (!cancelled) setItems(result); })
      .catch(() => { if (!cancelled) setCatalogError("Die Item-Auswahl konnte nicht geladen werden."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; previous?.focus(); };
  }, [open]);

  async function selectItem(itemId: string) {
    setUploading(true); setCatalogError(null);
    try {
      onUpdated(await api.put<{ id: string; imageUrl: string }>(`/minecraft/accounts/${accountId}/image`, { itemId }));
      setFailedUrl(null); setOpen(false);
    } catch (err) {
      setCatalogError(err instanceof Error ? err.message : "Das Item konnte nicht gespeichert werden.");
    } finally { setUploading(false); }
  }

  async function upload(file: File) {
    setUploading(true);
    try {
      const image = await prepareImage(file);
      onUpdated(await api.put<{ id: string; imageUrl: string }>(`/minecraft/accounts/${accountId}/image`, { image }));
      setFailedUrl(null);
      setOpen(false);
    } catch (err) {
      const message = err instanceof ApiError || err instanceof Error ? err.message : "Could not upload the image.";
      setCatalogError(message); onError(message);
    } finally {
      setUploading(false);
    }
  }

  const label = "Account-Bild auswählen";
  const terms = query.toLocaleLowerCase().replace(/_/g, " ").trim().split(/\s+/);
  const filtered = items.filter(item => terms.every(term => item.name.toLocaleLowerCase().includes(term)));
  return (
    <div className="account-image-control relative z-20">
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void upload(file);
        }} />
      <button type="button" className="account-image-button" title={label} aria-label={label}
        aria-busy={uploading} disabled={uploading} onClick={() => { setQuery(""); setVisible(120); setOpen(true); }}>
        {imageUrl && failedUrl !== imageUrl ? (
          <img src={imageUrl} alt="" className="h-full w-full object-contain p-1" draggable={false} loading="lazy" decoding="async"
            style={{ filter: blurred ? "blur(8px)" : undefined }} onError={() => setFailedUrl(imageUrl)} />
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
        )}
        {uploading && <span className="absolute inset-0 grid place-items-center bg-black/45" aria-hidden="true">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
        </span>}
      </button>
      {open && createPortal(
        <dialog ref={dialog} aria-labelledby={`item-picker-${accountId}`} className="item-picker card m-auto w-[min(42rem,calc(100vw-2rem))] p-0 backdrop:bg-black/65"
          style={{ color: "var(--text)", backgroundColor: "var(--surface)", border: "1px solid var(--border-strong)", boxShadow: "0 24px 80px rgba(0,0,0,.45)" }}
          onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!uploading) setOpen(false); } }}
          onCancel={event => { event.preventDefault(); if (!uploading) setOpen(false); }}
          onClick={event => { if (event.target === event.currentTarget && !uploading) { const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) setOpen(false); } }}>
          <div className="flex items-center justify-between gap-3 border-b p-5" style={{ borderColor: "var(--border)" }}>
            <div><h2 id={`item-picker-${accountId}`} className="font-semibold">Account-Bild auswählen</h2>
              <p className="mt-1 text-xs" style={{ color: "var(--text-subtle)" }}>Wähle ein Minecraft-Item für diesen Account.</p></div>
            <button type="button" className="btn btn-ghost" aria-label="Auswahl schließen" disabled={uploading} onClick={() => setOpen(false)}>✕</button>
          </div>
          <div className="px-5 pt-4"><input ref={search} type="search" aria-label="Items suchen" className="input w-full" placeholder="Item suchen, z. B. diamond sword …"
            value={query} onChange={event => { setQuery(event.target.value); setVisible(120); }} />
            <div className="my-3 text-xs" style={{ color: "var(--text-subtle)" }}>{filtered.length} Items · A–Z</div>
            {catalogError && <p className="alert-error mb-3" role="alert">{catalogError}</p>}
          </div>
          <div className="max-h-[min(52vh,28rem)] overflow-y-auto px-5 pb-5">
            {loading ? <p className="py-8 text-center text-sm">Items werden geladen …</p> : filtered.length === 0 ? <p className="py-8 text-center text-sm">Keine passenden Items gefunden.</p> : (
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                {filtered.slice(0, visible).map(item => <button key={item.id} type="button" title={item.name} disabled={uploading}
                  className="flex min-w-0 flex-col items-center gap-2 rounded-lg border p-2 transition-colors hover:bg-white/5 focus-visible:ring-2"
                  style={{ borderColor: "var(--border)" }} onClick={() => void selectItem(item.id)}>
                  <img src={item.url} alt="" width="48" height="48" loading="lazy" decoding="async" draggable={false} className="h-12 w-12 object-contain" style={{ imageRendering: "pixelated" }} />
                  <span className="line-clamp-2 w-full text-center text-[10px] leading-tight">{item.name}</span>
                </button>)}
              </div>
            )}
            {filtered.length > visible && <button type="button" className="btn btn-ghost mt-4 w-full" onClick={() => setVisible(value => value + 120)}>Weitere Items anzeigen</button>}
          </div>
          <div className="flex justify-between gap-3 border-t px-5 py-3" style={{ borderColor: "var(--border)" }}>
            <button type="button" className="btn btn-ghost" disabled={uploading} onClick={() => input.current?.click()}>Eigenes Bild hochladen</button>
            <button type="button" className="btn btn-ghost" disabled={uploading} onClick={() => setOpen(false)}>Abbrechen</button>
          </div>
        </dialog>, document.body)}
    </div>
  );
}
