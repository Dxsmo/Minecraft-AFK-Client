import { createSocket } from "node:dgram";
import { once } from "node:events";
import { expect, it } from "vitest";
import { discoverBedrockServer } from "../../src/bedrock-bot/discovery.js";

const magic = Buffer.from("00ffff00fefefefefdfdfdfd12345678", "hex");
function pong(request: Buffer, text = "MCPE;Local regression;2193;26.51;0;10;1;World;Survival;1;9;9;") {
  const message = Buffer.from(text);
  const packet = Buffer.alloc(35 + message.length);
  packet[0] = 0x1c;
  request.copy(packet, 1, 1, 9);
  packet.writeBigInt64BE(1n, 9);
  magic.copy(packet, 17);
  packet.writeUInt16BE(message.length, 33);
  message.copy(packet, 35);
  return packet;
}

it("discovers the protocol at the configured UDP port, regardless of an advertised port", async () => {
  const server = createSocket("udp4");
  server.bind(0, "127.0.0.1"); await once(server, "listening");
  server.on("message", (request, sender) => {
    expect(request[0]).toBe(0x01);
    expect(request.subarray(9, 25)).toEqual(magic);
    server.send(pong(request), sender.port, sender.address);
  });
  try {
    expect(await discoverBedrockServer("127.0.0.1", server.address().port)).toEqual({ protocol: 2193, version: "26.51" });
  } finally { server.close(); }
});

it("ignores truncated, malformed and unrelated status replies until a matching pong arrives", async () => {
  const server = createSocket("udp4");
  server.bind(0, "127.0.0.1"); await once(server, "listening");
  server.on("message", (request, sender) => {
    const wrongTime = pong(request); wrongTime[1] ^= 1;
    const wrongMagic = pong(request); wrongMagic[17] ^= 1;
    for (const packet of [Buffer.from([0x1c]), wrongTime, wrongMagic, pong(request).subarray(0, 36), pong(request, "MCPE;Bad;invalid;26.51;")]) {
      server.send(packet, sender.port, sender.address);
    }
    server.send(pong(request), sender.port, sender.address);
  });
  try {
    expect(await discoverBedrockServer("127.0.0.1", server.address().port)).toEqual({ protocol: 2193, version: "26.51" });
  } finally { server.close(); }
});

it("bounds silent endpoints and releases the discovery socket", async () => {
  const server = createSocket("udp4");
  server.bind(0, "127.0.0.1"); await once(server, "listening");
  try {
    await expect(discoverBedrockServer("127.0.0.1", server.address().port, 50)).rejects.toThrow("Bedrock server discovery timed out");
  } finally { server.close(); }
});
