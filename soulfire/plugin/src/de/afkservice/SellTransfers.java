package de.afkservice;

import java.util.ArrayList;
import java.util.BitSet;

/** Bounded pipelining: network latency is paid per window, not per stack.
 * Slot packets and payout chat describe the same transfers, so their credits
 * must never be added together. Refilled slots can use the payout counter. */
public final class SellTransfers {
  public static final int MAX_IN_FLIGHT = 16;
  public static final int MAX_PER_TICK = 8;
  private record Transfer(int slot, long at) {}
  private final ArrayList<Transfer> sent = new ArrayList<>();
  private final BitSet acknowledged = new BitSet();
  private int payouts;

  public synchronized void reset() { sent.clear(); acknowledged.clear(); payouts = 0; }
  public synchronized int inFlight() { return sent.size() - confirmed(); }
  public synchronized boolean canSend() { return inFlight() < MAX_IN_FLIGHT; }
  public synchronized void sent(int slot, long now) {
    if (!canSend()) throw new IllegalStateException("Sale confirmation window is full");
    if (sent.stream().anyMatch(transfer -> transfer.slot == slot)) throw new IllegalStateException("Sale slot already visited");
    sent.add(new Transfer(slot, now));
  }
  public synchronized void acknowledgeSlot(int slot) {
    for (int index = 0; index < sent.size(); index++) if (sent.get(index).slot == slot) { acknowledged.set(index); break; }
  }
  public synchronized void acknowledgePayout() { payouts = Math.min(sent.size(), payouts + 1); }
  public synchronized boolean stalled(long now) {
    int count = confirmed();
    return count < sent.size() && now - sent.get(count).at >= 5000;
  }
  private int confirmed() { return Math.max(payouts, acknowledged.cardinality()); }
}
