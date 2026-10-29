import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { runSoulFire, type SoulFireConfig } from "./session.js";

/** NDJSON-compatible controller with a private queue, cancellation scope and
 * error boundary. No Node subprocess/worker is allocated per Minecraft account.
 * The CLI in index.ts uses the same session runner for integration diagnostics. */
export class SoulFireController extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  private readonly abort = new AbortController();
  private readonly queued: Record<string, any>[] = [];
  private receivedConfig = false;
  private finished = false;
  private buffer = "";

  constructor() {
    super();
    this.stdin = new Writable({ write: (chunk, _encoding, callback) => {
      try {
        this.buffer += chunk.toString();
        let end: number;
        while ((end = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
          if (line.trim()) this.receive(JSON.parse(line));
        }
        callback();
      } catch (error) { callback(error instanceof Error ? error : new Error("Ungültige Controller-Nachricht")); }
    } });
    this.stdin.on("finish", () => this.kill());
  }

  private receive(command: Record<string, any>) {
    if (this.finished || this.abort.signal.aborted) return;
    if (!this.receivedConfig) {
      this.receivedConfig = true;
      void runSoulFire(command as SoulFireConfig, event => {
        if (!this.finished) this.stdout.write(`${JSON.stringify(event)}\n`);
      }, this.abort, this.queued).then(() => this.finish(0)).catch(error => {
        if (!this.finished && !this.abort.signal.aborted) this.stdout.write(`${JSON.stringify({ type: "connection_failed", error: error instanceof Error ? error.message : "SoulFire-Verbindung fehlgeschlagen" })}\n`);
        this.finish(1);
      });
    } else if (command.type === "disconnect") this.kill();
    else this.queued.push(command);
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.finished) return false;
    this.killed = true; this.abort.abort();
    if (!this.receivedConfig || signal === "SIGKILL" || signal === 9) this.finish(null, typeof signal === "string" ? signal : "SIGKILL");
    return true;
  }

  private finish(code: number | null, signal: NodeJS.Signals | null = null) {
    if (this.finished) return;
    this.finished = true; this.abort.abort(); this.queued.length = 0;
    this.exitCode = code; this.signalCode = signal;
    this.stdin.destroy(); this.stdout.end(); this.stderr.end();
    queueMicrotask(() => { this.emit("exit", code, signal); this.emit("close", code, signal); });
  }
}
export const createSoulFireController = () => new SoulFireController();
