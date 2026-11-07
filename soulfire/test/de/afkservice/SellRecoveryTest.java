package de.afkservice;

public final class SellRecoveryTest {
  public static void main(String[] args) {
    var guard = new SellRecovery();
    for (int index = 0; index < 365; index++) guard.rejected(100_000 + index);
    assert guard.paused(101_000);
    assert !guard.paused(103_000) : "A burst of server replies must not multiply the retry deadline";
    guard.rejected(104_000);
    assert guard.paused(107_999);
    assert !guard.paused(108_000);
    for (int index = 0; index < 20; index++) guard.rejected(110_000 + index * 1000);
    assert !guard.paused(160_000) : "Backoff must remain finite";
    guard.confirmed(); guard.rejected(200_000);
    assert !guard.paused(202_000) : "A genuine payout restores the short retry window";
    assert SellRecovery.inventoryBlocked("[HugoSMP] Du kannst dies nicht tun, weil dein Inventar gerade gespeichert oder geladen wird.");
    assert !SellRecovery.inventoryBlocked("<Player> [HugoSMP] Du kannst dies nicht tun, weil dein Inventar gerade gespeichert oder geladen wird.");
    assert SellRecovery.payout("[HugoSMP] +$121,60 (Basis: $64, Bonus: +$57,60 durch 1.9x)");
    assert !SellRecovery.payout("<Player> +$121,60");
    System.out.println("Inventory rejection bursts, finite backoff, payout recovery and spoof filtering passed");
  }
}
