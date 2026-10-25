import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Versions, CURRENT_VERSION } = require("bedrock-protocol/src/options") as {
  Versions: Record<string, number>;
  CURRENT_VERSION: string;
};

/** The UI and connection code must use the same installed protocol catalogue. */
export function bedrockVersionCatalog() {
  return {
    versions: Object.keys(Versions).sort((a, b) => b.localeCompare(a, "en", { numeric: true })),
    defaultVersion: CURRENT_VERSION,
  };
}

export interface BedrockVersionSelection {
  version: string;
  protocol: number;
  advertisedProtocol: number;
  negotiating: boolean;
}

/**
 * A proxy can advertise its newest protocol while accepting stable clients too.
 * Offer our real stable protocol; never label its codec as a newer protocol.
 * A server requiring the newer protocol must reject this during the handshake.
 */
export function selectBedrockVersion(advertisement: { protocol?: unknown; version?: unknown }, requested = ""): BedrockVersionSelection {
  const advertisedProtocol = Number(advertisement.protocol);
  const newestProtocol = Math.max(...Object.values(Versions));
  const negotiating = !requested.trim() && Number.isInteger(advertisedProtocol)
    && advertisedProtocol > newestProtocol;
  const version = negotiating ? CURRENT_VERSION : bedrockVersion(advertisement, requested);
  return { version, protocol: Versions[version], advertisedProtocol, negotiating };
}

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
    throw new Error(`Unsupported Bedrock server protocol ${protocol} (advertised version ${String(advertisement.version ?? "unknown")}); newest installed client: ${CURRENT_VERSION} (protocol ${Versions[CURRENT_VERSION]})`);
  }

  const advertised = String(advertisement.version ?? "").split(".").slice(0, 3).join(".");
  const normalized = Versions[advertised] ? advertised : `1.${advertised}`;
  if (Versions[normalized]) return normalized;
  throw new Error(`Cannot determine a supported Bedrock version from server advertisement ${advertised || "unknown"}`);
}
