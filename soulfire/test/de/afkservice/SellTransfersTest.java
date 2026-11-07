package de.afkservice;

public final class SellTransfersTest {
  public static void main(String[] args) {
    var transfers = new SellTransfers();
    for (int slot = 0; slot < 16; slot++) transfers.sent(slot, 100_000);
    assert !transfers.canSend();
    transfers.acknowledgeSlot(0); transfers.acknowledgePayout();
    assert transfers.inFlight() == 15 : "Slot and payout must not count as two transfers";
    transfers.sent(16, 100_100);
    assert !transfers.canSend();
    transfers.acknowledgeSlot(0); transfers.acknowledgeSlot(60);
    assert transfers.inFlight() == 16 : "Duplicate/unrelated slot replies must not grant credit";
    assert !transfers.stalled(104_999); assert transfers.stalled(105_000);
    for (int slot = 1; slot <= 16; slot++) transfers.acknowledgePayout();
    assert transfers.inFlight() == 0;
    assert !transfers.stalled(110_000);
    transfers.reset(); assert transfers.inFlight() == 0;
    // All 36 continuously refilled stacks complete in bounded windows, even
    // when the server reports both a slot update and a payout for each click.
    int sent = 0, confirmed = 0, maximum = 0;
    for (int tick = 0; tick < 30 && confirmed < 36; tick++) {
      if (tick >= 3) {
        int ready = Math.min(sent, (tick - 2) * SellTransfers.MAX_PER_TICK);
        while (confirmed < ready) { transfers.acknowledgeSlot(confirmed++); transfers.acknowledgePayout(); }
      }
      for (int burst = 0; burst < SellTransfers.MAX_PER_TICK && sent < 36 && transfers.canSend(); burst++) transfers.sent(sent++, tick * 50);
      maximum = Math.max(maximum, transfers.inFlight());
    }
    assert sent == 36 && confirmed == 36;
    assert maximum == SellTransfers.MAX_IN_FLIGHT;
    transfers.reset(); transfers.sent(3, 100); transfers.acknowledgePayout(); transfers.acknowledgePayout();
    transfers.sent(4, 200);
    assert transfers.inFlight() == 1 : "Payouts before a transfer must not bank future credit";
    System.out.println("Bounded parallel transfers, dual-ack deduplication, refills, deadlines and resets passed");
  }
}
