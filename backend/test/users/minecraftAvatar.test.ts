import { afterEach, expect, it, vi } from "vitest";
import { PNG } from "pngjs";
import { getMinecraftAvatar } from "../../src/users/minecraftAvatar.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function image(width = 32, height = 32) {
  return PNG.sync.write(new PNG({ width, height }));
}
function response(data: Buffer = image(), type = "image/png") {
  return new Response(new Uint8Array(data), { headers: { "content-type": type } });
}

it("uses a fixed HTTPS PNG endpoint and shares concurrent, case-insensitive cached lookups", async () => {
  const request = vi.fn().mockResolvedValue(response());
  vi.stubGlobal("fetch", request);
  const results = await Promise.all([getMinecraftAvatar("CacheCreator"), getMinecraftAvatar("cachecreator")]);
  expect(results[0]).toEqual(results[1]);
  expect(PNG.sync.read(results[0]!).width).toBe(32);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith("https://mc-heads.net/avatar/CacheCreator/32", expect.objectContaining({
    redirect: "error", headers: { Accept: "image/png" }, signal: expect.any(AbortSignal),
  }));
  await getMinecraftAvatar("CACHECREATOR");
  expect(request).toHaveBeenCalledTimes(1);
});

it("never fetches malformed identifiers or arbitrary URLs", async () => {
  const request = vi.fn();
  vi.stubGlobal("fetch", request);
  for (const username of ["https://localhost", "../admin", "ab", "a".repeat(17), "name?url=x"]) {
    expect(await getMinecraftAvatar(username)).toBeNull();
  }
  expect(request).not.toHaveBeenCalled();
});

it("rejects non-PNG, corrupt, oversized and incorrectly sized upstream images", async () => {
  const request = vi.fn()
    .mockResolvedValueOnce(response(Buffer.from("<svg/>"), "image/svg+xml"))
    .mockResolvedValueOnce(response(Buffer.from("not a png")))
    .mockResolvedValueOnce(response(image(16, 16)))
    .mockResolvedValueOnce(response(Buffer.alloc(65537)))
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockRejectedValueOnce(new Error("Timeout"));
  vi.stubGlobal("fetch", request);
  for (let index = 0; index < 6; index++) expect(await getMinecraftAvatar(`InvalidSkin${index}`)).toBeNull();
});

it("temporarily caches failures and retries them after one minute", async () => {
  let now = 100000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const request = vi.fn().mockRejectedValueOnce(new Error("Temporary outage")).mockResolvedValueOnce(response());
  vi.stubGlobal("fetch", request);
  expect(await getMinecraftAvatar("RetryCreator")).toBeNull();
  expect(await getMinecraftAvatar("RetryCreator")).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
  now += 60001;
  expect(await getMinecraftAvatar("RetryCreator")).not.toBeNull();
  expect(request).toHaveBeenCalledTimes(2);
});
