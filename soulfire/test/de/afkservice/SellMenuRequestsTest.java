package de.afkservice;

public final class SellMenuRequestsTest {
  public static void main(String[] args) {
    var menus = new SellMenuRequests();
    assert !menus.opened() : "An unsolicited menu is not native-owned";
    menus.requested(); menus.requested();
    // No clock or transfer deadline can erase an outstanding server reply.
    assert menus.opened(); assert menus.opened(); assert !menus.opened();
    menus.requested();
    assert menus.manual(100_000) : "Explicit manual sale supersedes native requests";
    assert !menus.opened() : "Never claim the user's sale menu";
    assert !menus.manual(100_000);
    menus.requested();
    assert !menus.manual(100_000) : "An old manual setting cannot erase a later native request";
    assert menus.opened();
    for (int i = 0; i < 10_000; i++) menus.requested();
    int pending = 0;
    while (menus.opened()) pending++;
    assert pending == 64 : "Lost replies cannot grow an unbounded ledger";
    System.out.println("Late/retried menu provenance, manual ownership and bounded pending requests passed");
  }
}
