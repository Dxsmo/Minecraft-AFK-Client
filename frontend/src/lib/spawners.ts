/**
 * Supported mob spawners and the item types each one produces.
 *
 * Mirrors `backend/src/minecraft/spawners.ts` — keep both lists in sync. The
 * backend resolves the per-item actions into the drop/sell lists it sends to
 * the bot, so anything added here must exist there too.
 */
export type SpawnerAction = "keep" | "drop" | "sell";

export interface SpawnerItem {
  id: string;
  label: string;
}

export interface SpawnerTypeDef {
  id: string;
  label: string;
  /** Emoji shown in the picker — cheap, dependency-free visual anchor. */
  emoji: string;
  items: SpawnerItem[];
}

export const SPAWNER_TYPES: SpawnerTypeDef[] = [
  { id: "cow", label: "Cow", emoji: "🐄", items: [{ id: "minecraft:beef", label: "Raw Beef" }] },
  {
    id: "iron_golem",
    label: "Iron Golem",
    emoji: "🗿",
    items: [{ id: "minecraft:iron_ingot", label: "Iron Ingot" }],
  },
  {
    id: "spider",
    label: "Spider",
    emoji: "🕷️",
    items: [
      { id: "minecraft:string", label: "String" },
      { id: "minecraft:spider_eye", label: "Spider Eye" },
    ],
  },
  {
    id: "zombified_piglin",
    label: "Zombified Piglin",
    emoji: "🐖",
    items: [
      { id: "minecraft:gold_nugget", label: "Gold Nugget" },
      { id: "minecraft:rotten_flesh", label: "Rotten Flesh" },
    ],
  },
  {
    id: "skeleton",
    label: "Skeleton",
    emoji: "💀",
    items: [
      { id: "minecraft:bone", label: "Bone" },
      { id: "minecraft:arrow", label: "Arrow" },
    ],
  },
  {
    id: "creeper",
    label: "Creeper",
    emoji: "💥",
    items: [{ id: "minecraft:gunpowder", label: "Gunpowder" }],
  },
  {
    id: "blaze",
    label: "Blaze",
    emoji: "🔥",
    items: [{ id: "minecraft:blaze_powder", label: "Blaze Powder" }],
  },
];

export function getSpawnerType(id: string): SpawnerTypeDef | undefined {
  return SPAWNER_TYPES.find((s) => s.id === id);
}

/** URL of the real Minecraft texture for an item id (served by the backend). */
export function spawnerItemTexture(id: string): string {
  return `/api/assets/item/${encodeURIComponent(id.replace(/^minecraft:/, ""))}.png`;
}
