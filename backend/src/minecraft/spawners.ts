/**
 * Catalog of supported mob spawners and the item types each one produces.
 *
 * A spawner's contents are handled per item type: every produced item can be
 * dropped out of the spawner, sold via the spawner's own sell button, or left
 * alone. Dropping always runs before selling, and both stop once fewer than two
 * stacks of that item remain (see the Rust bot's clean-spawner routine).
 *
 * Keep this list in sync with `frontend/src/lib/spawners.ts`.
 */
export type SpawnerAction = "keep" | "drop" | "sell";

export interface SpawnerItem {
  /** Minecraft item id as reported by the bot, e.g. "minecraft:beef". */
  id: string;
  label: string;
}

export interface SpawnerType {
  id: string;
  label: string;
  items: SpawnerItem[];
}

export const SPAWNER_TYPES: SpawnerType[] = [
  { id: "cow", label: "Cow", items: [{ id: "minecraft:beef", label: "Raw Beef" }] },
  { id: "iron_golem", label: "Iron Golem", items: [{ id: "minecraft:iron_ingot", label: "Iron Ingot" }] },
  {
    id: "spider",
    label: "Spider",
    items: [
      { id: "minecraft:string", label: "String" },
      { id: "minecraft:spider_eye", label: "Spider Eye" },
    ],
  },
  {
    id: "zombified_piglin",
    label: "Zombified Piglin",
    items: [
      { id: "minecraft:gold_nugget", label: "Gold Nugget" },
      { id: "minecraft:rotten_flesh", label: "Rotten Flesh" },
    ],
  },
  {
    id: "skeleton",
    label: "Skeleton",
    items: [
      { id: "minecraft:bone", label: "Bone" },
      { id: "minecraft:arrow", label: "Arrow" },
    ],
  },
  { id: "creeper", label: "Creeper", items: [{ id: "minecraft:gunpowder", label: "Gunpowder" }] },
  { id: "blaze", label: "Blaze", items: [{ id: "minecraft:blaze_powder", label: "Blaze Powder" }] },
];

export const SPAWNER_TYPE_IDS = SPAWNER_TYPES.map((s) => s.id);

export function getSpawnerType(id: string): SpawnerType | undefined {
  return SPAWNER_TYPES.find((s) => s.id === id);
}

/**
 * Resolves the configured per-item actions into the two flat item-id lists the
 * Rust bot works with. Only items that actually belong to the selected spawner
 * type are considered, so a stale action map can never make the bot touch an
 * unrelated item.
 */
export function resolveSpawnerActions(
  spawnerType: string,
  actions: Record<string, SpawnerAction>,
): { dropItems: string[]; sellItems: string[] } {
  const type = getSpawnerType(spawnerType);
  if (!type) return { dropItems: [], sellItems: [] };
  const dropItems: string[] = [];
  const sellItems: string[] = [];
  for (const item of type.items) {
    const action = actions[item.id];
    if (action === "drop") dropItems.push(item.id);
    else if (action === "sell") sellItems.push(item.id);
  }
  return { dropItems, sellItems };
}

/** Parses the JSON-encoded per-item action map, dropping unknown values. */
export function parseSpawnerActions(raw: string): Record<string, SpawnerAction> {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out: Record<string, SpawnerAction> = {};
    for (const [key, action] of Object.entries(value)) {
      if (action === "drop" || action === "sell" || action === "keep") out[key] = action;
    }
    return out;
  } catch {
    return {};
  }
}
