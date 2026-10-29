import readline from "node:readline";
import { runSoulFire, type SoulFireConfig } from "./session.js";
const emit = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(event)}\n`);
const abort = new AbortController();
const queued: Record<string, any>[] = [];
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let configReceived = false;
let resolveConfig: (config: SoulFireConfig) => void;
let rejectConfig: (error: Error) => void;
const configPromise = new Promise<SoulFireConfig>((resolve, reject) => { resolveConfig = resolve; rejectConfig = reject; });
input.on("line", line => {
  try {
    const command = JSON.parse(line);
    if (!configReceived) { configReceived = true; resolveConfig(command); }
    else if (command.type === "disconnect") abort.abort();
    else queued.push(command);
  } catch { if (!configReceived) rejectConfig(new Error("Ungültige Client-Konfiguration")); }
});
input.on("close", () => { if (!configReceived) rejectConfig(new Error("Client-Konfiguration fehlt")); abort.abort(); });
process.on("SIGTERM", () => abort.abort());
process.on("SIGINT", () => abort.abort());


void configPromise.then(config => runSoulFire(config, emit, abort, queued)).catch(error => {
  if (!abort.signal.aborted) emit({ type: "connection_failed", error: error instanceof Error ? error.message : "SoulFire-Verbindung fehlgeschlagen" });
  process.exitCode = 1;
}).finally(() => { input.close(); process.exit(); });
