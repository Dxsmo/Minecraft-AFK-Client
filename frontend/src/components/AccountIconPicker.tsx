import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

function textureUrl(name: string): string {
  return `/api/assets/item/${encodeURIComponent(name)}.png`;
}

function shortName(name: string): string {
  return name.replace(/_/g, " ");
}

/**
 * Small square button showing the account's chosen Minecraft item/block icon
 * (or a neutral placeholder). Clicking it opens a searchable popover backed by
 * the existing `/api/assets/items` + `/api/assets/item/:name` texture endpoints
 * (the same ones the live inventory view already uses) to pick a new icon, or
 * clear it. Sized to match the dashboard row's visual height.
 */
export function AccountIconPicker({
  accountId,
  iconName,
  onChanged,
  size = 40,
}: {
  accountId: string;
  iconName: string | null;
  onChanged: (iconName: string | null) => void;
  size?: number;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      api
        .get<string[]>(`/assets/items?q=${encodeURIComponent(query.trim())}`)
        .then(setResults)
        .catch(() => setResults([]));
    }, 150);
    return () => clearTimeout(t);
  }, [open, query]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  async function pick(name: string | null) {
    setSaving(true);
    try {
      await api.patch(`/minecraft/accounts/${accountId}`, { iconName: name });
      onChanged(name);
      setOpen(false);
    } catch {
      /* ignore — dashboard reload will resync if this silently failed */
    } finally {
      setSaving(false);
    }
  }

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={iconName ? `Icon: ${shortName(iconName)}` : "Set an icon"}
        aria-label="Set account icon"
        className="flex items-center justify-center rounded-lg border transition-colors"
        style={{
          width: size,
          height: size,
          borderColor: "var(--border)",
          backgroundColor: "var(--surface)",
        }}
      >
        {iconName ? (
          <img
            src={textureUrl(iconName)}
            alt={shortName(iconName)}
            draggable={false}
            style={{ width: size - 12, height: size - 12, imageRendering: "pixelated" }}
          />
        ) : (
          <PlaceholderIcon />
        )}
      </button>

      {open && (
        <div
          className="card absolute left-0 top-full z-20 mt-1.5 w-64 p-2.5 shadow-xl"
          style={{ backgroundColor: "var(--bg-elev)" }}
        >
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search items…"
            className="input w-full text-sm"
          />
          <div className="mt-2 grid max-h-52 grid-cols-6 gap-1 overflow-y-auto">
            {results.map((name) => (
              <button
                key={name}
                type="button"
                title={shortName(name)}
                onClick={() => void pick(name)}
                disabled={saving}
                className="flex items-center justify-center rounded-md p-1 hover:opacity-100"
                style={{ backgroundColor: "var(--surface)", opacity: saving ? 0.5 : 1 }}
              >
                <img src={textureUrl(name)} alt={shortName(name)} draggable={false} style={{ width: 22, height: 22, imageRendering: "pixelated" }} />
              </button>
            ))}
            {results.length === 0 && (
              <p className="col-span-6 py-3 text-center text-xs" style={{ color: "var(--text-subtle)" }}>
                No matches
              </p>
            )}
          </div>
          {iconName && (
            <button
              type="button"
              onClick={() => void pick(null)}
              disabled={saving}
              className="btn btn-ghost btn-sm mt-2 w-full"
            >
              Remove icon
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function PlaceholderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-subtle)" }} aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  );
}
