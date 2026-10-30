import { afterEach, expect, it, vi } from "vitest";
import { LiveCamStreams, LIVE_CAM_OPTIONS } from "../../src/soulfire/liveCam.js";
import type { BotPovFrame } from "@soulfiremc/sdk/generated/soulfire/bot_pb";

const managers: LiveCamStreams[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map(manager => manager.close())); });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const feeds = new Map<string, (frame: BotPovFrame | undefined) => void>();
  const stopped: string[] = [];
  const source = vi.fn(async function* (id: string, signal: AbortSignal) {
    try {
      while (!signal.aborted) {
        const frame = await new Promise<BotPovFrame | undefined>(resolve => {
          const abort = () => resolve(undefined);
          feeds.set(id, value => { signal.removeEventListener("abort", abort); resolve(value); });
          signal.addEventListener("abort", abort, { once: true });
        });
        if (!frame || signal.aborted) return;
        yield frame;
      }
    } finally { stopped.push(id); feeds.delete(id); }
  });
  const manager = new LiveCamStreams(source); managers.push(manager);
  const frame = (image = "synthetic-png") => ({ render: { imageMimeType: "image/png", imageBase64: image } }) as BotPovFrame;
  return { manager, source, feeds, stopped, frame };
}
const viewer = () => ({ frame: vi.fn(), error: vi.fn() });

it("does not render without viewers and shares one bounded render stream per account", async () => {
  const f = fixture(), one = viewer(), two = viewer();
  await tick(); expect(f.source).not.toHaveBeenCalled();
  const stopOne = f.manager.subscribe("java", one), stopTwo = f.manager.subscribe("java", two);
  await tick(); expect(f.source).toHaveBeenCalledTimes(1);
  f.feeds.get("java")!(f.frame()); await tick();
  expect(one.frame).toHaveBeenCalledWith({ type: "frame", image: "synthetic-png" });
  expect(two.frame).toHaveBeenCalledOnce();
  stopOne(); await tick(); expect(f.stopped).toEqual([]);
  f.feeds.get("java")!(f.frame("next")); await tick();
  expect(one.frame).toHaveBeenCalledOnce(); expect(two.frame).toHaveBeenCalledTimes(2);
  stopTwo(); await tick(); expect(f.stopped).toEqual(["java"]);
  expect(LIVE_CAM_OPTIONS).toMatchObject({ width: 640, height: 360, maxDistance: 48, intervalMs: 400 });
});

it("keeps Java and Bedrock views separate and stops only the account whose viewer leaves", async () => {
  const f = fixture(), java = viewer(), bedrock = viewer();
  const stop = f.manager.subscribe("java", java); f.manager.subscribe("bedrock", bedrock);
  await tick(); f.feeds.get("bedrock")!(f.frame("bedrock-view")); await tick();
  expect(java.frame).not.toHaveBeenCalled(); expect(bedrock.frame).toHaveBeenCalledWith({ type: "frame", image: "bedrock-view" });
  stop(); await tick(); expect(f.stopped).toEqual(["java"]);
  f.feeds.get("bedrock")!(f.frame()); await tick(); expect(bedrock.frame).toHaveBeenCalledTimes(2);
});

it("cancels an unopened camera immediately and allows reopening after its last viewer leaves", async () => {
  const f = fixture(), first = viewer(), second = viewer();
  f.manager.subscribe("java", first)(); await tick(); expect(f.source).not.toHaveBeenCalled();
  const stop = f.manager.subscribe("java", first); await tick(); stop();
  f.manager.subscribe("java", second); await tick();
  expect(f.source).toHaveBeenCalledTimes(2); expect(f.stopped).toEqual(["java"]);
  f.feeds.get("java")!(f.frame()); await tick(); expect(second.frame).toHaveBeenCalledOnce();
});

it("does not forward invalid or oversized images and reports upstream failures to subscribers", async () => {
  const f = fixture(), subscriber = viewer(); f.manager.subscribe("java", subscriber); await tick();
  f.feeds.get("java")!({ render: { imageMimeType: "text/html", imageBase64: "invalid" } } as BotPovFrame); await tick();
  f.feeds.get("java")!(f.frame("x".repeat(2 * 1024 * 1024 + 1))); await tick();
  expect(subscriber.frame).not.toHaveBeenCalled();
  f.feeds.get("java")!(undefined); await tick(); expect(subscriber.error).toHaveBeenCalledOnce();
});

it("isolates a failing viewer and its error handler without stopping another viewer", async () => {
  const f = fixture(), good = viewer();
  const broken = { frame: vi.fn(() => { throw new Error("closed socket"); }), error: vi.fn(() => { throw new Error("failed cleanup"); }) };
  f.manager.subscribe("java", broken); f.manager.subscribe("java", good); await tick();
  f.feeds.get("java")!(f.frame()); await tick(); expect(good.frame).toHaveBeenCalledTimes(1);
  f.feeds.get("java")!(f.frame()); await tick(); expect(good.frame).toHaveBeenCalledTimes(2);
  expect(broken.frame).toHaveBeenCalledTimes(1); expect(f.stopped).toEqual([]);
});
