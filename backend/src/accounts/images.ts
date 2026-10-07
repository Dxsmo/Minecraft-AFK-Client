import { randomUUID } from "node:crypto";
import { PNG } from "pngjs";
import { prisma } from "../database/prisma.js";

export const MAX_ACCOUNT_IMAGE_BYTES = 512 * 1024;
export const MAX_ACCOUNT_IMAGE_BASE64 = Math.ceil(MAX_ACCOUNT_IMAGE_BYTES / 3) * 4;
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Validate dimensions before decompressing, then strip metadata by re-encoding. */
export function decodeAccountImage(base64: string): Buffer | null {
  if (base64.length > MAX_ACCOUNT_IMAGE_BASE64) return null;
  const input = Buffer.from(base64, "base64");
  if (input.length < 33 || input.length > MAX_ACCOUNT_IMAGE_BYTES || input.toString("base64") !== base64 ||
      !input.subarray(0, 8).equals(signature) || input.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = input.readUInt32BE(16);
  const height = input.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 256 || height > 256) return null;
  try {
    const png = PNG.sync.read(input, { checkCRC: true });
    if (png.width !== width || png.height !== height) return null;
    return PNG.sync.write(png);
  } catch {
    return null;
  }
}

export interface AccountImageUpdate { id: string; imageUrl: string }
const listeners = new Set<(update: AccountImageUpdate) => void>();
export function onAccountImageUpdated(listener: (update: AccountImageUpdate) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export async function replaceAccountImage(id: string, data: Buffer): Promise<AccountImageUpdate> {
  const revision = randomUUID();
  const bytes = Uint8Array.from(data);
  await prisma.accountImage.upsert({
    where: { minecraftAccountId: id },
    create: { minecraftAccountId: id, data: bytes, revision },
    update: { data: bytes, revision },
  });
  const update = { id, imageUrl: `/api/minecraft/accounts/${id}/image?v=${revision}` };
  for (const listener of listeners) listener(update);
  return update;
}
