package de.afkservice;

/** Finite, coalesced retry windows. Server rejection bursts must neither spam
 * retries nor multiply into a permanent pause. All times are caller supplied. */
public final class SellRecovery {
  private long until, lastRejection = Long.MIN_VALUE / 2;
  private int failures;

  public synchronized void rejected(long now) {
    if (now - lastRejection >= 1000) {
      failures = Math.min(5, failures + 1);
      lastRejection = now;
    }
    until = Math.max(until, now + Math.min(30_000, 2000L << Math.max(0, failures - 1)));
  }
  public synchronized void confirmed() { failures = 0; }
  public synchronized boolean paused(long now) { return now < until; }
  public synchronized long until() { return until; }

  public static boolean inventoryBlocked(String message) {
    var text = message.replaceAll("§.", "").trim();
    return text.matches("(?i)^(?:\\[HugoSMP\\]\\s*)?Du kannst dies nicht tun, weil dein Inventar gerade gespeichert oder geladen wird[.!]?$");
  }
  public static boolean payout(String message) {
    return message.replaceAll("§.", "").trim().matches("(?i)^(?:\\[HugoSMP\\]\\s*)?\\+\\$\\d[\\d.,]*(?:\\s.*)?$");
  }
}
