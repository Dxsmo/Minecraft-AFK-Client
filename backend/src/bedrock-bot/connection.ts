/** Connection stages are bounded separately: token refresh is not world loading. */
const phases = {
  discovery: "server discovery",
  authentication: "Microsoft/Xbox authentication",
  transport: "RakNet/UDP connection",
  login: "server login",
  resources: "resource-pack handshake",
  world: "world initialization",
  spawned: "spawned",
} as const;
type Phase = keyof typeof phases;
const order = Object.keys(phases) as Phase[];

export class BedrockConnectionProgress {
  private phase: Phase = "discovery";
  private phaseStartedAt = Date.now();
  private deadline: number;

  constructor(private readonly timeoutMs: number, private readonly authTimeoutMs = Math.max(timeoutMs, 120_000)) {
    this.deadline = this.phaseStartedAt + timeoutMs;
  }

  /** Repeated packets and late lifecycle events must not extend a stalled join. */
  advance(phase: Phase): boolean {
    if (order.indexOf(phase) <= order.indexOf(this.phase)) return false;
    this.phase = phase;
    this.phaseStartedAt = Date.now();
    this.deadline = this.phaseStartedAt + (phase === "authentication" ? this.authTimeoutMs : this.timeoutMs);
    return true;
  }

  waitForDeviceCode(expiresIn: number): void {
    this.advance("authentication");
    if (Number.isFinite(expiresIn) && expiresIn > 0) this.deadline = Date.now() + (expiresIn + 30) * 1000;
  }

  get timedOut(): boolean {
    return this.phase !== "spawned" && Date.now() >= this.deadline;
  }

  timeoutMessage(host: string, port: number, version: string): string {
    const seconds = Math.floor((Date.now() - this.phaseStartedAt) / 1000);
    return `Timed out before joining the world: ${phases[this.phase]} (${seconds}s; ${host}:${port}; version ${version || "auto"})`;
  }

  failureMessage(error: string, host: string, port: number, version: string): string {
    return /timed?\s*out|timeout/i.test(error)
      ? `${this.timeoutMessage(host, port, version)}; ${error}`
      : error;
  }
}

/** Refusal statuses are terminal even when the library also emits "join". */
export function bedrockLoginFailure(packet: unknown): string | null {
  const status = (packet as { status?: unknown } | null)?.status;
  if (typeof status !== "string" || !status.startsWith("failed_")) return null;
  const reasons: Record<string, string> = {
    failed_client: "The server requires a newer Bedrock client/protocol version",
    failed_spawn: "The Bedrock client/protocol version is newer than the server supports",
    failed_server_full: "The Bedrock server is full",
    failed_invalid_tenant: "The account cannot access this Minecraft Education server",
    failed_vanilla_edu: "The server requires Minecraft Education",
    failed_edu_vanilla: "The server does not accept Minecraft Education clients",
  };
  return `Bedrock login rejected: ${reasons[status] ?? status} (${status})`;
}
