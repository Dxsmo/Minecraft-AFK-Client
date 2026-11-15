import { afterEach, expect, it, vi } from "vitest";
import { createStartupGate } from "../../src/minecraft/startupGate.js";
afterEach(() => vi.useRealTimers());
it("spaces a fleet's starts and admits the next account only after world entry releases a slot", async () => {
  vi.useFakeTimers();
  const reserve = createStartupGate(2, 2000, 30_000), signal = new AbortController().signal;
  const first = await reserve("farm", signal);
  let second: (() => void) | undefined, third: (() => void) | undefined;
  const pendingSecond = reserve("farm", signal).then(release => { second = release; });
  const pendingThird = reserve("farm", signal).then(release => { third = release; });
  await vi.advanceTimersByTimeAsync(1999); expect(second).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1); await pendingSecond;
  await vi.advanceTimersByTimeAsync(2000); expect(third).toBeUndefined();
  first(); await pendingThird; expect(third).toBeTypeOf("function");
  first(); second!(); third!(); expect(vi.getTimerCount()).toBe(0);
});
it("removes cancelled waiters and lets unrelated endpoints and authentication waits progress", async () => {
  vi.useFakeTimers();
  const reserve = createStartupGate(1, 2000, 30_000), abort = new AbortController(), signal = new AbortController().signal;
  const first = await reserve("farm", signal);
  const pending = reserve("farm", abort.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  abort.abort(); await rejected;
  const other = await reserve("other", signal); other();
  let next: (() => void) | undefined;
  const waiting = reserve("farm", signal).then(release => { next = release; });
  await vi.advanceTimersByTimeAsync(29_999); expect(next).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1); await waiting;
  first(); next!(); expect(vi.getTimerCount()).toBe(0);
});
it("releases an admitted cancelled attempt and rejects cancellation before admission", async () => {
  vi.useFakeTimers();
  const reserve = createStartupGate(1, 0, 30_000), abort = new AbortController();
  await reserve("farm", abort.signal);
  const next = reserve("farm", new AbortController().signal);
  abort.abort(); const release = await next; release();
  expect(() => reserve("farm", abort.signal)).toThrow();
  expect(vi.getTimerCount()).toBe(0);
});
