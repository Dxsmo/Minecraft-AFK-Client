import { createSocket } from "node:dgram";
import { once } from "node:events";
import { expect, it } from "vitest";
// @ts-expect-error The standalone diagnostic intentionally needs only Node built-ins.
import { diagnoseBedrock } from "../../scripts/diagnose-bedrock.mjs";

const magic = Buffer.from("00ffff00fefefefefdfdfdfd12345678", "hex");
const serverGuid = Buffer.from("1234567890abcdef", "hex");
const cookie = Buffer.from("10203040", "hex");

function pong(request: Buffer) {
  const text = Buffer.from("MCPE;Test;2193;26.51;0;1;1;World;Survival;1;9;9;");
  const reply = Buffer.alloc(35 + text.length);
  reply[0] = 0x1c;
  request.copy(reply, 1, 1, 9);
  serverGuid.copy(reply, 9);
  magic.copy(reply, 17);
  reply.writeUInt16BE(text.length, 33);
  text.copy(reply, 35);
  return reply;
}

function reply1(withCookie: boolean) {
  const reply = Buffer.alloc(withCookie ? 32 : 28);
  reply[0] = 6;
  magic.copy(reply, 1);
  serverGuid.copy(reply, 17);
  reply[25] = Number(withCookie);
  if (withCookie) cookie.copy(reply, 26);
  reply.writeUInt16BE(1400, reply.length - 2);
  return reply;
}

function reply2() {
  const reply = Buffer.alloc(35);
  reply[0] = 8;
  magic.copy(reply, 1);
  serverGuid.copy(reply, 17);
  reply[25] = 4;
  reply.writeUInt16BE(1400, 32);
  return reply;
}

async function serverTest(handle: (request: Buffer, respond: (reply: Buffer) => void, port: number) => void) {
  const server = createSocket("udp4");
  server.bind(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port;
  server.on("message", (request, sender) => handle(request, reply => server.send(reply, sender.port, sender.address), port));
  try { return await diagnoseBedrock("127.0.0.1", port, 60); }
  finally { server.close(); }
}

it.each([false, true])("completes the offline handshake with cookie=%s on the same socket", async withCookie => {
  const ids: number[] = [];
  const result = await serverTest((request, respond, port) => {
    ids.push(request[0]);
    if (request[0] === 1) respond(pong(request));
    else if (request[0] === 5) {
      expect(request.length).toBe(1492 - 28);
      expect(request[17]).toBe(11);
      respond(reply1(withCookie));
    } else if (request[0] === 7) {
      expect(request.length).toBe(withCookie ? 39 : 34);
      const offset = withCookie ? 22 : 17;
      if (withCookie) {
        expect(request.subarray(17, 21)).toEqual(cookie);
        expect(request[21]).toBe(0);
      }
      expect(request.subarray(offset, offset + 5)).toEqual(Buffer.from([4, 128, 255, 255, 254]));
      expect(request.readUInt16BE(offset + 5)).toBe(port);
      expect(request.readUInt16BE(offset + 7)).toBe(1400);
      respond(reply2());
    } else throw Error("Diagnostic must never send a Minecraft login");
  });
  expect(ids).toEqual([1, 5, 7]);
  expect(result.status).toEqual({ protocol: 2193, version: "26.51" });
  expect(result.request2).toMatchObject({ received: true, cookie: withCookie, mtu: 1400 });
  expect(JSON.stringify(result)).not.toContain(cookie.toString("hex"));
});

it("distinguishes successful status discovery from a missing transport reply and tries four MTUs", async () => {
  const result = await serverTest((request, respond) => {
    if (request[0] === 1) respond(pong(request));
    else if (request[0] === 5) respond(Buffer.from([0x84, 0, 0]));
    else throw Error("Must not proceed without a valid reply1");
  });
  expect(result.status.protocol).toBe(2193);
  expect(result.request1.map((attempt: { mtu: number }) => attempt.mtu)).toEqual([1492, 1400, 1200, 576]);
  expect(result.request1.every((attempt: { received: boolean; unexpectedIds: string[] }) => !attempt.received && attempt.unexpectedIds.includes("0x84"))).toBe(true);
  expect(result.request2).toBeNull();
});

it("ignores malformed replies before accepting a valid cookie handshake", async () => {
  const result = await serverTest((request, respond) => {
    if (request[0] === 1) {
      const wrongTime = pong(request); wrongTime[1] ^= 1;
      respond(wrongTime);
      respond(pong(request));
    } else if (request[0] === 5) {
      const wrongMagic = reply1(true); wrongMagic[1] ^= 1;
      const badMtu = reply1(true); badMtu.writeUInt16BE(200, 30);
      for (const packet of [reply1(true).subarray(0, 28), wrongMagic, badMtu, reply1(true)]) respond(packet);
    } else if (request[0] === 7) {
      const wrongGuid = reply2(); wrongGuid[17] ^= 1;
      const badMtu = reply2(); badMtu.writeUInt16BE(576, 32);
      for (const packet of [reply2().subarray(0, 30), wrongGuid, badMtu, reply2()]) respond(packet);
    }
  });
  expect(result.request2.received).toBe(true);
});

it("reports a missing second reply separately from status or first-reply failures", async () => {
  const result = await serverTest((request, respond) => {
    if (request[0] === 1) respond(pong(request));
    else if (request[0] === 5) respond(reply1(true));
  });
  expect(result.request1[0].received).toBe(true);
  expect(result.request2).toMatchObject({ received: false, cookie: true });
  expect(result.conclusion).toContain("no valid OpenConnectionReply2");
});

it("continues probing RakNet even if the server does not advertise status", async () => {
  const result = await serverTest((request, respond) => {
    if (request[0] === 5) respond(reply1(false));
    else if (request[0] === 7) respond(reply2());
  });
  expect(result.status.timeout).toBe(true);
  expect(result.request2.received).toBe(true);
});
