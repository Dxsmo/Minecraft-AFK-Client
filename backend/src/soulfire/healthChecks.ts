import { Code, ConnectError } from "@connectrpc/connect";
import type { BotListEntry } from "@soulfiremc/sdk/generated/soulfire/bot_pb";
import type { SoulFireRpc } from "./rpc.js";

type Reader = { botId: string; resolve: (state: BotListEntry) => void; reject: (error: unknown) => void; removeAbort: () => void };
type Batch = { rpc: SoulFireRpc; instanceId: string; abort: AbortController; readers: Set<Reader>; started: boolean };

/** Coalesce simultaneous readers of an instance, bound expensive game-thread
 * probes, and request the summary without full inventories or rendered icons.
 * Only pending work is retained: no cached account state survives a request. */
export class SoulFireHealthChecks {
  private batches = new Map<string, Batch>();
  private active = 0;
  private scheduled = false;

  constructor(private concurrency = 2) {}

  read(rpc: SoulFireRpc, ids: { instanceId: string; botId: string }, signal: AbortSignal): Promise<BotListEntry> {
    signal.throwIfAborted();
    let batch = this.batches.get(ids.instanceId);
    if (!batch) {
      batch = { rpc, instanceId: ids.instanceId, abort: new AbortController(), readers: new Set(), started: false };
      this.batches.set(ids.instanceId, batch);
    }
    const current = batch;
    return new Promise((resolve, reject) => {
      const cancel = () => {
        current.readers.delete(reader); reader.removeAbort(); reject(signal.reason);
        if (!current.readers.size) {
          if (this.batches.get(current.instanceId) === current) this.batches.delete(current.instanceId);
          current.abort.abort();
        }
      };
      const reader: Reader = { botId: ids.botId, resolve, reject, removeAbort: () => signal.removeEventListener("abort", cancel) };
      current.readers.add(reader); signal.addEventListener("abort", cancel, { once: true });
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.drain(); });
  }

  private drain(): void {
    for (const batch of this.batches.values()) {
      if (this.active >= this.concurrency) break;
      if (batch.started) continue;
      batch.started = true; this.active++;
      void this.run(batch).finally(() => { this.active--; this.schedule(); });
    }
  }

  private async run(batch: Batch): Promise<void> {
    const signal = AbortSignal.any([batch.abort.signal, AbortSignal.timeout(3000)]);
    let canceled: (() => void) | undefined;
    try {
      signal.throwIfAborted();
      const stopped = new Promise<never>((_, reject) => {
        canceled = () => reject(signal.reason);
        signal.addEventListener("abort", canceled, { once: true });
      });
      const result = await Promise.race([stopped,
        batch.rpc.bot.getBotList({ instanceId: batch.instanceId }, { signal, timeoutMs: 3000 })]);
      for (const reader of batch.readers) {
        const state = result.bots.find(bot => bot.profileId === reader.botId);
        if (state) reader.resolve(state);
        else reader.reject(new ConnectError("SoulFire-Account fehlt im Status-Snapshot", Code.NotFound));
      }
    } catch (error) {
      const failure = signal.aborted && !batch.abort.signal.aborted
        ? new ConnectError("SoulFire-Statusabfrage hat nicht rechtzeitig geantwortet", Code.DeadlineExceeded) : error;
      for (const reader of batch.readers) reader.reject(failure);
    }
    finally {
      if (canceled) signal.removeEventListener("abort", canceled);
      for (const reader of batch.readers) reader.removeAbort();
      batch.readers.clear();
      if (this.batches.get(batch.instanceId) === batch) this.batches.delete(batch.instanceId);
    }
  }
}

export const soulFireHealthChecks = new SoulFireHealthChecks();
