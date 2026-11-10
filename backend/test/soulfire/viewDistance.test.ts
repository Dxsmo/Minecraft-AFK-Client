import { afterEach, expect, it, vi } from "vitest";
import { soulFireViewDistance } from "../../src/soulfire/viewDistance.js";
afterEach(() => vi.unstubAllEnvs());
it("uses a four-chunk default and accepts only supported client radii", () => {
  vi.stubEnv("SOULFIRE_VIEW_DISTANCE", undefined); expect(soulFireViewDistance()).toBe(4);
  for (const distance of ["2", "4", "6", "32"]) {
    vi.stubEnv("SOULFIRE_VIEW_DISTANCE", distance); expect(soulFireViewDistance()).toBe(Number(distance));
  }
  for (const distance of ["0", "1", "33", "2.5", "", "NaN"]) {
    vi.stubEnv("SOULFIRE_VIEW_DISTANCE", distance); expect(() => soulFireViewDistance()).toThrow();
  }
});
