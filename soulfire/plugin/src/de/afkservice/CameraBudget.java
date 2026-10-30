package de.afkservice;

/** A visual limit only: all entities remain tracked and can still be picked up. */
public final class CameraBudget {
  private static final ThreadLocal<Integer> ITEMS = ThreadLocal.withInitial(() -> 0);
  private static final ThreadLocal<Boolean> PROGRESSIVE = ThreadLocal.withInitial(() -> false);
  public static void begin(boolean progressive) { ITEMS.set(0); PROGRESSIVE.set(progressive); }
  public static boolean progressive() { return PROGRESSIVE.get(); }
  public static boolean item() { int count = ITEMS.get(); ITEMS.set(count + 1); return count < 128; }
}
