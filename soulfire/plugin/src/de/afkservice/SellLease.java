package de.afkservice;

import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/** Controller liveness is transient. Never persist a heartbeat to SQLite or
 * accept a lease left in account settings by an earlier JVM/controller. */
public final class SellLease {
  private record Key(UUID instance, UUID bot) {}
  private static final ConcurrentHashMap<Key, Long> DEADLINES = new ConcurrentHashMap<>();

  public static void renew(UUID instance, UUID bot, long until, long now) {
    DEADLINES.entrySet().removeIf(entry -> entry.getValue() <= now);
    var key = new Key(instance, bot);
    if (until <= now) DEADLINES.remove(key);
    else DEADLINES.put(key, Math.min(until, now + 15_000));
  }

  public static boolean valid(UUID instance, UUID bot, long now) {
    var until = DEADLINES.get(new Key(instance, bot));
    return until != null && until > now;
  }
}
