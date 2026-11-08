/** Keep reconnect waves from configuring/loading every Minecraft client at once.
 * A prompt for human authentication must not hold up the rest of the fleet.
 * The admission lease is finite even when a remote server never admits a player.
 */
export function createStartupGate(parallel = 2, spacingMs = 2000, leaseMs = 30_000) {
  type Waiter = { signal: AbortSignal; grant: (release: () => void) => void; cancel: () => void };
  type Group = { active: number; next: number; queue: Waiter[]; timer?: ReturnType<typeof setTimeout> };
  const groups = new Map<string, Group>();
  return (endpoint: string, signal: AbortSignal): Promise<() => void> => {
    signal.throwIfAborted();
    let group = groups.get(endpoint);
    if (!group) { group = { active: 0, next: 0, queue: [] }; groups.set(endpoint, group); }
    const current = group;
    const pump = () => {
      if (current.timer) { clearTimeout(current.timer); current.timer = undefined; }
      if (!current.active && !current.queue.length) { groups.delete(endpoint); return; }
      if (current.active >= parallel || !current.queue.length) return;
      const delay = current.next - Date.now();
      if (delay > 0) { current.timer = setTimeout(pump, delay); return; }
      const waiter = current.queue.shift()!;
      current.active++; current.next = Date.now() + spacingMs;
      let released = false;
      const release = () => {
        if (released) return;
        released = true; clearTimeout(lease);
        waiter.signal.removeEventListener("abort", release);
        current.active--; pump();
      };
      const lease = setTimeout(release, leaseMs);
      waiter.signal.removeEventListener("abort", waiter.cancel);
      waiter.signal.addEventListener("abort", release, { once: true });
      waiter.grant(release);
      pump();
    };
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { signal, grant: resolve, cancel: () => {
        const index = current.queue.indexOf(waiter);
        if (index >= 0) current.queue.splice(index, 1);
        reject(signal.reason); pump();
      } };
      current.queue.push(waiter);
      signal.addEventListener("abort", waiter.cancel, { once: true });
      pump();
    });
  };
}
export const reserveStartup = createStartupGate();
