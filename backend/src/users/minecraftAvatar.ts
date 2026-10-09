import { decodeAccountImage } from "../accounts/images.js";

const MAX_BYTES = 64 * 1024;
const MAX_ENTRIES = 128;
const cache = new Map<string, { expiresAt: number; image: Promise<Buffer | null> }>();

/** Fetch only a fixed PNG endpoint; never forward cookies or follow redirects. */
async function fetchAvatar(username: string): Promise<Buffer | null> {
  try {
    const response = await fetch(`https://mc-heads.net/avatar/${encodeURIComponent(username)}/32`, {
      signal: AbortSignal.timeout(5000), redirect: "error", headers: { Accept: "image/png" },
    });
    if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0] !== "image/png" ||
        Number(response.headers.get("content-length")) > MAX_BYTES || !response.body) {
      await response.body?.cancel();
      return null;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const data = Buffer.concat(chunks);
    // Check dimensions before decompression, verify PNG CRC and strip metadata.
    if (data.length < 24 || data.readUInt32BE(16) !== 32 || data.readUInt32BE(20) !== 32) return null;
    return decodeAccountImage(data.toString("base64"));
  } catch {
    return null;
  }
}

/** Bounded server cache also coalesces simultaneous requests for one uploader. */
export async function getMinecraftAvatar(username: string): Promise<Buffer | null> {
  if (!/^[a-zA-Z0-9_]{3,16}$/.test(username)) return null;
  const key = username.toLowerCase();
  const existing = cache.get(key);
  if (existing && existing.expiresAt > Date.now()) return existing.image;
  cache.delete(key);
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  const entry = { expiresAt: Date.now() + 60_000, image: fetchAvatar(username) };
  cache.set(key, entry);
  const image = await entry.image;
  entry.expiresAt = Date.now() + (image ? 60 * 60_000 : 60_000);
  return image;
}
