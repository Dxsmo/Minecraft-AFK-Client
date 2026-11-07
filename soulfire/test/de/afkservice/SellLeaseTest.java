package de.afkservice;

import java.util.UUID;

/** Run with -ea. Uses a simulated clock; no Minecraft server or credentials. */
public final class SellLeaseTest {
  public static void main(String[] args) {
    var instance = UUID.randomUUID();
    var otherInstance = UUID.randomUUID();
    var bot = UUID.randomUUID();
    var otherBot = UUID.randomUUID();
    long now = 100_000;
    assert !SellLease.valid(instance, bot, now);
    SellLease.renew(instance, bot, now + 15_000, now);
    assert SellLease.valid(instance, bot, now + 14_999);
    assert !SellLease.valid(instance, bot, now + 15_000);
    assert !SellLease.valid(otherInstance, bot, now);
    assert !SellLease.valid(instance, otherBot, now);

    // A renewal keeps a busy account alive; another account's expiration
    // and revocation cannot stop it, even with the same profile UUID.
    SellLease.renew(otherInstance, bot, now + 15_000, now);
    SellLease.renew(instance, bot, now + 20_000, now + 5_000);
    SellLease.renew(otherInstance, bot, now, now + 6_000);
    assert SellLease.valid(instance, bot, now + 16_000);
    assert !SellLease.valid(otherInstance, bot, now + 6_000);

    // Never let a broken controller grant an indefinitely valid lease.
    SellLease.renew(instance, bot, Long.MAX_VALUE, now);
    assert SellLease.valid(instance, bot, now + 60_000);
    assert !SellLease.valid(instance, bot, now + SellLease.MAX_MILLIS);
    SellLease.renew(instance, bot, now - 1, now);
    assert !SellLease.valid(instance, bot, now);
    System.out.println("Sell lease expiration, renewal, revocation and account isolation passed");
  }
}
