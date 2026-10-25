import { createRequire } from "node:module";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { expect, it } from "vitest";
import { discoverBedrockServer } from "../../src/bedrock-bot/discovery.js";
import { selectBedrockVersion } from "../../src/bedrock-bot/version.js";
import { bedrockLoginFailure } from "../../src/bedrock-bot/connection.js";

const require = createRequire(import.meta.url);
const { Server, createClient } = require("bedrock-protocol");

async function connect(requiresPreview: boolean) {
  const socket = createSocket("udp4");
  socket.bind(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise<void>(resolve => socket.close(() => resolve()));

  // Exercise real UDP, codec and encrypted login with a portable JS transport.
  const server = new Server({ host: "127.0.0.1", port, version: "1.26.51", offline: true, raknetBackend: "jsp-raknet" });
  server.advertisement.protocol = 2225;
  server.advertisement.version = "26.60";
  const protocols: number[] = [];
  let client: any;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let finish!: (result: string) => void;
  let fail!: (error: Error) => void;
  const result = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
  server.on("error", fail);
  server.on("connect", (player: any) => {
    const original = player.handleClientProtocolVersion.bind(player);
    player.handleClientProtocolVersion = (protocol: number) => {
      protocols.push(protocol);
      if (requiresPreview) {
        player.write("play_status", { status: "failed_client" });
        closeTimer = setTimeout(() => player.close("kick"), 100);
        return false;
      }
      return original(protocol);
    };
    player.on("join", () => finish("joined"));
  });
  try {
    await server.listen();
    const advertisement = await discoverBedrockServer("127.0.0.1", port);
    const selection = selectBedrockVersion(advertisement);
    client = createClient({ host: "127.0.0.1", port, version: selection.version, skipPing: true,
      offline: true, username: "FixtureBot", followPort: false,
      raknetBackend: "jsp-raknet", useRaknetWorkers: false, conLog: () => {} });
    client.on("error", fail);
    client.on("play_status", (packet: { status: string }) => {
      const failure = bedrockLoginFailure(packet);
      if (failure) finish(failure);
    });
    const outcome = await Promise.race([result, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("Local Bedrock negotiation timed out")), 5000);
    })]);
    return { advertisement, selection, protocols, outcome };
  } finally {
    clearTimeout(timeout);
    clearTimeout(closeTimer);
    client?.close();
    await server.close();
  }
}

it("completes encrypted login when a server advertises 2225 but accepts stable 2193", async () => {
  const result = await connect(false);
  expect(result.advertisement).toEqual({ protocol: 2225, version: "26.60" });
  expect(result.selection.negotiating).toBe(true);
  expect(result.protocols).toEqual([2193, 2193]); // network settings and login
  expect(result.outcome).toBe("joined");
});

it("surfaces the server refusal when it requires the unsupported preview protocol", async () => {
  const result = await connect(true);
  expect(result.protocols).toEqual([2193]);
  expect(result.outcome).toContain("The server requires a newer Bedrock client/protocol version");
  expect(result.outcome).toContain("failed_client");
});
