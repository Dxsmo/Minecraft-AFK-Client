import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Versions } = require("bedrock-protocol/src/options") as { Versions: Record<string, number> };

/** Bedrock 26.x adverts omit the leading "1."; the wire protocol is authoritative. */
export function bedrockVersion(advertisement: { protocol?: unknown; version?: unknown }, requested = ""): string {
  const explicit = requested.trim();
  if (explicit) {
    const normalized = Versions[explicit] ? explicit : `1.${explicit}`;
    if (!Versions[normalized]) throw new Error(`Unsupported Bedrock client version ${explicit}`);
    return normalized;
  }

  const protocol = Number(advertisement.protocol);
  if (Number.isInteger(protocol) && protocol > 0) {
    const matched = Object.keys(Versions).find(version => Versions[version] === protocol);
    if (matched) return matched;
    throw new Error(`Unsupported Bedrock server protocol ${protocol} (advertised version ${String(advertisement.version ?? "unknown")}); update the Bedrock protocol data`);
  }

  const advertised = String(advertisement.version ?? "").split(".").slice(0, 3).join(".");
  const normalized = Versions[advertised] ? advertised : `1.${advertised}`;
  if (Versions[normalized]) return normalized;
  throw new Error(`Cannot determine a supported Bedrock version from server advertisement ${advertised || "unknown"}`);
}
