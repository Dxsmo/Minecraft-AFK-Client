import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BedrockConnectionProgress, bedrockLoginFailure } from "../../src/bedrock-bot/connection.js";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it("allows a slow Microsoft token refresh, then gives transport its own bounded timeout", () => {
  const progress = new BedrockConnectionProgress(45_000);
  progress.advance("authentication");
  vi.advanceTimersByTime(60_000);
  expect(progress.timedOut).toBe(false);
  progress.advance("transport");
  vi.advanceTimersByTime(44_999);
  expect(progress.timedOut).toBe(false);
  vi.advanceTimersByTime(1);
  expect(progress.timedOut).toBe(true);
  expect(progress.timeoutMessage("proxy.example", 19199, "1.21.130")).toContain("RakNet/UDP connection (45s; proxy.example:19199; version 1.21.130)");
});

it("bounds a stalled authentication refresh and identifies it separately from world loading", () => {
  const progress = new BedrockConnectionProgress(45_000);
  progress.advance("authentication");
  vi.advanceTimersByTime(120_000);
  expect(progress.timedOut).toBe(true);
  expect(progress.timeoutMessage("localhost", 19132, "")).toContain("Microsoft/Xbox authentication (120s");
});

it("waits for device-code sign-in but removes that extended allowance once authentication completes", () => {
  const progress = new BedrockConnectionProgress(45_000);
  progress.waitForDeviceCode(900);
  vi.advanceTimersByTime(8 * 60_000);
  expect(progress.timedOut).toBe(false);
  progress.advance("transport");
  vi.advanceTimersByTime(45_000);
  expect(progress.timedOut).toBe(true);
});

it("keeps world initialization bounded despite repeated start-game packets and late authentication events", () => {
  const progress = new BedrockConnectionProgress(45_000);
  progress.advance("world");
  vi.advanceTimersByTime(30_000);
  expect(progress.advance("world")).toBe(false);
  expect(progress.advance("authentication")).toBe(false);
  vi.advanceTimersByTime(15_000);
  expect(progress.timedOut).toBe(true);
  expect(progress.timeoutMessage("localhost", 19132, "auto")).toContain("world initialization (45s");
});

it("ends the connection watchdog on spawn, including the library's spawn-before-start-game ordering", () => {
  const progress = new BedrockConnectionProgress(45_000);
  progress.advance("spawned");
  progress.advance("world");
  vi.advanceTimersByTime(60 * 60_000);
  expect(progress.timedOut).toBe(false);
});

it.each(["failed_client", "failed_spawn", "failed_server_full", "failed_invalid_tenant", "failed_vanilla_edu", "failed_edu_vanilla", "failed_future_reason"])("reports %s as a refusal instead of a generic world-join timeout", (status) => {
  expect(bedrockLoginFailure({ status })).toMatch(new RegExp(`Bedrock login rejected: .*\\(${status}\\)`));
});

it("does not mistake normal or missing play-status packets for login refusals", () => {
  for (const packet of [undefined, null, {}, { status: 0 }, { status: "login_success" }, { status: "player_spawn" }]) {
    expect(bedrockLoginFailure(packet)).toBeNull();
  }
});

it("includes the current phase when the library's own timer fails before our watchdog", () => {
  const progress = new BedrockConnectionProgress(45_000);
  expect(progress.failureMessage("Ping timed out", "localhost", 19132, "auto")).toContain("server discovery");
  progress.advance("transport");
  expect(progress.failureMessage("Connect timed out", "localhost", 19132, "1.21.130")).toContain("RakNet/UDP connection");
  expect(progress.failureMessage("Unsupported version", "localhost", 19132, "auto")).toBe("Unsupported version");
});
