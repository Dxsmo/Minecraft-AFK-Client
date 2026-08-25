import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";

function textureUrl(name: string): string {
  return `/api/assets/item/${encodeURIComponent(name)}.png`;
}

function displayName(name: string): string {
  return name.replace(/_/g, " ");
}

// The full catalogue is ~5.1k icons (every inventory sprite the Minecraft
// Wiki has). Rendering that many <img> tags at once would be slow, so the
// grid only ever renders a bounded slice — search already narrows results
// down to a manageable, relevant set for any real query.
const MAX_RENDERED_RESULTS = 200;

/**
 * Small square button showing the account's chosen Minecraft item/block icon
 * (or a neutral placeholder). Clicking it opens a searchable popover backed by
 * the existing `/api/assets/items` + `/api/assets/item/:name` texture endpoints
 * (the same ones the live inventory view already uses) to pick a new icon, or
 * clear it. Sized to match the dashboard row's visual height.
 *
 * The popover itself is rendered through a portal into `document.body` and
 * positioned with `position: fixed` from the trigger button's own bounding
 * box. This deliberately avoids relying on the surrounding row's stacking
 * order/overflow — a sibling dashboard row re-establishes its own stacking
 * context on hover (via its card-hover transform), which would otherwise
 * paint on top of an absolutely-positioned popover nested in an earlier row.
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
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      api
        .get<string[]>(`/assets/items?q=${encodeURIComponent(trimmed)}`)
        .then(setResults)
        .catch(() => setResults([]));
    }, 150);
    return () => clearTimeout(t);
  }, [open, query]);

  // Position the portal popover just under the trigger button, flipping to
  // the left edge if it would otherwise overflow the viewport.
  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const width = 272;
    const left = Math.min(rect.left, window.innerWidth - width - 12);
    setPos({ top: rect.bottom + 6, left: Math.max(8, left) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDocPointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onScrollOrResize() {
      if (!buttonRef.current) return;
      const rect = buttonRef.current.getBoundingClientRect();
      const width = 272;
      const left = Math.min(rect.left, window.innerWidth - width - 12);
      setPos({ top: rect.bottom + 6, left: Math.max(8, left) });
    }
    document.addEventListener("mousedown", onDocPointerDown);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("mousedown", onDocPointerDown);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
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
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={iconName ? `Icon: ${displayName(iconName)}` : "Set an icon"}
        aria-label="Set account icon"
        className="icon-picker-trigger flex shrink-0 items-center justify-center rounded-lg border transition-all"
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
            alt={displayName(iconName)}
            draggable={false}
            style={{ width: size - 12, height: size - 12, imageRendering: "pixelated" }}
          />
        ) : (
          <PlaceholderIcon />
        )}
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={popoverRef}
            className="card fixed z-50 w-[272px] p-2.5 shadow-2xl animate-fadein"
            style={{ top: pos.top, left: pos.left, backgroundColor: "var(--bg-elev)" }}
          >
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search items… (e.g. diamond sword)"
              className="input w-full text-sm"
            />
            <div className="mt-2 grid max-h-64 grid-cols-6 gap-1 overflow-y-auto">
              {results.slice(0, MAX_RENDERED_RESULTS).map((name) => (
                <button
                  key={name}
                  type="button"
                  title={displayName(name)}
                  onClick={() => void pick(name)}
                  disabled={saving}
                  className="flex items-center justify-center rounded-md p-1 transition-colors hover:opacity-100"
                  style={{
                    backgroundColor: name === iconName ? "var(--accent-soft)" : "var(--surface)",
                    opacity: saving ? 0.5 : 1,
                    boxShadow: name === iconName ? "0 0 0 1px var(--accent)" : undefined,
                  }}
                >
                  <img
                    src={textureUrl(name)}
                    alt={displayName(name)}
                    draggable={false}
                    loading="lazy"
                    style={{ width: 22, height: 22, imageRendering: "pixelated" }}
                  />
                </button>
              ))}
              {!query.trim() && (
                <p className="col-span-6 py-3 text-center text-xs" style={{ color: "var(--text-subtle)" }}>
                  Type to search 5,073 icons…
                </p>
              )}
              {query.trim() !== "" && results.length === 0 && (
                <p className="col-span-6 py-3 text-center text-xs" style={{ color: "var(--text-subtle)" }}>
                  No matches
                </p>
              )}
            </div>
            {results.length > MAX_RENDERED_RESULTS && (
              <p className="mt-1 text-center text-[11px]" style={{ color: "var(--text-subtle)" }}>
                Showing first {MAX_RENDERED_RESULTS} of {results.length} — refine your search
              </p>
            )}
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
          </div>,
          document.body,
        )}
    </>
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
