import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

// Item/block icon sprites are downloaded once at Docker build time from the
// Minecraft Wiki's "Category:InvSprite files" (every inventory-slot icon the
// wiki has — every item/block, including historical texture revisions,
// chemistry/education items, banner patterns, armor trims, etc.) — see
// scripts/fetch-invicons.mjs and the Dockerfile's "assets-builder" stage.
// The runtime image ships them under ./assets/invicons/<slug>.png alongside a
// manifest.json listing every slug, so the running app needs no network
// access to the wiki.
const ASSETS_DIR = path.resolve(process.cwd(), "assets", "invicons");
const MANIFEST_PATH = path.join(ASSETS_DIR, "manifest.json");

function normalize(name: string): string {
  return name
    .replace(/^minecraft:/i, "")
    .replace(/[^a-z0-9_]/gi, "")
    .toLowerCase();
}

// Decoded PNG buffers are cached (and negative lookups memoised as null) so each
// texture is read from disk at most once.
const cache = new Map<string, Buffer | null>();

/** Returns the PNG bytes for an icon slug, or null if there is no such icon. */
export function getItemTexture(rawName: string): Buffer | null {
  const key = normalize(rawName);
  if (!key) return null;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let buf: Buffer | null = null;
  const file = path.join(ASSETS_DIR, `${key}.png`);
  // Guard against path traversal even though normalize() already strips
  // anything but [a-z0-9_] — belt and suspenders around a user-controlled param.
  if (path.dirname(file) === ASSETS_DIR && existsSync(file)) {
    try {
      buf = readFileSync(file);
    } catch {
      buf = null;
    }
  }
  cache.set(key, buf);
  return buf;
}

let cachedNames: string[] | null = null;

/** Sorted list of every icon slug available, for the icon picker UI. */
export function listItemNames(): string[] {
  if (cachedNames) return cachedNames;
  try {
    const raw = readFileSync(MANIFEST_PATH, "utf-8");
    const names = JSON.parse(raw) as string[];
    cachedNames = Array.isArray(names) ? names.slice().sort() : [];
  } catch {
    cachedNames = [];
  }
  return cachedNames;
}
