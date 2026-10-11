import { expect, it, vi } from "vitest";
import { createBufferedWriter } from "../../src/logging/bufferedWriter.js";

it("serializes a burst into bounded batches and flushes every pending line", async () => {
  let active = 0;
  let maximum = 0;
  const written: number[] = [];
  const write = vi.fn(async (rows: number[]) => {
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 1));
    written.push(...rows);
    active--;
  });
  const writer = createBufferedWriter(write, 200);
  const jobs = Array.from({ length: 650 }, (_, i) => writer.enqueue(i));
  await writer.flush();
  await Promise.all(jobs);
  expect(maximum).toBe(1);
  expect(write.mock.calls.map(([rows]) => rows.length)).toEqual([200, 200, 200, 50]);
  expect(written).toEqual(Array.from({ length: 650 }, (_, i) => i));
});

it("isolates failed entries without losing other accounts' logs", async () => {
  const written: number[] = [];
  const writer = createBufferedWriter<number>(async rows => {
    if (rows.includes(2)) throw new Error("Account deleted");
    written.push(...rows);
  });
  const jobs = [1, 2, 3].map(i => writer.enqueue(i));
  const settled = Promise.allSettled(jobs);
  await writer.flush();
  expect((await settled).map(job => job.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  expect(written).toEqual([1, 3]);
});

it("accepts events arriving during an ongoing flush", async () => {
  let release!: () => void;
  const written: number[] = [];
  const writer = createBufferedWriter<number>(async rows => {
    if (rows.includes(1)) await new Promise<void>(resolve => { release = resolve; });
    written.push(...rows);
  });
  const first = writer.enqueue(1);
  const flush = writer.flush();
  const second = writer.enqueue(2);
  release();
  await Promise.all([first, second, flush]);
  expect(written).toEqual([1, 2]);
});
