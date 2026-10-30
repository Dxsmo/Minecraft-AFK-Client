import path from "node:path";
import { Code, ConnectError } from "@connectrpc/connect";
import { setTimeout as delay } from "node:timers/promises";
import { config } from "../config/config.js";
import { readRemoteAccount } from "./auth.js";
import { soulFireRpc } from "./rpc.js";
import type { BotPovFrame } from "@soulfiremc/sdk/generated/soulfire/bot_pb";

export const LIVE_CAM_OPTIONS = { width: 480, height: 270, maxDistance: 32, intervalMs: 150, includeHud: true, includeHands: true } as const;
export type CameraFrame = { type: "frame"; image: string; mime?: "image/jpeg" };
type Viewer = { frame: (frame: CameraFrame) => void; loading?: () => void; error: (error: unknown) => void };
type Stream = { viewers: Set<Viewer>; abort: AbortController; done: Promise<void> };
type FrameSource = (accountId: string, signal: AbortSignal) => AsyncIterable<BotPovFrame>;

async function* frames(accountId: string, signal: AbortSignal): AsyncIterable<BotPovFrame> {
  const ids = await readRemoteAccount(path.join(config.dataDir, "bot-cache", accountId));
  if (!ids) throw new Error("No active SoulFire account");
  if (signal.aborted) return;
  yield* soulFireRpc().bot.watchBotPov({ ...ids, ...LIVE_CAM_OPTIONS }, { signal, timeoutMs: 0 });
}

/** One on-demand upstream stream per account, even with multiple viewers.
 * No frame cache, background polling or rendering without subscribers. */
export class LiveCamStreams {
  private streams = new Map<string, Stream>();
  constructor(private source: FrameSource = frames) {}

  subscribe(accountId: string, viewer: Viewer): () => void {
    let stream = this.streams.get(accountId);
    if (!stream || stream.abort.signal.aborted) {
      const previous = stream?.done;
      stream = { viewers: new Set(), abort: new AbortController(), done: Promise.resolve() };
      this.streams.set(accountId, stream);
      const current = stream;
      // Wait for a cancelled stream before reopening the same account.
      current.done = Promise.resolve(previous).then(async () => {
        if (current.abort.signal.aborted) return;
        while (!current.abort.signal.aborted && current.viewers.size) {
          try {
            for await (const frame of this.source(accountId, current.abort.signal)) {
              if (current.abort.signal.aborted) return;
              const render = frame.render;
              if (!render || !["image/png", "image/jpeg"].includes(render.imageMimeType) || !render.imageBase64 || render.imageBase64.length > 2 * 1024 * 1024) continue;
              const message: CameraFrame = { type: "frame", image: render.imageBase64, ...(render.imageMimeType === "image/jpeg" ? { mime: "image/jpeg" as const } : {}) };
              for (const recipient of current.viewers) {
                try { recipient.frame(message); }
                catch (error) {
                  current.viewers.delete(recipient);
                  try { recipient.error(error); } catch { /* A broken viewer cannot stop the others. */ }
                }
              }
              if (!current.viewers.size) { current.abort.abort(); return; }
            }
            if (!current.abort.signal.aborted) throw new Error("Camera stream ended");
          } catch (error) {
            if (current.abort.signal.aborted) return;
            const code = ConnectError.from(error).code;
            if ([Code.Unauthenticated, Code.PermissionDenied, Code.InvalidArgument, Code.Unimplemented].includes(code)) throw error;
            // Teleports briefly remove the player's level/chunks. Keep browser
            // viewers attached and reopen only this account's upstream stream.
            for (const recipient of current.viewers) { try { recipient.loading?.(); } catch { /* Isolate a closed viewer. */ } }
            await delay(1000, undefined, { signal: current.abort.signal });
          }
        }
      }).catch(error => {
        if (!current.abort.signal.aborted) for (const recipient of current.viewers) {
          try { recipient.error(error); } catch { /* Keep notifying other viewers. */ }
        }
      }).finally(() => {
        current.abort.abort();
        if (this.streams.get(accountId) === current) this.streams.delete(accountId);
      });
    }
    const current = stream;
    current.viewers.add(viewer);
    return () => {
      current.viewers.delete(viewer);
      if (!current.viewers.size) current.abort.abort();
    };
  }

  async close(): Promise<void> {
    const streams = [...this.streams.values()];
    for (const stream of streams) stream.abort.abort();
    await Promise.allSettled(streams.map(stream => stream.done));
  }
}
