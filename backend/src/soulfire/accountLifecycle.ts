import path from "node:path";

type Lock = { waiting: Set<() => void> };
const locks = new Map<string, Lock>();

/** The previous controller's asynchronous finally/stop must finish before a
 * replacement can start the same shared-JVM account. Cancellation of a waiting
 * attempt removes it; unrelated accounts never wait for one another.
 */
export async function withAccountLifecycle<T>(cacheDir: string, signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  const key = path.resolve(cacheDir);
  let lock = locks.get(key);
  if (lock) {
    const current = lock;
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        current.waiting.delete(grant);
        signal?.removeEventListener("abort", cancel);
        resolve();
      };
      const cancel = () => { current.waiting.delete(grant); reject(signal!.reason); };
      current.waiting.add(grant);
      signal?.addEventListener("abort", cancel, { once: true });
    });
  } else {
    lock = { waiting: new Set() };
    locks.set(key, lock);
  }
  try {
    signal?.throwIfAborted();
    return await action();
  } finally {
    const next = lock.waiting.values().next().value;
    if (next) next();
    else locks.delete(key);
  }
}
