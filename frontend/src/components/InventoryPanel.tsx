import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

interface InventoryItem {
  id: string;
  count: number;
}

interface InventorySnapshot {
  main: (InventoryItem | null)[];
  hotbar: (InventoryItem | null)[];
  offhand: InventoryItem | null;
  armor: (InventoryItem | null)[];
  mutable: boolean;
  updatedAt: string;
}

/**
 * Raw player-menu slot indices (0..45). The bot accepts these indices for
 * move/drop. Layout: craft(0-4), armor(5-8), storage(9-35), hotbar(36-44),
 * offhand(45). We surface storage, hotbar, armor and offhand.
 */
const mainSlotIndex = (i: number) => 9 + i; // 0..26 -> 9..35
const hotbarSlotIndex = (i: number) => 36 + i; // 0..8 -> 36..44
const armorSlotIndex = (i: number) => 5 + i; // 0..3 -> 5..8
const OFFHAND_SLOT = 45;

const POLL_MS = 2500;

function shortName(id: string): string {
  return id.replace(/^(minecraft|bedrock):/, "").replace(/_/g, " ");
}

/** URL of the real Minecraft texture for an item id (served by the backend). */
function textureUrl(id: string): string {
  const name = id.replace(/^(minecraft|bedrock):/, "");
  return `/api/assets/item/${encodeURIComponent(name)}.png`;
}

function itemColor(id: string): string {
  // Deterministic pastel per item id, used only as a fallback when no texture
  // is available for the id.
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h}, 45%, 32%)`;
}

/** Pad/trim an array to a fixed length so the slot grid never misaligns. */
function fixed<T>(arr: (T | null)[] | undefined, len: number): (T | null)[] {
  const out = (arr ?? []).slice(0, len);
  while (out.length < len) out.push(null);
  return out;
}

/**
 * Renders the real Minecraft texture for an item, falling back to a coloured
 * tile with the item name if the texture 404s (e.g. an unknown Bedrock id).
 */
function ItemIcon({ id }: { id: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: itemColor(id),
        }}
      >
        <span
          style={{
            fontSize: 8,
            lineHeight: 1.05,
            textAlign: "center",
            padding: "0 2px",
            color: "rgba(255,255,255,0.9)",
            textTransform: "capitalize",
            wordBreak: "break-word",
          }}
        >
          {shortName(id).slice(0, 18)}
        </span>
      </div>
    );
  }
  return (
    <img
      src={textureUrl(id)}
      alt={shortName(id)}
      draggable={false}
      onError={() => setFailed(true)}
      style={{ width: 32, height: 32, imageRendering: "pixelated" }}
    />
  );
}

/**
 * Live Minecraft-style inventory with drag & drop. Polls the bot every few
 * seconds so the UI always reflects the bot's *real* inventory: local moves are
 * sent to the bot and the grid is re-synced from the next snapshot rather than
 * being mutated optimistically.
 */
export function InventoryPanel({ accountId, online }: { accountId: string; online: boolean }) {
  const [inv, setInv] = useState<InventorySnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const dragFrom = useRef<number | null>(null);

  const poll = useCallback(async () => {
    try {
      const data = await api.get<{ inventory: InventorySnapshot | null }>(
        `/minecraft/accounts/${accountId}/inventory`,
      );
      setInv(data.inventory);
    } catch {
      /* transient; retry next tick */
    }
  }, [accountId]);

  useEffect(() => {
    if (!online) {
      setInv(null);
      return;
    }
    void poll();
    const t = setInterval(poll, POLL_MS);
    return () => clearInterval(t);
  }, [online, poll]);

  async function move(from: number, to: number) {
    if (from === to) return;
    setBusy(true);
    try {
      await api.post(`/minecraft/accounts/${accountId}/inventory/move`, { from, to });
      // Give the bot a moment to apply + emit, then resync from real state.
      setTimeout(() => void poll(), 500);
    } catch {
      void poll();
    } finally {
      setBusy(false);
    }
  }

  async function drop(slot: number) {
    setBusy(true);
    try {
      await api.post(`/minecraft/accounts/${accountId}/inventory/drop`, { slot });
      setTimeout(() => void poll(), 500);
    } catch {
      void poll();
    } finally {
      setBusy(false);
    }
  }

  if (!online) {
    return (
      <p className="text-sm" style={{ color: "var(--text-subtle)" }}>
        The bot is offline. Start it to view its live inventory.
      </p>
    );
  }

  if (!inv) {
    return (
      <p className="text-sm" style={{ color: "var(--text-subtle)" }}>
        Loading inventory…
      </p>
    );
  }

  const mutable = inv.mutable;

  const onDragStart = (slot: number) => (e: React.DragEvent) => {
    if (!mutable) {
      e.preventDefault();
      return;
    }
    dragFrom.current = slot;
    e.dataTransfer.effectAllowed = "move";
  };
  const onDrop = (slot: number) => (e: React.DragEvent) => {
    e.preventDefault();
    const from = dragFrom.current;
    dragFrom.current = null;
    if (from !== null && mutable) void move(from, slot);
  };
  const allowDrop = (e: React.DragEvent) => {
    if (mutable) e.preventDefault();
  };

  const renderSlot = (item: InventoryItem | null, slotIndex: number, key: string) => (
    <div
      key={key}
      draggable={mutable && !!item}
      onDragStart={onDragStart(slotIndex)}
      onDragOver={allowDrop}
      onDrop={onDrop(slotIndex)}
      onContextMenu={(e) => {
        e.preventDefault();
        if (item && mutable) void drop(slotIndex);
      }}
      title={item ? `${shortName(item.id)} ×${item.count}${mutable ? " · right-click to drop" : ""}` : "Empty"}
      style={{
        position: "relative",
        width: 50,
        height: 50,
        borderRadius: 4,
        border: "2px solid #1f2430",
        backgroundColor: item ? "#20252f" : "#0f131b",
        boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.4)",
        cursor: item && mutable ? "grab" : "default",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      {item && (
        <>
          <ItemIcon id={item.id} />
          {item.count > 1 && (
            <span
              style={{
                position: "absolute",
                right: 2,
                bottom: 0,
                fontSize: 11,
                fontWeight: 700,
                color: "#fff",
                textShadow: "1px 1px 0 #000",
              }}
            >
              {item.count}
            </span>
          )}
        </>
      )}
    </div>
  );

  return (
    <div className="space-y-3">
      {!mutable && (
        <p className="text-xs" style={{ color: "#fbbf24" }}>
          A container is currently open — inventory editing is paused.
        </p>
      )}

      <div
        className="rounded-lg p-3"
        style={{ backgroundColor: "#151a24", border: "1px solid #232a38", opacity: busy ? 0.7 : 1 }}
      >
        {/* Armor + offhand row */}
        <div className="mb-3 flex items-center gap-3">
          <div className="flex gap-1">
            {fixed(inv.armor, 4).map((it, i) => renderSlot(it, armorSlotIndex(i), `a${i}`))}
          </div>
          <div style={{ width: 1, height: 40, backgroundColor: "#232a38" }} />
          {renderSlot(inv.offhand, OFFHAND_SLOT, "off")}
          <span className="text-[10px]" style={{ color: "var(--text-subtle)" }}>
            armor · offhand
          </span>
        </div>

        {/* Main storage: 3 rows of 9 */}
        <div className="grid gap-1" style={{ gridTemplateColumns: "repeat(9, 50px)" }}>
          {fixed(inv.main, 27).map((it, i) => renderSlot(it, mainSlotIndex(i), `m${i}`))}
        </div>

        {/* Hotbar */}
        <div className="mt-2 grid gap-1" style={{ gridTemplateColumns: "repeat(9, 50px)" }}>
          {fixed(inv.hotbar, 9).map((it, i) => renderSlot(it, hotbarSlotIndex(i), `h${i}`))}
        </div>
      </div>

      <p className="text-[11px]" style={{ color: "var(--text-subtle)" }}>
        Drag items between slots to move them on the server. Right-click a stack to drop it.
      </p>
    </div>
  );
}
