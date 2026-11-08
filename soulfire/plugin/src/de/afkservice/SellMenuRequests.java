package de.afkservice;

/** Open replies can arrive after retries, loading pauses or world restarts.
 * Their provenance must not expire with the transfer/command deadline.
 * Explicit manual sale commands supersede every earlier native request.
 */
public final class SellMenuRequests {
  private int pending;
  private long manualUntil;

  public void requested() { pending = Math.min(64, pending + 1); }
  public boolean manual(long until) {
    if (until <= manualUntil) return false;
    manualUntil = until; pending = 0;
    return true;
  }
  public boolean opened() {
    if (pending == 0) return false;
    pending--;
    return true;
  }
}
