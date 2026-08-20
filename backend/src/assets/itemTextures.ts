import mcAssets from "minecraft-assets";

// The item/block textures come from the `minecraft-assets` package (installed
// via npm into node_modules — NOT committed to this repo). A single recent
// version is used; item names are stable enough across versions that this works
// for any bot version. `textureContent` is a unified map covering both items and
// blocks, so most inventory ids resolve to a flat 16x16 PNG.
const ASSET_VERSION = "1.20.2";
const assets = mcAssets(ASSET_VERSION);

// Decoded PNG buffers are cached (and negative lookups memoised as null) so each
// texture is base64-decoded at most once.
const cache = new Map<string, Buffer | null>();

function normalize(name: string): string {
  return name
    .replace(/^minecraft:/i, "")
    .replace(/[^a-z0-9_]/gi, "")
    .toLowerCase();
}

/** Returns the PNG bytes for an item/block id, or null if there is no texture. */
export function getItemTexture(rawName: string): Buffer | null {
  const key = normalize(rawName);
  if (!key) return null;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let buf: Buffer | null = null;
  const dataUrl = assets?.textureContent?.[key]?.texture;
  if (dataUrl && dataUrl.startsWith("data:")) {
    const comma = dataUrl.indexOf(",");
    if (comma !== -1) buf = Buffer.from(dataUrl.slice(comma + 1), "base64");
  }
  cache.set(key, buf);
  return buf;
}
