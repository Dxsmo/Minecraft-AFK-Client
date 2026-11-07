/** Normal disconnects retain the familiar 15s delay. Explicit server login
 * throttles and repeated unavailable-service failures need real breathing room. */
export class ReconnectPolicy {
  private failures = 0;
  private loginRejections = 0;
  reset(): void { this.failures = this.loginRejections = 0; }
  delay(reason: string, stableForMs: number): number {
    if (stableForMs >= 120_000) this.reset();
    this.failures++;
    if (/logging in too fast|too many (?:login|connection)|login.*rate.?limit|zu (?:schnell|viele).*anmeld/i.test(reason)) {
      this.loginRejections++;
      return Math.min(300_000, 60_000 * 2 ** Math.min(3, this.loginRejections - 1));
    }
    if (/suspicious packets|too many packets in a bundle/i.test(reason)) return 60_000;
    if (/deadline_exceeded|ECONNREFUSED|unavailable|fetch failed/i.test(reason))
      return Math.min(120_000, 15_000 * 2 ** Math.max(0, Math.min(3, this.failures - 2)));
    return 15_000;
  }
}
