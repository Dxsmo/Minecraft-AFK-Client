/** One maintenance clock for all accounts. Packet/inventory events and typed
 * commands wake their own account directly and do not wait for this clock. */
const tasks = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

export function scheduleSession(task: () => void): () => void {
  tasks.add(task);
  timer ??= setInterval(() => { for (const run of tasks) run(); }, 100);
  return () => {
    tasks.delete(task);
    if (!tasks.size) { clearInterval(timer); timer = undefined; }
  };
}
