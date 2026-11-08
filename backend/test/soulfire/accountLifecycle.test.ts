import { expect, it } from "vitest";
import { withAccountLifecycle } from "../../src/soulfire/accountLifecycle.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

it("finishes old session cleanup and its explicit stop before starting the replacement, independently per account", async () => {
  const pendingCleanup = deferred(), order: string[] = [];
  const old = withAccountLifecycle("/test/old-session", undefined, async () => {
    order.push("old online");
    await pendingCleanup.promise;
    order.push("old stopped");
  });
  const stop = withAccountLifecycle("/test/old-session/.", undefined, async () => { order.push("explicit stop"); });
  const replacement = withAccountLifecycle("/test/old-session", undefined, async () => { order.push("new online"); });
  await withAccountLifecycle("/test/other-session", undefined, async () => { order.push("other online"); });
  expect(order).toEqual(["old online", "other online"]);
  pendingCleanup.resolve();
  await Promise.all([old, stop, replacement]);
  expect(order).toEqual(["old online", "other online", "old stopped", "explicit stop", "new online"]);
});

it("removes cancelled retries without starting them or blocking the next controller", async () => {
  const cleanup = deferred(), abort = new AbortController();
  const old = withAccountLifecycle("/test/cancel-session", undefined, () => cleanup.promise);
  let started = false;
  const retry = withAccountLifecycle("/test/cancel-session", abort.signal, async () => { started = true; });
  const rejected = expect(retry).rejects.toMatchObject({ name: "AbortError" });
  abort.abort();
  await rejected;
  expect(started).toBe(false);
  const next = withAccountLifecycle("/test/cancel-session", undefined, async () => { started = true; });
  cleanup.resolve();
  await Promise.all([old, next]);
  expect(started).toBe(true);
});

it("releases failed operations and rejects already cancelled starts", async () => {
  const abort = new AbortController(); abort.abort();
  let started = false;
  await expect(withAccountLifecycle("/test/failure-session", abort.signal, async () => { started = true; })).rejects.toMatchObject({ name: "AbortError" });
  expect(started).toBe(false);
  await expect(withAccountLifecycle("/test/failure-session", undefined, async () => { throw new Error("stop failed"); })).rejects.toThrow("stop failed");
  await withAccountLifecycle("/test/failure-session", undefined, async () => { started = true; });
  expect(started).toBe(true);
});
