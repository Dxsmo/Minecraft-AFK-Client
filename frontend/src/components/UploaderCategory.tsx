import type { ReactNode } from "react";

interface UploaderCategoryProps {
  id: string;
  username: string;
  count: number;
  expanded: boolean;
  index: number;
  total: number;
  onToggle: () => void;
  onMove: (direction: -1 | 1) => void;
  children: ReactNode;
}

export function UploaderCategory({ id, username, count, expanded, index, total,
  onToggle, onMove, children }: UploaderCategoryProps) {
  const contentId = `uploader-accounts-${id}`;
  return (
    <section className="uploader-category" data-uploader-id={id} data-expanded={expanded}>
      <div className="uploader-header card">
        <div className="uploader-sort" aria-label={`Reihenfolge von ${username}`}>
          <button type="button" className="btn btn-ghost btn-sm" disabled={index === 0}
            onClick={() => onMove(-1)} title="Kategorie nach oben" aria-label={`${username}: Kategorie nach oben`}>↑</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={index === total - 1}
            onClick={() => onMove(1)} title="Kategorie nach unten" aria-label={`${username}: Kategorie nach unten`}>↓</button>
        </div>
        <h2 className="min-w-0 flex-1">
          <button type="button" className="uploader-toggle" onClick={onToggle}
            aria-label={`Accounts von ${username}`} aria-expanded={expanded} aria-controls={contentId}>
            <svg className="uploader-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
            <span className="truncate font-medium" title={username}>{username}</span>
            <span className="uploader-count">{count} {count === 1 ? "Account" : "Accounts"}</span>
          </button>
        </h2>
      </div>
      <div id={contentId} className="uploader-content" inert={!expanded} aria-hidden={!expanded}>
        <div className="uploader-clip">
          <div className="uploader-accounts space-y-2.5">
            {count ? children : <p className="px-3 py-2 text-sm" style={{ color: "var(--text-subtle)" }}>Keine Accounts hochgeladen.</p>}
          </div>
        </div>
      </div>
    </section>
  );
}
