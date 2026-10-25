import { expect, it } from "vitest";
import { createRequire } from "node:module";
import { bedrockVersion, bedrockVersionCatalog, selectBedrockVersion } from "../../src/bedrock-bot/version.js";

const require = createRequire(import.meta.url);
const { createSerializer } = require("bedrock-protocol/src/transforms/serializer");

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

it("offers a real stable protocol to a newer multi-version server without aliasing the preview codec", () => {
  const selection = selectBedrockVersion({ protocol: 2225, version: "26.60" });
  expect(selection).toEqual({ version: "1.26.51", protocol: 2193, advertisedProtocol: 2225, negotiating: true });
  const serializer = createSerializer(selection.version);
  const settings = serializer.createPacketBuffer({ name: "request_network_settings", params: { client_protocol: selection.protocol } });
  expect(settings.readUInt32BE(settings.length - 4)).toBe(2193);
  const login = serializer.createPacketBuffer({ name: "login", params: {
    protocol_version: selection.protocol, tokens: { identity: "{}", client: "" },
  } });
  expect(login[0]).toBe(1);
  expect(login.readUInt32BE(1)).toBe(2193);
  expect(bedrockVersionCatalog().versions).not.toContain("1.26.60");
});

it("keeps explicit Bedrock versions and known/invalid advertisements separate from newer-server negotiation", () => {
  expect(selectBedrockVersion({ protocol: 2225 }, "26.40")).toMatchObject({ version: "1.26.40", protocol: 2168, negotiating: false });
  expect(selectBedrockVersion({ protocol: 2193 })).toMatchObject({ version: "1.26.51", negotiating: false });
  expect(() => selectBedrockVersion({ protocol: 2225 }, "26.60")).toThrow("Unsupported Bedrock client version");
  expect(() => selectBedrockVersion({ protocol: 2194, version: "unknown" }, "invalid")).toThrow("Unsupported Bedrock client version");
  expect(() => selectBedrockVersion({ protocol: 123, version: "26.60" })).toThrow("Unsupported Bedrock server protocol");
  expect(() => selectBedrockVersion({})).toThrow("Cannot determine");
});
