import { afterEach, expect, it, vi } from "vitest";
import { Code, ConnectError } from "@connectrpc/connect";
import { SoulFireHealthChecks } from "../../src/soulfire/healthChecks.js";
import type { SoulFireRpc } from "../../src/soulfire/rpc.js";
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());
function fixture() {
  const requests: Array<{ instanceId: string; signal: AbortSignal; resolve: (value: any) => void }> = [];
  const list = vi.fn(({ instanceId }, { signal }) => new Promise(resolve => requests.push({ instanceId, signal, resolve })));
  return { requests, list, rpc: { bot: { getBotList: list } } as unknown as SoulFireRpc };
}
it("coalesces readers in an instance without mixing account results or retaining a stale snapshot", async () => {
  const f = fixture(), broker = new SoulFireHealthChecks(), abort = new AbortController();
  const a = broker.read(f.rpc, { instanceId: "world", botId: "a" }, abort.signal);
  const b = broker.read(f.rpc, { instanceId: "world", botId: "b" }, abort.signal);
  await flush(); expect(f.list).toHaveBeenCalledOnce();
  f.requests[0].resolve({ bots: [{ profileId: "a", isOnline: true }, { profileId: "b", isOnline: false }] });
  await expect(a).resolves.toMatchObject({ profileId: "a", isOnline: true });
  await expect(b).resolves.toMatchObject({ profileId: "b", isOnline: false });
  await flush();
  const fresh = broker.read(f.rpc, { instanceId: "world", botId: "a" }, abort.signal);
  await flush(); expect(f.list).toHaveBeenCalledTimes(2);
  f.requests[1].resolve({ bots: [{ profileId: "a", isOnline: false }] });
  await expect(fresh).resolves.toMatchObject({ isOnline: false });
});
it("bounds parallel probes, cancels queued accounts, and releases abandoned in-flight slots", async () => {
  const f = fixture(), broker = new SoulFireHealthChecks(1), stops = [0, 1, 2].map(() => new AbortController());
  const promises = stops.map((stop, i) => broker.read(f.rpc, { instanceId: `${i}`, botId: "a" }, stop.signal).catch(e => e));
  await flush(); expect(f.list).toHaveBeenCalledOnce();
  stops[1].abort(); stops[0].abort(); await flush();
  expect(f.requests[0].signal.aborted).toBe(true);
  expect(f.list).toHaveBeenCalledTimes(2); expect(f.requests[1].instanceId).toBe("2");
  f.requests[1].resolve({ bots: [{ profileId: "a" }] }); await Promise.all(promises);
});
it("a reader leaving does not cancel another reader's status request", async () => {
  const f = fixture(), broker = new SoulFireHealthChecks(), a = new AbortController(), b = new AbortController();
  const leaving = broker.read(f.rpc, { instanceId: "world", botId: "a" }, a.signal).catch(e => e);
  const staying = broker.read(f.rpc, { instanceId: "world", botId: "b" }, b.signal);
  await flush(); a.abort(); expect(f.requests[0].signal.aborted).toBe(false);
  f.requests[0].resolve({ bots: [{ profileId: "b" }] }); await leaving;
  await expect(staying).resolves.toMatchObject({ profileId: "b" });
});
it("propagates permissions and missing accounts instead of faking a live status", async () => {
  const f = fixture(), broker = new SoulFireHealthChecks(), abort = new AbortController();
  const missing = broker.read(f.rpc, { instanceId: "world", botId: "a" }, abort.signal);
  const assertion = expect(missing).rejects.toMatchObject({ code: Code.NotFound });
  await flush(); f.requests[0].resolve({ bots: [] }); await assertion;
  f.list.mockRejectedValueOnce(new ConnectError("denied", Code.PermissionDenied));
  await expect(broker.read(f.rpc, { instanceId: "world", botId: "a" }, abort.signal)).rejects.toMatchObject({ code: Code.PermissionDenied });
});
