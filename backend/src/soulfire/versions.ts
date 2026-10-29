import net from "node:net";
import { resolveSrv } from "node:dns/promises";
import type { SoulFireRpc } from "./rpc.js";

export type ProtocolOption = { id: string; displayName: string; keywords: string[] };
export async function protocolOptions(rpc: SoulFireRpc, instanceId?: string): Promise<ProtocolOption[]> {
  const id = instanceId || (await rpc.instance.getOrCreateInstance({ name: "afk-version-catalog" })).id;
  const response = await rpc.instance.getInstanceInfo({ id });
  if (response.result.case !== "info") throw new Error("SoulFire-Versionsliste ist nicht verfügbar");
  const definition = response.result.value.settingsDefinitions.find(d => d.id?.namespace === "bot" && d.id.key === "protocol-version");
  if (definition?.type.case !== "combo") throw new Error("SoulFire-Protokollauswahl fehlt");
  return definition.type.value.options;
}

export function versionCatalog(options: ProtocolOption[]) {
  const bedrock = options.filter(v => v.displayName.startsWith("Bedrock ")).map(v => v.displayName.slice(8));
  // Keep aliases selectable, e.g. 26.1.2 maps to SoulFire's 26.1–26.1.2 codec.
  const java = [...new Set(options.filter(v => v.id.startsWith("RELEASE|")).flatMap(v => v.keywords.filter(k => /^\d+\.\d+(?:\.\d+)?$/.test(k))))];
  return { java: { versions: java, defaultVersion: java[0] }, bedrock: { versions: bedrock, defaultVersion: bedrock[0] } };
}

export function selectProtocol(options: ProtocolOption[], edition: "JAVA" | "BEDROCK", requested: string, advertised?: number): ProtocolOption {
  const available = options.filter(v => edition === "BEDROCK" ? v.displayName.startsWith("Bedrock ") : v.id.startsWith("RELEASE|"));
  const selected = requested ? available.find(v => v.displayName === requested || v.displayName === `Bedrock ${requested}` || v.keywords.includes(requested))
    : edition === "JAVA" && advertised !== undefined ? available.find(v => v.id === `RELEASE|${advertised}`) : available[0];
  if (!selected) throw new Error(`SoulFire unterstützt ${edition} ${requested || `Protokoll ${advertised}`} nicht. Bitte eine Version aus der aktuellen Auswahl verwenden.`);
  return selected;
}

export function varInt(value: number): Buffer {
  const bytes: number[] = []; let remaining = value >>> 0;
  do { let byte = remaining & 127; remaining >>>= 7; if (remaining) byte |= 128; bytes.push(byte); } while (remaining);
  return Buffer.from(bytes);
}
function readVarInt(buffer: Buffer, offset = 0): { value: number; bytes: number } | null {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (offset + i >= buffer.length) return null;
    const byte = buffer[offset + i]; value |= (byte & 127) << (7 * i);
    if (!(byte & 128)) return { value, bytes: i + 1 };
  }
  throw new Error("Ungültige Minecraft-Statusantwort");
}

/** Vanilla status ping, bounded before authentication. No Minecraft login. */
export async function javaServerProtocol(host: string, port: number): Promise<number> {
  let connectHost = host, connectPort = port;
  if (port === 25565 && !net.isIP(host)) {
    const records = await resolveSrv(`_minecraft._tcp.${host}`).catch(() => []);
    const target = records.sort((a, b) => a.priority - b.priority)[0];
    if (target) { connectHost = target.name; connectPort = target.port; }
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: connectHost, port: connectPort });
    let buffer = Buffer.alloc(0), finished = false;
    const finish = (error?: Error, protocol?: number) => { if (finished) return; finished = true; socket.destroy(); if (error) reject(error); else resolve(protocol!); };
    socket.setTimeout(5000, () => finish(new Error("Minecraft-Statusabfrage hat nicht rechtzeitig geantwortet")));
    socket.on("error", error => finish(error));
    socket.on("end", () => finish(new Error("Minecraft-Statusabfrage wurde beendet")));
    socket.on("connect", () => {
      const address = Buffer.from(host); const portBytes = Buffer.alloc(2); portBytes.writeUInt16BE(port);
      const packet = Buffer.concat([varInt(0), varInt(-1), varInt(address.length), address, portBytes, varInt(1)]);
      socket.write(Buffer.concat([varInt(packet.length), packet, Buffer.from([1, 0])]));
    });
    socket.on("data", chunk => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > 1024 * 1024) throw new Error("Minecraft-Statusantwort zu groß");
        const packet = readVarInt(buffer); if (!packet || buffer.length < packet.bytes + packet.value) return;
        const id = readVarInt(buffer, packet.bytes); if (!id || id.value !== 0) throw new Error("Ungültiges Minecraft-Statuspaket");
        const length = readVarInt(buffer, packet.bytes + id.bytes); if (!length || length.value < 0 || packet.bytes + id.bytes + length.bytes + length.value > buffer.length) throw new Error("Ungültige Minecraft-Statuslänge");
        const start = packet.bytes + id.bytes + length.bytes;
        const response = JSON.parse(buffer.subarray(start, start + length.value).toString());
        if (!Number.isSafeInteger(response.version?.protocol) || response.version.protocol < 0) throw new Error("Server meldet keine Minecraft-Protokollversion");
        finish(undefined, response.version.protocol);
      } catch (error) { finish(error instanceof Error ? error : new Error("Ungültiger Minecraft-Status")); }
    });
  });
}
