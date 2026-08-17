import argon2 from "argon2";

/**
 * Argon2id is the OWASP-recommended password hashing algorithm. Parameters
 * below are tuned to be reasonably strong while staying inexpensive enough
 * for a Raspberry Pi 5 (avoid multi-second hashes on constrained hardware).
 */
const HASH_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456, // ~19 MB
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, HASH_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
