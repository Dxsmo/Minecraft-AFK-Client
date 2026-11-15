import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import readline from "node:readline";
import { reserveStartup } from "./startupGate.js";

export type BotProcess = BotProcessController;

/** Admission happens before creating an OS process, so a reconnect wave does
 * not load every protocol/physics engine at once. Each account still has its
 * own failure boundary after admission. */
class BotProcessController extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  private abort = new AbortController();
  private child?: ChildProcessWithoutNullStreams;
  private first = true;
  private finished = false;
  private buffer = "";
  private queued: string[] = [];

  constructor(private edition: "JAVA" | "BEDROCK") {
    super();
    this.stdin = new Writable({ write: (chunk, _encoding, callback) => {
      try {
        this.buffer += chunk.toString();
        if (this.buffer.length > 1_048_576) throw new Error("Bot command exceeds input limit");
        let end: number;
        while ((end = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
          if (!line.trim() || this.finished) continue;
          const command = JSON.parse(line);
          if (command.type === "disconnect") { this.kill(); continue; }
          if (this.first) {
            this.first = false;
            void this.start(command).catch(error => {
              if (!this.finished) {
                this.stdout.write(JSON.stringify({ type: "connection_failed", error: error instanceof Error ? error.message : String(error) }) + "\n");
                this.finish(1, null);
              }
            });
          }
          this.queued.push(line + "\n"); this.flush();
          if (this.queued.length > 128) throw new Error("Bot command queue is full");
        }
        callback();
      } catch (error) { callback(error instanceof Error ? error : new Error(String(error))); }
    } });
    this.stdin.on("finish", () => this.kill());
  }

  private async start(config: { host: string; port: number }): Promise<void> {
    const release = await reserveStartup(`${this.edition}:${config.host.toLowerCase()}:${config.port}`, this.abort.signal);
    if (this.abort.signal.aborted) { release(); return; }
    try {
      const child = this.child = spawnBotProcess(this.edition);
      child.stdout.pipe(this.stdout, { end: false }); child.stderr.pipe(this.stderr, { end: false });
      const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on("line", line => { try { if (["spawn", "msa_code"].includes(JSON.parse(line).type)) release(); } catch { /* Ignore external logs. */ } });
      child.stdin.on("error", error => { if (!this.finished) this.stdin.emit("error", error); });
      child.once("error", error => { release(); this.emit("error", error); });
      child.once("close", (code, signal) => { release(); lines.close(); this.finish(code, signal); });
      this.flush();
    } catch (error) { release(); throw error; }
  }

  private flush(): void {
    if (this.child?.stdin.writable) for (const line of this.queued.splice(0)) this.child.stdin.write(line);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.finished) return false;
    this.killed = true; this.abort.abort();
    if (this.child) return this.child.kill(signal);
    this.finish(null, signal); return true;
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.finished) return;
    this.finished = true; this.abort.abort(); this.queued.length = 0; this.buffer = "";
    this.exitCode = code; this.signalCode = signal;
    this.stdin.destroy(); this.stdout.end(); this.stderr.end();
    queueMicrotask(() => { this.emit("exit", code, signal); this.emit("close", code, signal); });
  }
}

/** Native RakNet failures and Java protocol errors are isolated per account.
 * Launch the matching source entry in development and compiled JS in Docker. */
function spawnBotProcess(edition: "JAVA" | "BEDROCK"): ChildProcessWithoutNullStreams {
  const development = import.meta.url.endsWith(".ts");
  const engine = edition === "BEDROCK" ? "bedrock-bot" : "mineflayer-bot";
  const entry = fileURLToPath(new URL(`../${engine}/index.${development ? "ts" : "js"}`, import.meta.url));
  const args = development ? ["--import", createRequire(import.meta.url).resolve("tsx/esm"), entry] : [entry];
  return spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, DEBUG: "" } });
}

export const createBotProcess = (edition: "JAVA" | "BEDROCK"): BotProcess => new BotProcessController(edition);
