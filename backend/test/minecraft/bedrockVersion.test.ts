import { expect, it } from "vitest";
import { bedrockVersion } from "../../src/bedrock-bot/version.js";

it("selects HugoSMP's advertised 2193 protocol instead of silently falling back to 1.26.40", () => {
  expect(bedrockVersion({ protocol: "2193", version: "26.51" })).toBe("1.26.51");
});

it("prefers the wire protocol even when a proxy advertises a misleading display version", () => {
  expect(bedrockVersion({ protocol: "2193", version: "1.21.4 - 26.3" })).toBe("1.26.51");
  expect(bedrockVersion({ protocol: "2168", version: "26.51" })).toBe("1.26.40");
});

it("normalizes an explicitly configured modern version without overwriting it", () => {
  expect(bedrockVersion({ protocol: "2193", version: "26.51" }, " 26.40 ")).toBe("1.26.40");
  expect(bedrockVersion({ protocol: "2193" }, "1.21.130")).toBe("1.21.130");
  expect(() => bedrockVersion({ protocol: "2193" }, "invalid")).toThrow("Unsupported Bedrock client version");
});

it("fails clearly on an unsupported server protocol rather than connecting with an unrelated codec", () => {
  expect(() => bedrockVersion({ protocol: "999999", version: "26.99" })).toThrow("Unsupported Bedrock server protocol 999999");
  expect(() => bedrockVersion({ protocol: "999999", version: "1.26.40" })).toThrow("Unsupported Bedrock server protocol");
});

it("accepts known display versions when the advertisement has no usable protocol", () => {
  expect(bedrockVersion({ version: "26.51" })).toBe("1.26.51");
  expect(bedrockVersion({ version: "1.21.130.1", protocol: "invalid" })).toBe("1.21.130");
  expect(() => bedrockVersion({})).toThrow("Cannot determine a supported Bedrock version");
});
