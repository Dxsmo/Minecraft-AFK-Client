import { expect, it } from "vitest";
import { ConnectError, Code } from "@connectrpc/connect";
import { soulFireError, unavailableControlService } from "../../src/soulfire/errors.js";

it("retains nested DNS/socket causes without serializing transport credentials", () => {
  const cause = Object.assign(new Error("DNS lookup failed"), { code: "EAI_AGAIN", request: { authorization: "private-token" } });
  const failure = ConnectError.from(new TypeError("fetch failed", { cause }));
  expect(soulFireError(failure)).toContain("EAI_AGAIN");
  expect(soulFireError(failure)).toContain("DNS lookup failed");
  expect(soulFireError(failure)).not.toContain("private-token");
});

it("distinguishes unavailable transports and failed server queries from game and authorization errors", () => {
  for (const error of [
    new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 172.19.0.4:38765"), { code: "ECONNREFUSED" }) }),
    new ConnectError("offline", Code.Unavailable), new ConnectError("timed out", Code.DeadlineExceeded),
    new ConnectError("HikariPool-1 - Connection is not available", Code.Internal),
    new ConnectError("", Code.Unknown), new ConnectError("busy", Code.ResourceExhausted),
  ]) expect(unavailableControlService(error)).toBe(true);
  for (const error of [
    new ConnectError("fetch failed", Code.PermissionDenied), new ConnectError("missing bot", Code.NotFound),
    new ConnectError("expired", Code.Unauthenticated), new Error("Read timed out"), new Error("bad state"),
  ]) expect(unavailableControlService(error)).toBe(false);
});

it("bounds cyclic and aggregate errors and retains authoritative RPC errors", () => {
  const cause = new Error("socket closed"); cause.cause = cause;
  expect(soulFireError(new AggregateError([cause, Object.assign(new Error("reset"), { code: "ECONNRESET" })], "fetch failed")))
    .toBe("fetch failed; socket closed; reset; ECONNRESET");
  expect(soulFireError(new ConnectError("revoked", Code.PermissionDenied))).toContain("revoked");
  expect(soulFireError(new Error("x".repeat(2000))).length).toBeLessThanOrEqual(1500);
});
