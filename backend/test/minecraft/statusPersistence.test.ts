import { expect, it, vi } from "vitest";
import { createStatusPersistence } from "../../src/minecraft/statusPersistence.js";

it("persists lifecycle transitions in order and skips repeated telemetry snapshots", async () => {
  let finish!: () => void;
  const write = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }))
    .mockResolvedValue(undefined);
  const onError = vi.fn();
  const persist = createStatusPersistence("OFFLINE", write, onError);
  await persist("OFFLINE");
  expect(write).not.toHaveBeenCalled();
  const online = persist("ONLINE");
  for (let i = 0; i < 100; i++) void persist("ONLINE");
  const stopped = persist("OFFLINE");
  await Promise.resolve();
  expect(write.mock.calls).toEqual([["ONLINE"]]);
  finish();
  await Promise.all([online, stopped]);
  expect(write.mock.calls).toEqual([["ONLINE"], ["OFFLINE"]]);
  expect(onError).not.toHaveBeenCalled();
});

it("retries a failed status on the next snapshot and keeps processing later transitions", async () => {
  const error = new Error("Busy database");
  const write = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
  const onError = vi.fn();
  const persist = createStatusPersistence("OFFLINE", write, onError);
  await persist("ONLINE");
  await persist("ONLINE");
  await persist("OFFLINE");
  expect(write.mock.calls).toEqual([["ONLINE"], ["ONLINE"], ["OFFLINE"]]);
  expect(onError).toHaveBeenCalledWith(error);
});
