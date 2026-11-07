import { expect, it } from "vitest";
import { ReconnectPolicy } from "../../src/minecraft/reconnectPolicy.js";

it("backs off login rejection storms and only resets after a stable game session", () => {
  const policy = new ReconnectPolicy();
  const reason = "You are logging in too fast, try again later.";
  expect(policy.delay(reason, 0)).toBe(60_000);
  expect(policy.delay(reason, 4000)).toBe(120_000);
  expect(policy.delay(reason, 0)).toBe(240_000);
  expect(policy.delay(reason, 0)).toBe(300_000);
  expect(policy.delay(reason, 130_000)).toBe(60_000);
});
it("spaces repeated control failures without changing normal reconnects", () => {
  const policy = new ReconnectPolicy();
  expect(Array.from({ length: 6 }, () => policy.delay("[deadline_exceeded] timed out", 0)))
    .toEqual([15_000, 15_000, 30_000, 60_000, 120_000, 120_000]);
  policy.reset();
  expect(policy.delay("ordinary disconnect", 0)).toBe(15_000);
  expect(policy.delay("Too many packets in a bundle", 0)).toBe(60_000);
  expect(policy.delay("You are sending suspicious packets.", 0)).toBe(60_000);
});
