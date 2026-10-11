/** Coalesce bursts into bounded transactions, keeping only one write in flight. */
export function createBufferedWriter<T>(write: (items: T[]) => Promise<void>, batchSize = 200, delayMs = 25) {
  type Entry = { item: T; resolve: () => void; reject: (error: unknown) => void };
  let queue: Entry[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;

  function schedule() {
    if (!timer && !running && queue.length) timer = setTimeout(() => {
      timer = undefined;
      void drain();
    }, delayMs);
  }

  async function save(batch: Entry[]) {
    try {
      await write(batch.map(entry => entry.item));
      batch.forEach(entry => entry.resolve());
    } catch (error) {
      // A deleted account must not discard another account's valid logs.
      if (batch.length > 1) {
        for (const entry of batch) await save([entry]);
      } else batch[0].reject(error);
    }
  }

  function drain(): Promise<void> {
    if (running) return running;
    const batch = queue.splice(0, batchSize);
    if (!batch.length) return Promise.resolve();
    running = save(batch).finally(() => {
      running = undefined;
      // Yield between transactions so interactive reads can use the database.
      schedule();
    });
    return running;
  }

  return {
    enqueue(item: T): Promise<void> {
      return new Promise((resolve, reject) => {
        queue.push({ item, resolve, reject });
        schedule();
      });
    },
    async flush(): Promise<void> {
      do {
        clearTimeout(timer);
        timer = undefined;
        await drain();
      } while (queue.length || running);
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
