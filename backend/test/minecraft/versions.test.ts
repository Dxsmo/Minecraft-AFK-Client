import { describe, expect, it } from "vitest";
import minecraftData from "minecraft-data";
import { minecraftVersionCatalog, selectJavaVersion } from "../../src/minecraft/versions.js";
import { selectBedrockVersion } from "../../src/bedrock-bot/version.js";

describe("installed engine version catalogue", () => {
  it("advertises only Java versions that resolve to a real matching codec", () => {
    const catalog = minecraftVersionCatalog();
    expect(catalog.java.versions.length).toBeGreaterThan(20);
    expect(selectJavaVersion()).toBe(false);
    for (const version of catalog.java.versions) {
      const selected = selectJavaVersion(version);
      expect(selected).not.toBe(false);
      // The data loader does not carry complete registries for every alias;
      // compare its advertised protocol number to the selected real registry.
      expect(minecraftData(selected as string).version.version).toBe(minecraftData.versionsByMinecraftVersion.pc[version].version);
    }
    expect(() => selectJavaVersion("999.99")).toThrow("nicht");
  });

  it("advertises the same Bedrock versions that the connection can select", () => {
    const catalog = minecraftVersionCatalog();
    expect(catalog.bedrock.versions).toContain(catalog.bedrock.defaultVersion);
    for (const version of catalog.bedrock.versions) {
      expect(selectBedrockVersion({}, version)).toMatchObject({ version, negotiating: false });
    }
  });
});
