import net from "node:net";
import { expect, it } from "vitest";
import { javaServerProtocol, selectProtocol, varInt, versionCatalog } from "../../src/soulfire/versions.js";
const options = [
  { id: "SPECIAL|2193", displayName: "Bedrock 1.26.51", keywords: ["Bedrock 1.26.51", "2193"] },
  { id: "RELEASE|777", displayName: "26.3", keywords: ["26.3", "777"] },
  { id: "RELEASE|775", displayName: "26.1-26.1.2", keywords: ["26.1", "26.1.1", "26.1.2", "775"] },
];
it("selects the edition-specific protocol and preserves Java aliases", () => {
  expect(selectProtocol(options, "JAVA", "26.1.2").id).toBe("RELEASE|775");
  expect(selectProtocol(options, "JAVA", "", 775).id).toBe("RELEASE|775");
  expect(selectProtocol(options, "BEDROCK", "").id).toBe("SPECIAL|2193");
  expect(() => selectProtocol(options, "JAVA", "", 999)).toThrow("Protokoll 999");
  expect(() => selectProtocol(options, "BEDROCK", "1.21.50")).toThrow();
  expect(versionCatalog(options)).toEqual({ java: { versions: ["26.3", "26.1", "26.1.1", "26.1.2"], defaultVersion: "26.3" }, bedrock: { versions: ["1.26.51"], defaultVersion: "1.26.51" } });
});
it("detects a server protocol from a fragmented status response without logging in", async () => {
  const server = net.createServer(socket => socket.once("data", () => {
    const response = Buffer.from(JSON.stringify({ version: { name: "26.1.2", protocol: 775 } }));
    const packet = Buffer.concat([varInt(0), varInt(response.length), response]);
    const frame = Buffer.concat([varInt(packet.length), packet]);
    socket.write(frame.subarray(0, 3)); setTimeout(() => socket.end(frame.subarray(3)), 5);
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try { expect(await javaServerProtocol("127.0.0.1", (server.address() as net.AddressInfo).port)).toBe(775); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

it("maps long website IDs into stable, distinct SoulFire instance names", async () => {
  const { soulFireInstanceName } = await import("../../src/soulfire/instanceName.js");
  const id = "3e61f242-268d-4308-807d-15f24378df01";
  expect(soulFireInstanceName(id)).toHaveLength(32);
  expect(soulFireInstanceName(id)).toBe(soulFireInstanceName(id));
  expect(soulFireInstanceName(id)).not.toBe(soulFireInstanceName(id.replace("df01", "df02")));
  expect(soulFireInstanceName("legacy-cuid")).toBe("afk-legacy-cuid");
});
