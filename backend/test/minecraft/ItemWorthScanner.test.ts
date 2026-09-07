import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ItemWorthScanner } from "../../src/minecraft/ItemWorthScanner.js";
import type { ClientManager } from "../../src/minecraft/ClientManager.js";
import type { RegistryItem } from "../../src/minecraft/itemRegistry.js";
import { prisma } from "../../src/database/prisma.js";

const ITEMS: RegistryItem[] = [
  { id: "dirt", name: "Dirt" },
  { id: "pumpkin", name: "Pumpkin" },
  { id: "bedrock", name: "Bedrock" },
];

type ChatListener = (event: { minecraftAccountId: string; message: string }) => void;
type StatusListener = (status: { id: string; status: string }) => void;

/**
 * Stands in for ClientManager + MinecraftClient. `prices` decides what the
 * fake server answers for each item id; a missing entry means "no price", and
 * a `"silent"` entry means the server never answers.
 */
class FakeManager {
  chatListeners: ChatListener[] = [];
  statusListeners: StatusListener[] = [];
  /** Per-account online flag, so tests can drop a single bot. */
  online = new Map<string, boolean>();
  /** Every (accountId, itemId) pair that was queried, in order. */
  asked: { accountId: string; itemId: string }[] = [];
  /** The raw argument passed to /worth, to assert the exact command form. */
  askedArgs: string[] = [];
  prices = new Map<string, number | null | "silent">();
  echoName = true;
  silentAll = false;

  onChatEvent(listener: ChatListener) {
    this.chatListeners.push(listener);
    return () => undefined;
  }

  onStatusEvent(listener: StatusListener) {
    this.statusListeners.push(listener);
    return () => undefined;
  }

  get(accountId: string) {
    const self = this;
    return {
      getStatus: () => ({
        id: accountId,
        status: self.online.get(accountId) ? "ONLINE" : "OFFLINE",
      }),
      sendBackgroundCommand(command: string): boolean {
        if (!self.online.get(accountId)) return false;
        const argument = command.replace("/worth ", "");
        self.askedArgs.push(argument);
        // The server takes spaces, not registry ids, so map back to the id the
        // test's price table is keyed by.
        const itemId = argument.replace(/ /g, "_");
        self.asked.push({ accountId, itemId });
        const price = self.prices.get(itemId);
        if (price === "silent" || self.silentAll) return true;
        // The real server echoes the item's display name back; the scanner
        // relies on that to correlate the reply with the query.
        const name = self.echoName
          ? (ITEMS.find((i) => i.id === itemId)?.name ?? itemId)
          : "Some Other Item";
        // Reply asynchronously, exactly like a real server round-trip.
        setTimeout(
          () =>
            self.say(
              accountId,
              price === undefined || price === null
                ? "Das Item hat keinen festgelegten Wert."
                : `Der Wert von ${name} beträgt $${price}.`,
            ),
          1,
        );
        return true;
      },
    };
  }

  say(accountId: string, message: string) {
    for (const listener of this.chatListeners) {
      listener({ minecraftAccountId: accountId, message });
    }
  }

  setOnline(accountId: string, value: boolean) {
    this.online.set(accountId, value);
    if (value) {
      for (const listener of this.statusListeners) {
        listener({ id: accountId, status: "ONLINE" });
      }
    }
  }
}

function makeScanner(fake: FakeManager, items: RegistryItem[] = ITEMS) {
  return new ItemWorthScanner(fake as unknown as ClientManager, {
    items,
    replyTimeoutMs: 60,
    delayScale: 0, // no pause between items in tests
    offlineRecheckMs: 20,
  });
}

/** Poll the scan row until it reaches one of the given statuses. */
async function waitForStatus(statuses: string[], timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const scan = await prisma.itemWorthScan.findUnique({ where: { id: "global" } });
    if (scan && statuses.includes(scan.status)) return scan;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Scan did not reach ${statuses.join("/")} in time`);
}

describe("ItemWorthScanner", () => {
  let fake: FakeManager;
  let scanner: ItemWorthScanner;
  const A = "acc-a";
  const B = "acc-b";
  const C = "acc-c";

  beforeEach(async () => {
    await prisma.itemWorthRun.deleteMany({});
    await prisma.itemWorthValue.deleteMany({});
    await prisma.itemWorthScan.deleteMany({});
    fake = new FakeManager();
    fake.setOnline(A, true);
    scanner = makeScanner(fake);
  });

  afterEach(async () => {
    scanner.dispose();
    await prisma.itemWorthRun.deleteMany({});
    await prisma.itemWorthValue.deleteMany({});
    await prisma.itemWorthScan.deleteMany({});
  });

  it("scans every item and stores prices, including items without one", async () => {
    fake.prices.set("dirt", 1);
    fake.prices.set("pumpkin", 12.5);
    // bedrock intentionally absent -> "kein festgelegter Wert"

    await scanner.start([A], 1);
    const scan = await waitForStatus(["COMPLETED"]);

    expect(scan.cursor).toBe(3);
    expect(scan.scanNumber).toBe(1);
    expect(fake.asked.map((a) => a.itemId)).toEqual(["dirt", "pumpkin", "bedrock"]);

    const state = await scanner.getState();
    const byId = new Map(state.values.map((v) => [v.itemId, v]));
    expect(byId.get("dirt")?.value).toBe(1);
    expect(byId.get("pumpkin")?.value).toBe(12.5);
    expect(byId.get("bedrock")?.value).toBeNull();
    // Nothing to compare against on a first run.
    expect(scan.changedCount).toBe(0);
    expect(state.values.every((v) => !v.changed)).toBe(true);
  });

  it("spreads the queries round-robin over all selected accounts", async () => {
    for (const item of ITEMS) fake.prices.set(item.id, 1);
    fake.setOnline(B, true);
    fake.setOnline(C, true);

    await scanner.start([A, B, C], 1);
    await waitForStatus(["COMPLETED"]);

    // Acc1 -> ItemA, Acc2 -> ItemB, Acc3 -> ItemC, exactly as specified.
    expect(fake.asked).toEqual([
      { accountId: A, itemId: "dirt" },
      { accountId: B, itemId: "pumpkin" },
      { accountId: C, itemId: "bedrock" },
    ]);
  });

  it("skips an account that went offline and keeps the others going", async () => {
    for (const item of ITEMS) fake.prices.set(item.id, 1);
    fake.setOnline(B, true);

    await scanner.start([A, B], 1);
    // Drop B immediately; A must carry the whole scan on its own.
    fake.setOnline(B, false);
    const scan = await waitForStatus(["COMPLETED"]);

    expect(scan.cursor).toBe(3);
    expect(fake.asked.every((a) => a.accountId === A)).toBe(true);
    // No item may be lost just because one bot disappeared.
    expect(fake.asked.map((a) => a.itemId)).toEqual(["dirt", "pumpkin", "bedrock"]);
    expect((await scanner.getState()).values).toHaveLength(3);
  });

  it("waits when every account is offline and resumes when one returns", async () => {
    fake.prices.set("dirt", 1);
    fake.setOnline(A, false);

    await scanner.start([A], 1);
    const paused = await waitForStatus(["PAUSED"]);
    expect(paused.cursor).toBe(0);
    expect(fake.asked).toEqual([]);
    expect(paused.resumable).toBe(true);

    fake.setOnline(A, true);
    const done = await waitForStatus(["COMPLETED"]);
    expect(done.cursor).toBe(3);
    expect((await scanner.getState()).values).toHaveLength(3);
  });

  it("flags price changes on a second scan and keeps the old value", async () => {
    fake.prices.set("dirt", 1);
    fake.prices.set("pumpkin", 10);
    await scanner.start([A], 1);
    await waitForStatus(["COMPLETED"]);

    // The "off meta": pumpkin silently doubles, dirt stays put.
    fake.prices.set("pumpkin", 20);
    await scanner.start([A], 1);
    const scan = await waitForStatus(["COMPLETED"]);

    expect(scan.scanNumber).toBe(2);
    expect(scan.changedCount).toBe(1);

    const state = await scanner.getState();
    const pumpkin = state.values.find((v) => v.itemId === "pumpkin")!;
    expect(pumpkin.changed).toBe(true);
    expect(pumpkin.previousValue).toBe(10);
    expect(pumpkin.value).toBe(20);
    expect(state.values.find((v) => v.itemId === "dirt")!.changed).toBe(false);
  });

  it("clears the previous run's change flags when a new scan starts", async () => {
    fake.prices.set("dirt", 1);
    await scanner.start([A], 1);
    await waitForStatus(["COMPLETED"]);
    fake.prices.set("dirt", 2);
    await scanner.start([A], 1);
    await waitForStatus(["COMPLETED"]);
    expect((await scanner.getState()).values.find((v) => v.itemId === "dirt")!.changed).toBe(true);

    // Third scan with no movement must drop the stale highlight.
    await scanner.start([A], 1);
    await waitForStatus(["COMPLETED"]);
    const state = await scanner.getState();
    expect(state.values.find((v) => v.itemId === "dirt")!.changed).toBe(false);
    expect(state.changedCount).toBe(0);
  });

  it("counts unanswered items and moves on instead of hanging", async () => {
    fake.prices.set("dirt", "silent");
    fake.prices.set("pumpkin", 5);

    await scanner.start([A], 1);
    const scan = await waitForStatus(["COMPLETED"]);

    expect(scan.missedCount).toBe(1);
    expect(scan.cursor).toBe(3);
    const state = await scanner.getState();
    // A silent item must not be recorded at all, so an old price is preserved.
    expect(state.values.some((v) => v.itemId === "dirt")).toBe(false);
    expect(state.values.find((v) => v.itemId === "pumpkin")?.value).toBe(5);
  });

  it("ignores a reply that names a different item than the one asked", async () => {
    fake.echoName = false; // fake server answers about the wrong item
    // All three need a price, because the "no price" reply carries no item
    // name and therefore cannot be correlated (and is accepted as-is).
    for (const item of ITEMS) fake.prices.set(item.id, 1);

    await scanner.start([A], 1);
    const scan = await waitForStatus(["COMPLETED"]);

    // Every mismatching reply must time out rather than be recorded, otherwise
    // a random player's chat line could poison the price table.
    expect(scan.missedCount).toBe(3);
    expect((await scanner.getState()).values).toHaveLength(0);
  });

  it("ignores a reply coming from an account we did not ask", async () => {
    fake.setOnline(B, true);
    fake.prices.set("dirt", "silent");

    await scanner.start([A], 1);
    // B answers even though A was asked; that reply must be discarded.
    await new Promise((resolve) => setTimeout(resolve, 5));
    fake.say(B, "Der Wert von Dirt beträgt $999.");

    const scan = await waitForStatus(["COMPLETED"]);
    expect(scan.missedCount).toBeGreaterThanOrEqual(1);
    expect((await scanner.getState()).values.some((v) => v.itemId === "dirt")).toBe(false);
  });

  it("stays parked after giving up, even when status events keep firing", async () => {
    fake.silentAll = true;
    const giveUp = makeScanner(
      fake,
      Array.from({ length: 40 }, (_, i) => ({ id: `i${i}`, name: `I${i}` })),
    );
    try {
      await giveUp.start([A], 1);
      const paused = await waitForStatus(["PAUSED"]);
      expect(paused.resumable).toBe(false);

      // Status events fire on every health/balance tick, not just transitions.
      // They must not revive a scan that deliberately gave up.
      fake.setOnline(A, true);
      fake.setOnline(A, true);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const still = await prisma.itemWorthScan.findUnique({ where: { id: "global" } });
      expect(still?.status).toBe("PAUSED");
      expect(still?.resumable).toBe(false);
    } finally {
      giveUp.dispose();
    }
  });

  it("refuses to start without an account or while a scan is in progress", async () => {
    await expect(scanner.start([], 1)).rejects.toThrow(/at least one account/i);
    fake.prices.set("dirt", "silent");
    await scanner.start([A], 1);
    await expect(scanner.start([A], 1)).rejects.toThrow(/already in progress/i);
    await scanner.stop();
  });

  it("stops on request and keeps the prices gathered so far", async () => {
    fake.prices.set("dirt", 1);
    fake.prices.set("pumpkin", "silent");

    await scanner.start([A], 1);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if ((await prisma.itemWorthValue.count()) >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await scanner.stop();

    const scan = await prisma.itemWorthScan.findUnique({ where: { id: "global" } });
    expect(scan?.status).toBe("CANCELLED");
    expect((await scanner.getState()).values.find((v) => v.itemId === "dirt")?.value).toBe(1);
  });

  it("parks an interrupted scan as PAUSED on boot so it can resume", async () => {
    fake.prices.set("dirt", "silent");
    await scanner.start([A], 1);
    scanner.dispose();
    // Simulate the process dying mid-scan: the row is still RUNNING.
    await prisma.itemWorthScan.update({ where: { id: "global" }, data: { status: "RUNNING" } });

    const rebooted = makeScanner(fake);
    await rebooted.init();
    const scan = await prisma.itemWorthScan.findUnique({ where: { id: "global" } });
    expect(scan?.status).toBe("PAUSED");
    rebooted.dispose();
  });

  it("records what the server said when a reply is not understood", async () => {
    fake.prices.set("dirt", "silent");
    await scanner.start([A], 1);
    // The server answers, but in a wording nothing recognises.
    await new Promise((resolve) => setTimeout(resolve, 5));
    fake.say(A, "Unbekanntes Format ohne Preis");

    const scan = await waitForStatus(["COMPLETED"]);
    expect(scan.missedCount).toBeGreaterThanOrEqual(1);
    // Without this the admin sees only "no answer" and cannot tell whether the
    // command failed, the wording changed, or nothing arrived at all.
    const state = await scanner.getState();
    expect(state.lastSamples).not.toBeNull();
    expect(state.lastSamples!.command).toMatch(/^\/worth /);
    expect(state.lastSamples!.lines.length).toBeGreaterThan(0);
  });

  it("accepts an unfamiliar reply wording that names the right item", async () => {
    // The exact /worth sentence is server-specific; correlation is by item
    // name, so a rephrased answer must still be recorded.
    fake.prices.set("dirt", "silent");
    fake.prices.set("pumpkin", "silent");
    fake.prices.set("bedrock", "silent");
    await scanner.start([A], 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    fake.say(A, "[Shop] Dirt >> $42.5 pro Einheit");

    await waitForStatus(["COMPLETED"]);
    const state = await scanner.getState();
    expect(state.values.find((v) => v.itemId === "dirt")?.value).toBe(42.5);
  });

  it("asks with spaces instead of underscores, which is what the server accepts", async () => {
    // `/worth leaf_litter` is rejected by the server; `/worth leaf litter` works.
    const underscored = makeScanner(fake, [{ id: "leaf_litter", name: "Leaf Litter" }]);
    try {
      fake.prices.set("leaf_litter", 3);
      await underscored.start([A], 1);
      await waitForStatus(["COMPLETED"]);
      expect(fake.askedArgs).toEqual(["leaf litter"]);
      expect((await underscored.getState()).values[0]).toMatchObject({
        itemId: "leaf_litter",
        value: 3,
      });
    } finally {
      underscored.dispose();
    }
  });

  it("keeps every past scan's price list accessible after a newer scan", async () => {
    fake.prices.set("dirt", 1);
    fake.prices.set("pumpkin", 10);
    await scanner.start([A], 1);
    await waitForStatus(["COMPLETED"]);

    fake.prices.set("pumpkin", 20);
    await scanner.start([A], 1);
    await waitForStatus(["COMPLETED"]);

    const runs = await scanner.listRuns();
    expect(runs.map((r) => r.scanNumber)).toEqual([2, 1]);
    expect(runs[0]).toMatchObject({ status: "COMPLETED", itemCount: 3, changedCount: 1 });

    // The whole point: scan #1 still holds the OLD price, even though the live
    // table has long since been overwritten by scan #2.
    const first = await scanner.getRun(1);
    expect(first!.values.find((v) => v.itemId === "pumpkin")?.value).toBe(10);
    const second = await scanner.getRun(2);
    expect(second!.values.find((v) => v.itemId === "pumpkin")?.value).toBe(20);
    expect(second!.values.find((v) => v.itemId === "pumpkin")?.previousValue).toBe(10);
    expect(second!.values.find((v) => v.itemId === "pumpkin")?.changed).toBe(true);

    expect(await scanner.getRun(99)).toBeNull();
  });

  it("reports the items it just checked, newest first", async () => {
    fake.prices.set("dirt", 1);
    fake.prices.set("pumpkin", 2);
    fake.prices.set("bedrock", 3);
    await scanner.start([A], 1);
    await waitForStatus(["COMPLETED"]);

    const state = await scanner.getState();
    expect(state.recent.map((entry) => entry.itemId)).toEqual(["bedrock", "pumpkin", "dirt"]);
    expect(state.recent[0]).toMatchObject({ itemName: "Bedrock", value: 3 });
  });

  it("surfaces a variant that breaks its family price", async () => {
    const boats = [
      { id: "oak_boat", name: "Oak Boat" },
      { id: "birch_boat", name: "Birch Boat" },
      { id: "acacia_boat", name: "Acacia Boat" },
      { id: "jungle_boat", name: "Jungle Boat" },
    ];
    const boatScanner = makeScanner(fake, boats);
    try {
      for (const boat of boats) fake.prices.set(boat.id, 1);
      fake.prices.set("jungle_boat", 2.5); // the off-meta
      await boatScanner.start([A], 1);
      await waitForStatus(["COMPLETED"]);

      const state = await boatScanner.getState();
      expect(state.suspicious).toHaveLength(1);
      expect(state.suspicious[0]).toMatchObject({
        itemId: "jungle_boat",
        value: 2.5,
        expected: 1,
        family: "boat",
      });
    } finally {
      boatScanner.dispose();
    }
  });

  it("reports the configured delay and a matching ETA", async () => {
    fake.prices.set("dirt", "silent");
    await scanner.start([A], 30);
    const state = await scanner.getState();
    expect(state.delaySeconds).toBe(30);
    expect(state.accountIds).toEqual([A]);
    // 3 items left * 30s.
    expect(state.etaSeconds).toBeLessThanOrEqual(90);
    await scanner.stop();
  });
});
