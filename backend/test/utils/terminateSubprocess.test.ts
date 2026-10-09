import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { terminateSubprocess } from "../../src/utils/terminateSubprocess.js";

class Child extends EventEmitter {
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn(() => { this.killed = true; return true; });
  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    this.exitCode = code; this.signalCode = signal;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

afterEach(() => { vi.useRealTimers(); });

it("force-kills a process still alive after SIGTERM set the killed flag", () => {
  vi.useFakeTimers();
  const child = new Child();
  terminateSubprocess(child as unknown as ChildProcess);
  vi.advanceTimersByTime(500);
  expect(child.killed).toBe(true);
  expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
  vi.advanceTimersByTime(1500);
  expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  child.exit(null, "SIGKILL");
  expect(child.listenerCount("exit")).toBe(0);
  expect(child.listenerCount("close")).toBe(0);
});

it.each([0, 1])("cancels escalation after a graceful exit with code %s", code => {
  vi.useFakeTimers();
  const child = new Child();
  terminateSubprocess(child as unknown as ChildProcess);
  child.exit(code);
  vi.advanceTimersByTime(2000);
  expect(child.kill).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not force-kill after SIGTERM actually ended the process", () => {
  vi.useFakeTimers();
  const child = new Child();
  child.kill.mockImplementation(() => { child.killed = true; child.exit(null, "SIGTERM"); return true; });
  terminateSubprocess(child as unknown as ChildProcess);
  vi.advanceTimersByTime(2000);
  expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not schedule signals for a child that has already exited", () => {
  vi.useFakeTimers();
  const child = new Child();
  child.exit(null, "SIGTERM");
  terminateSubprocess(child as unknown as ChildProcess);
  expect(vi.getTimerCount()).toBe(0);
  expect(child.kill).not.toHaveBeenCalled();
});

it("terminates a real subprocess that deliberately ignores SIGTERM", async () => {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await once(child.stdout!, "data");
    const closed = once(child, "close");
    terminateSubprocess(child, 20, 100);
    const [code, signal] = await closed;
    expect(code).toBeNull();
    expect(signal).toBe("SIGKILL");
  } finally {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
  }
});
