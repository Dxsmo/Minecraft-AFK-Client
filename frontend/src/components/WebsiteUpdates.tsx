import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { useWebsiteUpdates } from "../lib/useWebsiteUpdates";

type Updates = ReturnType<typeof useWebsiteUpdates>;

export function WebsiteVersion({ updates, compact = false }: { updates: Updates; compact?: boolean }) {
  const unread = updates.data?.unread ?? false;
  return <div className={`website-version${compact ? " website-version-compact" : ""}`}>
    <span className="version-badge" aria-label="Version V4.2.0">
      <span className="version-icon" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3ZM4 7.5l8 4.5 8-4.5M12 12v9" /></svg></span>
      <span className="version-text">V4.2.0</span>
      <span className="version-spark" aria-hidden="true" />
    </span>
    <button type="button" className={`updates-bell${unread ? " updates-bell-unread" : ""}`}
      aria-label={unread ? "Updates ansehen – neue Updates verfügbar" : "Updates ansehen"}
      aria-haspopup="dialog" aria-expanded={updates.open} aria-controls={updates.open ? "website-updates" : undefined}
      title={unread ? "Neue Updates verfügbar" : "Updates ansehen"} onClick={updates.show}>
      <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4M12 2V1" />
      </svg>
      {unread && <span className="updates-unread-dot" aria-hidden="true" />}
    </button>
  </div>;
}

export function WebsiteUpdatesDialog({ updates }: { updates: Updates }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const onClose = useRef(updates.close);
  onClose.current = updates.close;
  useEffect(() => {
    const node = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    node?.showModal(); document.body.style.overflow = "hidden";
    return () => { node?.close(); document.body.style.overflow = overflow; previous?.focus(); };
  }, []);

  const announcement = updates.data?.announcement;
  return createPortal(<dialog ref={dialog} id="website-updates" className="updates-dialog" aria-labelledby="website-updates-title"
    onCancel={event => { event.preventDefault(); onClose.current(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose.current();
    }}>
    <header className="updates-heading">
      <div><p className="updates-eyebrow">MINECRAFT AFK <span>WAS IST NEU?</span></p>
        <h2 id="website-updates-title">{announcement?.title ?? "Website-Updates"}</h2>
        <p className="updates-introduction">{announcement?.introduction ?? "Die neuesten Änderungen für dich."}</p>
      </div>
      <button type="button" className="updates-close" aria-label="Updates schließen" onClick={updates.close} autoFocus>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
      </button>
    </header>
    <div className="updates-content">
      {updates.loading && !announcement && <p role="status">Updates werden geladen …</p>}
      {updates.error && <div className="updates-error" role="alert"><p>{updates.error}</p><button type="button" className="btn btn-ghost btn-sm" onClick={updates.retry}>Erneut versuchen</button></div>}
      {announcement && <>
        <div className="updates-release"><span className="updates-release-dot" aria-hidden="true" />Das große Account-Update <time dateTime={announcement.date}>{new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(announcement.date))}</time></div>
        <ol className="updates-list">{announcement.items.map((item, index) => <li key={item.title} className="updates-feature">
          <div className={`updates-item-art updates-item-art-${index}`} aria-hidden="true">
            <img src={`/api/assets/account-items/${encodeURIComponent(item.image)}.png`} alt="" width="48" height="48" decoding="async" draggable={false} />
          </div>
          <div><h3>{item.title}</h3><p>{item.description}</p>{item.hint && <p className="updates-hint">{item.hint}</p>}</div>
        </li>)}</ol>
      </>}
    </div>
    <footer className="updates-footer"><p>Du kannst die Updates jederzeit über die Glocke nachlesen.</p><button type="button" className="btn btn-primary btn-sm" onClick={updates.close}>Alles klar</button></footer>
  </dialog>, document.body);
}
