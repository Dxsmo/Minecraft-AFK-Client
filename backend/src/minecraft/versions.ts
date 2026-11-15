import mineflayer from "mineflayer";
import minecraftData from "minecraft-data";
import { bedrockVersionCatalog } from "../bedrock-bot/version.js";

// Read only protocol metadata here. Loading every version's complete registry
// would multiply world/item data in the backend and in every account process.
const codecs = new Map(mineflayer.testedVersions.map(version => [minecraftData.versionsByMinecraftVersion.pc[version].version, version]));
const aliases = new Map<string, string>();
for (const version of minecraftData.versions.pc) {
  const codec = codecs.get(version.version);
  if (codec && /^\d+\.\d+(?:\.\d+)?$/.test(version.minecraftVersion)) aliases.set(version.minecraftVersion, codec);
}
for (const version of mineflayer.testedVersions) aliases.set(version, version);

/** Keep the selector and handshake tied to installed codecs, including release
 * aliases sharing the same wire protocol (for example Java 26.1.2). */
export function selectJavaVersion(requested = ""): string | false {
  if (!requested.trim()) return false;
  const version = aliases.get(requested.trim());
  if (!version) throw new Error(`Mineflayer unterstützt Java ${requested} nicht. Bitte eine Version aus der aktuellen Auswahl verwenden.`);
  return version;
}

export function minecraftVersionCatalog() {
  return { java: { versions: [...aliases.keys()].sort((a, b) => b.localeCompare(a, "en", { numeric: true })),
    defaultVersion: mineflayer.testedVersions.at(-1)! }, bedrock: bedrockVersionCatalog() };
}
