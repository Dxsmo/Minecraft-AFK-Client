import { expect, it, vi } from "vitest";
import { scheduleSession } from "../../src/soulfire/scheduler.js";
it("shares one clock and removes all account callbacks and timers on stop", async () => {
  vi.useFakeTimers();
  const ticks = Array.from({ length: 13 }, () => vi.fn()), stop = ticks.map(scheduleSession);
  try {
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(100); expect(ticks.every(t => t.mock.calls.length === 1)).toBe(true);
    stop[0](); await vi.advanceTimersByTimeAsync(100); expect(ticks[0]).toHaveBeenCalledOnce();
  } finally { stop.forEach(remove => remove()); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); }
});
