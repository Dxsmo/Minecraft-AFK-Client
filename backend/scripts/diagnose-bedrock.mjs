import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { lookup } from "node:dns/promises";
import { pathToFileURL } from "node:url";

const magic = Buffer.from("00ffff00fefefefefdfdfdfd12345678", "hex");

// A separate, explicitly invoked network test. Sends no Bedrock login, commands,
// Microsoft tokens or account names. Stops after the offline RakNet handshake.
export async function diagnoseBedrock(host = "HugoSMP.net", port = 19132, waitMs = 1500) {
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw Error("Invalid host or UDP port");
  const { address } = await lookup(host, { family: 4 });
  const socket = createSocket("udp4");
  const clientGuid = randomBytes(8);
  const result = { endpoint: `${host}:${port}`, ipv4: address, status: null, request1: [], request2: null };
  let receive;
  let cancelWait;
  let socketError;
  socket.on("message", packet => receive?.(packet));
  socket.on("error", error => { socketError = error; cancelWait?.(error); });

  function exchange(request, accept) {
    return new Promise((resolve, reject) => {
      if (socketError) { reject(socketError); return; }
      let done = false;
      const ignored = new Set();
      const finish = (error, reply = null) => {
        if (done) return;
        done = true;
        clearTimeout(deadline);
        clearTimeout(retry);
        receive = undefined;
        cancelWait = undefined;
        if (error) reject(error);
        else resolve({ reply, unexpectedIds: [...ignored] });
      };
      const send = () => socket.send(request, error => { if (error) finish(error); });
      const deadline = setTimeout(() => finish(), waitMs);
      const retry = setTimeout(send, waitMs / 2);
      cancelWait = error => finish(error);
      receive = packet => {
        const reply = accept(packet);
        if (reply) finish(undefined, reply);
        else if (packet.length && ignored.size < 16) ignored.add(`0x${packet[0].toString(16).padStart(2, "0")}`);
      };
      send();
    });
  }

  try {
    await new Promise((resolve, reject) => {
      cancelWait = reject;
      socket.connect(port, address, resolve);
    });
    const ping = Buffer.alloc(33);
    ping[0] = 0x01;
    ping.writeBigInt64BE(BigInt(Date.now()), 1);
    magic.copy(ping, 9);
    clientGuid.copy(ping, 25);
    const status = await exchange(ping, packet => {
      if (packet.length < 35 || packet[0] !== 0x1c || !packet.subarray(1, 9).equals(ping.subarray(1, 9))
        || !packet.subarray(17, 33).equals(magic)) return;
      const length = packet.readUInt16BE(33);
      if (length > packet.length - 35) return;
      const [type, , protocol, version] = packet.toString("utf8", 35, 35 + length).split(";");
      if (type !== "MCPE" || !/^\d+$/.test(protocol ?? "") || Number(protocol) <= 0 || !version) return;
      return { protocol: Number(protocol), version };
    });
    result.status = status.reply ?? { timeout: true, unexpectedIds: status.unexpectedIds };

    let firstReply;
    // Include the normal Bedrock MTU 1400, in addition to native RakNet's
    // 1492/1200/576 probes. Reuse the same UDP socket for ping and handshake.
    for (const mtu of [1492, 1400, 1200, 576]) {
      const request = Buffer.alloc(mtu - 28);
      request[0] = 0x05;
      magic.copy(request, 1);
      request[17] = 11;
      const response = await exchange(request, packet => {
        if (packet.length < 28 || packet[0] !== 0x06 || !packet.subarray(1, 17).equals(magic)) return;
        const cookie = packet[25] !== 0;
        const length = cookie ? 32 : 28;
        if (packet.length < length) return;
        const negotiatedMtu = packet.readUInt16BE(length - 2);
        if (negotiatedMtu < 576 || negotiatedMtu > 1492) return;
        return { mtu: negotiatedMtu, cookie, packet };
      });
      result.request1.push({ mtu, received: !!response.reply, unexpectedIds: response.unexpectedIds });
      if (response.reply) { firstReply = response.reply; break; }
    }
    if (!firstReply) {
      result.conclusion = "No valid OpenConnectionReply1: status discovery does not establish RakNet connectivity. Check server/proxy filtering and the Raspberry/container UDP path.";
      return result;
    }

    const request = Buffer.alloc(firstReply.cookie ? 39 : 34);
    request[0] = 0x07;
    magic.copy(request, 1);
    let offset = 17;
    if (firstReply.cookie) {
      firstReply.packet.copy(request, offset, 26, 30);
      offset += 4;
      request[offset++] = 0; // Cookie challenge, without LibCat encryption.
    }
    request[offset++] = 4;
    for (const octet of address.split(".")) request[offset++] = Number(octet) ^ 0xff;
    request.writeUInt16BE(port, offset); offset += 2;
    request.writeUInt16BE(firstReply.mtu, offset); offset += 2;
    clientGuid.copy(request, offset);
    const response = await exchange(request, packet => {
      if (packet.length < 35 || packet[0] !== 0x08 || !packet.subarray(1, 17).equals(magic)
        || !packet.subarray(17, 25).equals(firstReply.packet.subarray(17, 25))) return;
      const addressLength = packet[25] === 4 ? 7 : packet[25] === 6 ? 29 : 0;
      if (!addressLength || packet.length < 25 + addressLength + 3) return;
      const mtu = packet.readUInt16BE(25 + addressLength);
      if (mtu !== firstReply.mtu || packet[27 + addressLength] !== 0) return;
      return { mtu };
    });
    result.request2 = { received: !!response.reply, cookie: firstReply.cookie, mtu: firstReply.mtu, unexpectedIds: response.unexpectedIds };
    result.conclusion = response.reply
      ? "Offline RakNet handshake succeeded. This does not test native transport completion, Microsoft authentication or joining the world."
      : "OpenConnectionReply1 received, but no valid OpenConnectionReply2. Check cookie/MTU negotiation and server/proxy filtering.";
    return result;
  } finally {
    try { socket.close(); } catch { /* May have failed before binding. */ }
  }
}

// Also works via `node --input-type=module < backend/scripts/diagnose-bedrock.mjs`
// inside the existing Docker container, without rebuilding or stopping bots.
if (!process.argv[1] || pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const result = await diagnoseBedrock(process.argv[2] || "HugoSMP.net", Number(process.argv[3] || 19132));
    console.log(JSON.stringify(result, null, 2));
    if (!result.request2?.received) process.exitCode = 1;
  } catch (error) {
    console.error(`Bedrock network diagnostic failed: ${error.message}`);
    process.exitCode = 1;
  }
}
