import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";

const magic = Buffer.from("00ffff00fefefefefdfdfdfd12345678", "hex");

/** Query status without creating/closing a native RakNet peer alongside login. */
export function discoverBedrockServer(host: string, port: number, timeoutMs = 5000): Promise<{ protocol: number; version: string }> {
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    const request = Buffer.alloc(33);
    request[0] = 0x01;
    request.writeBigInt64BE(BigInt(Date.now()), 1);
    magic.copy(request, 9);
    randomBytes(8).copy(request, 25);
    let settled = false;
    let retry: ReturnType<typeof setInterval> | undefined;
    const timeout = setTimeout(() => finish(new Error(`Bedrock server discovery timed out (${host}:${port})`)), timeoutMs);

    function finish(error?: Error, advertisement?: { protocol: number; version: string }) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(retry);
      try { socket.close(); } catch { /* DNS may still be pending. */ }
      if (error) reject(error);
      else resolve(advertisement!);
    }

    socket.on("error", error => finish(error));
    socket.on("message", packet => {
      if (packet.length < 35 || packet[0] !== 0x1c
        || !packet.subarray(1, 9).equals(request.subarray(1, 9))
        || !packet.subarray(17, 33).equals(magic)) return;
      const length = packet.readUInt16BE(33);
      if (length > packet.length - 35) return;
      const [header, , protocolText, version] = packet.toString("utf8", 35, 35 + length).split(";");
      const protocol = Number(protocolText);
      if (header !== "MCPE" || !Number.isInteger(protocol) || protocol <= 0 || !version) return;
      finish(undefined, { protocol, version });
    });

    // A connected UDP socket accepts replies only from the configured endpoint.
    socket.connect(port, host, () => {
      if (settled) return;
      const send = () => { if (!settled) socket.send(request, error => { if (error) finish(error); }); };
      send();
      retry = setInterval(send, 1000);
    });
  });
}
