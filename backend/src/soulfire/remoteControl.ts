import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { Code, ConnectError } from "@connectrpc/connect";
import { config } from "../config/config.js";
import { logger } from "../logging/logger.js";
import { readRemoteAccount } from "./auth.js";
import { soulFireRpc } from "./rpc.js";
import { setRemoteControl } from "./remoteState.js";

const eventSchema = z.object({
  kind: z.number().int().min(0).max(4), code: z.number().int().min(0).max(0x10ffff).default(0),
  action: z.number().int().min(0).max(2).default(0), modifiers: z.number().int().min(0).max(63).default(0),
  x: z.number().min(-10000).max(10000).default(0), y: z.number().min(-10000).max(10000).default(0),
  relative: z.boolean().default(false), key: z.string().max(64).optional(),
}).strict().refine(event => {
  if (event.kind === 0) return event.code >= 32 && event.code <= 348 && event.code !== 256 && event.key !== "Escape"; // Escape belongs to the browser.
  if (event.kind === 1) return event.code >= 32 && !(event.code >= 0xd800 && event.code <= 0xdfff);
  if (event.kind === 2) return event.code <= 7;
  return event.kind !== 3 || event.relative || (event.x >= 0 && event.x <= 1 && event.y >= 0 && event.y <= 1);
}, "Invalid input event");
export const remoteInputSchema = z.object({
  type: z.literal("input"), captured: z.boolean(), events: z.array(eventSchema).max(128), requestKeyFrame: z.boolean().optional(),
  inputId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  feedback: z.object({
    receivedSequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    deliveryDelayMs: z.number().min(0).max(60000), decoderQueueSize: z.number().int().min(0).max(64),
    decoderRecoveries: z.number().int().min(0).max(2147483647),
  }).strict().optional(),
}).strict();
export type RemoteInput = z.infer<typeof remoteInputSchema>;
type Message = Record<string, unknown>;
const owners = new Map<string, RemoteControlSession>();

/** A website-owned lease. Native capability tokens never leave the backend. */
export class RemoteControlSession {
  private rpc = soulFireRpc();
  private abort = new AbortController();
  private sessionId = randomUUID();
  private token = "";
  private sequence = 0n;
  private stopped = false;
  private restoring?: Promise<void>;
  private stream?: Promise<void>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private startup?: ReturnType<typeof setTimeout>;
  private lastInput = Date.now();
  private pending: RemoteInput["events"] = [];
  private captured = true;
  private keyFrame = false;
  private sending = false;
  private active = false;
  private starting = true;
  private receivedInputId = 0;
  private acknowledgedInputId = 0;
  private feedback?: RemoteInput["feedback"];

  constructor(readonly accountId: string, private send: (message: Message) => boolean,
    private fail: (message: string) => void) {}

  async start(): Promise<void> {
    if (owners.has(this.accountId)) throw new Error("Dieser Account wird bereits ferngesteuert.");
    owners.set(this.accountId, this);
    try {
      this.startup = setTimeout(() => {
        this.fail("SoulFire liefert kein Steuerungsbild. Bitte Auslastung und SoulFire-Logs prüfen und erneut versuchen."); void this.stop();
      }, 25_000);
      this.active = true;
      await setRemoteControl(this.accountId, true);
      if (this.stopped) { await this.restore(); return; }
      const ids = await readRemoteAccount(path.join(config.dataDir, "bot-cache", this.accountId));
      if (!ids) throw new Error("Der Account ist nicht verbunden.");
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastInput > 5000) { this.fail("Die Steuerung wurde wegen einer unterbrochenen Eingabeverbindung freigegeben."); void this.stop(); }
      }, 500);
      this.stream = (async () => {
        let awaitKey = true;
        for await (const frame of this.rpc.pov.watch({ ...ids, sessionId: this.sessionId, width: 480, height: 270, maxFps: 15, codecs: ["h264"] }, { signal: this.abort.signal, timeoutMs: 0 })) {
          if (this.stopped) return;
          if (frame.inputToken && !this.token) { this.token = frame.inputToken; void this.flush(); }
          if (!frame.data.length) continue;
          if (awaitKey && !frame.keyFrame) continue;
          if (frame.keyFrame) awaitKey = false;
          clearTimeout(this.startup);
          const sent = this.send({ type: "video", codec: frame.codec, keyFrame: frame.keyFrame,
            timestamp: Number(frame.timestampUs), sequence: Number(frame.sequence ?? 0n), width: frame.width, height: frame.height,
            screenOpen: frame.screenOpen, data: Buffer.from(frame.data).toString("base64") });
          if (!sent) { awaitKey = true; this.keyFrame = true; }
        }
        if (!this.stopped) throw new Error("Die Fernsteuerung wurde unterbrochen.");
      })().catch(error => {
        if (!this.stopped) { this.fail(error instanceof Error ? error.message : "Fernsteuerung nicht verfügbar."); void this.stop(); }
      });
    } catch (error) { await this.stop(); throw error; }
    finally {
      this.starting = false;
      if (this.stopped) { await this.restore(); if (owners.get(this.accountId) === this) owners.delete(this.accountId); }
    }
  }

  input(input: RemoteInput): void {
    if (this.stopped) return;
    this.lastInput = Date.now(); this.captured = input.captured;
    if (input.feedback && input.feedback.receivedSequence >= (this.feedback?.receivedSequence ?? 0)) this.feedback = input.feedback;
    if (input.inputId !== undefined) {
      if (input.inputId <= this.receivedInputId) {
        this.fail("Die Reihenfolge der Steuerungseingaben ist ungültig. Bitte erneut verbinden."); void this.stop(); return;
      }
      this.receivedInputId = input.inputId;
    }
    for (const event of input.events) {
      const previous = this.pending.at(-1);
      if (event.kind === 3 && previous?.kind === 3 && previous.relative === event.relative) {
        if (event.relative) {
          previous.x = Math.max(-10000, Math.min(10000, previous.x + event.x));
          previous.y = Math.max(-10000, Math.min(10000, previous.y + event.y));
        } else this.pending[this.pending.length - 1] = { ...event };
      } else this.pending.push({ ...event });
    }
    this.keyFrame ||= !!input.requestKeyFrame;
    if (this.pending.length > 256) { this.fail("Zu viele unbearbeitete Tastatur- oder Klick-Eingaben. Steuerung wurde freigegeben; bitte erneut verbinden."); void this.stop(); return; }
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.sending || this.stopped || !this.token) return;
    this.sending = true;
    try {
      do {
        const events = this.pending.splice(0, 128), requestKeyFrame = this.keyFrame; this.keyFrame = false;
        const inputId = this.pending.length ? 0 : this.receivedInputId;
        await this.rpc.pov.input({ sessionId: this.sessionId, inputToken: this.token, sequence: ++this.sequence,
          captured: this.captured, events, requestKeyFrame, width: 480, height: 270, escape: false, audioEnabled: false,
          ...(this.feedback ? { feedback: { ...this.feedback, receivedSequence: BigInt(this.feedback.receivedSequence) } } : {}) },
          // Native input itself waits up to 5s for the game thread. A shorter
          // browser-side deadline used to kill otherwise valid slow starts.
          { signal: this.abort.signal, timeoutMs: 6000 });
        if (this.stopped) return;
        // Acknowledge actual native processing, rather than receipt by the
        // website. Browsers can then pace input to a busy Minecraft client.
        if (inputId > this.acknowledgedInputId && this.send({ type: "inputAck", inputId })) this.acknowledgedInputId = inputId;
      } while (!this.stopped && (this.pending.length || this.keyFrame));
    } catch (error) {
      if (!this.stopped) {
        logger.warn({ err: error, accountId: this.accountId, queuedInputs: this.pending.length }, "Remote input failed");
        const failure = ConnectError.from(error);
        this.fail(failure.code === Code.DeadlineExceeded || /timed out|timeout|deadline/i.test(failure.rawMessage)
          ? "Der Minecraft-Client hat die Steuerungseingaben nicht rechtzeitig verarbeitet. Steuerung wurde freigegeben; bitte SoulFire-Auslastung prüfen."
          : "Die Eingabeverbindung zum Minecraft-Client wurde unterbrochen. Steuerung wurde freigegeben; bitte erneut verbinden.");
        void this.stop();
      }
    } finally { this.sending = false; }
  }

  private restore(): Promise<void> {
    if (!this.active) return Promise.resolve();
    return this.restoring ??= setRemoteControl(this.accountId, false).catch(() => undefined).finally(() => { this.active = false; });
  }

  async stop(): Promise<void> {
    if (this.stopped) { await this.restoring; return; }
    this.stopped = true; clearInterval(this.heartbeat); clearTimeout(this.startup);
    // Cancelling Watch releases native keyboard/mouse state and its control
    // lease immediately. Escape is never forwarded to Minecraft.
    this.abort.abort(); this.pending = [];
    if (this.starting) return; // start() restores after an in-flight preparation.
    await this.stream;
    await this.restore();
    if (owners.get(this.accountId) === this) owners.delete(this.accountId);
  }
}
