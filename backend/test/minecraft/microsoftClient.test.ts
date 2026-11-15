import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { microsoftClientOptions } from "../../src/minecraft/microsoftClient.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function cache(metadata?: unknown) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "afk-ms-client-"));
  directories.push(directory);
  if (metadata !== undefined) writeFileSync(path.join(directory, "microsoft-client.json"), JSON.stringify(metadata));
  return directory;
}

describe("imported Microsoft OAuth client", () => {
  it.each([
    ["JAVA", "00000000441cc96b", "Nintendo"],
    ["BEDROCK", "00000000441cc96b", "Nintendo"],
    ["JAVA", "00000000402b5328", "Win32"],
    ["BEDROCK", "0000000048183522", "Android"],
  ] as const)("preserves the issuing app for %s / %s", (edition, clientId, deviceType) => {
    expect(microsoftClientOptions(cache({ clientId }), edition)).toEqual({ authTitle: clientId, flow: "live", deviceType });
  });

  it.each([
    ["JAVA", "0000000048183522"],
    ["BEDROCK", "00000000402b5328"],
    ["JAVA", "unrecognized-app"],
  ] as const)("ignores unsupported issuer metadata for %s / %s", (edition, clientId) => {
    expect(microsoftClientOptions(cache({ clientId }), edition)).toEqual({});
  });

  it("uses normal authentication when metadata is absent or malformed", () => {
    const directory = cache();
    expect(microsoftClientOptions(directory, "JAVA")).toEqual({});
    writeFileSync(path.join(directory, "microsoft-client.json"), "{");
    expect(microsoftClientOptions(directory, "JAVA")).toEqual({});
    expect(microsoftClientOptions(cache(null), "JAVA")).toEqual({});
  });
});
