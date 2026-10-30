package de.afkservice;

/** Leave time for account ticks after expensive frames; never sleep on the game thread. */
public final class CameraPacing {
  public static long delayNanos(long requested, long elapsed) {
    return Math.max(requested, Math.min(1_000_000_000L, Math.max(0, elapsed) * 2));
  }
}
