import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { config } from "../config/config.js";

/**
 * Transparent authenticated encryption for sensitive data at rest (e.g. proxy
 * URLs that may embed `user:pass@host` credentials). Uses AES-256-GCM.
 *
 * The 32-byte key is derived (scrypt) from `ENCRYPTION_KEY` if set, otherwise
 * from `SESSION_SECRET` so the feature works out of the box. Encrypted values
 * are stored as `enc:v1:<base64(iv | authTag | ciphertext)>`. Values that are
 * NOT prefixed are treated as legacy plaintext and returned unchanged on
 * decrypt, so this can be introduced without a data migration.
 */
const PREFIX = "enc:v1:";
const IV_LEN = 12; // 96-bit nonce, recommended for GCM
const TAG_LEN = 16;

const key = scryptSync(config.encryptionKey, "afk-data-encryption-v1", 32);

export function encryptSecret(plain: string): string {
  if (plain === "") return "";
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

export function decryptSecret(stored: string | null | undefined): string {
  if (!stored) return "";
  if (!stored.startsWith(PREFIX)) return stored; // legacy plaintext
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), "base64");
    const iv = raw.subarray(0, IV_LEN);
    const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ciphertext = raw.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // Corrupt/failed decryption: fail closed to an empty value rather than
    // leaking ciphertext or crashing the caller.
    return "";
  }
}

/** True if a stored value is in encrypted form. */
export function isEncrypted(stored: string | null | undefined): boolean {
  return !!stored && stored.startsWith(PREFIX);
}
