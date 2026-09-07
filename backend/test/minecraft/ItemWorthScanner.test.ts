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
 * an explicit `null` price entry means the server stays silent (timeout).
 */
class FakeManager {
  chatListeners: ChatListener[] = [];
  statusListeners: StatusListener[] = [];
  online = true;
  asked: string[] = [];
  prices = new Map<string, number | null | "silent">();
  /** When false the fake answers about the wrong item, to test correlation. */
  echoName = true;
  /** When true the fake never answers at all. */
  silentAll = false;

  constructor(private accountId: string) {}

  onChatEvent(listener: ChatListener) {
    this.chatListeners.push(listener);
    return () => undefined;
  }

  onStatusEvent(listener: StatusListener) {
    this.statusListeners.push(listener);
    return () => undefined;
  }

  get(_accountId: string) {
    const self = this;
    return {
      getStatus: () => ({ id: self.accountId, status: self.online ? "ONLINE" : "OFFLINE" }),
      sendBackgroundCommand(command: string): boolean {
        if (!self.online) return false;
        const itemId = command.replace("/worth ", "");
        self.asked.push(itemId);
        const price = self.prices.get(itemId);
        if (price === "silent" || self.silentAll) return true;
        // The real server echoes the item's display name back; the scanner
        // relies on that to correlate the reply with the query.
        const name = self.echoName
          ? (ITEMS.find((i) => i.id === itemId)?.name ?? itemId)
          : "Some Other Item";
        // Reply asynchronously, exactly like a real server round-trip.
        setTimeout(() => self.say(price === undefined || price === null
          ? "Das Item hat keinen festgelegten Wert."
          : `Der Wert von ${name} beträgt $${price}.`), 1);
        return true;
      },
    };
  }

  say(message: string) {
    for (const listener of this.chatListeners) {
      listener({ minecraftAccountId: this.accountId, message });
    }
  }

  goOnline() {
    this.online = true;
    for (const listener of this.statusListeners) {
      listener({ id: this.accountId, status: "ONLINE" });
    }
  }
}

function makeScanner(fake: FakeManager) {
  return new ItemWorthScanner(fake as unknown as ClientManager, {
    items: ITEMS,
    minDelaySeconds: 0,
    maxDelaySeconds: 0,
    replyTimeoutMs: 60,
  });
}

/** Poll the scan row until it leaves RUNNING, so tests never sleep blindly. */
async function waitForStatus(accountId: string, statuses: string[], timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const scan = await prisma.itemWorthScan.findUnique({
      where: { minecraftAccountId: accountId },
    });
    if (scan && statuses.includes(scan.status)) return scan;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Scan did not reach ${statuses.join("/")} in time`);
}

describe("ItemWorthScanner", () => {
  let accountId: string;
  let fake: FakeManager;
  let scanner: ItemWorthScanner;

  beforeEach(async () => {
    const account = await prisma.minecraftAccount.create({
      data: { name: `worth-test-${Date.now()}-${Math.random()}`, serverHost: "example.invalid" },
    });
    accountId = account.id;
    fake = new FakeManager(accountId);
    scanner = makeScanner(fake);
  });

  afterEach(async () => {
    scanner.dispose();
    await prisma.minecraftAccount.deleteMany({ where: { id: accountId } });
  });

  it("scans every item and stores prices, including items without one", async () => {
    fake.prices.set("dirt", 1);
    fake.prices.set("pumpkin", 12.5);
    // bedrock intentionally absent -> "kein festgelegter Wert"

    await scanner.start(accountId);
    const scan = await waitForStatus(accountId, ["COMPLETED"]);

    expect(scan.cursor).toBe(3);
    expect(scan.scanNumber).toBe(1);
    expect(fake.asked).toEqual(["dirt", "pumpkin", "bedrock"]);

    const state = await scanner.getState(accountId);
    const byId = new Map(state.values.map((v) => [v.itemId, v]));
    expect(byId.get("dirt")?.value).toBe(1);
    expect(byId.get("pumpkin")?.value).toBe(12.5);
    expect(byId.get("bedrock")?.value).toBeNull();
    // Nothing to compare against on a first run.
    expect(scan.changedCount).toBe(0);
    expect(state.values.every((v) => !v.changed)).toBe(true);
  });

  it("flags price changes on a second scan and keeps the old value", async () => {
    fake.prices.set("dirt", 1);
    fake.prices.set("pumpkin", 10);
    await scanner.start(accountId);
    await waitForStatus(accountId, ["COMPLETED"]);

    // The "off meta": pumpkin silently doubles, dirt stays put.
    fake.prices.set("pumpkin", 20);
    await scanner.start(accountId);
    const scan = await waitForStatus(accountId, ["COMPLETED"]);

    expect(scan.scanNumber).toBe(2);
    expect(scan.changedCount).toBe(1);

    const state = await scanner.getState(accountId);
    const pumpkin = state.values.find((v) => v.itemId === "pumpkin")!;
    expect(pumpkin.changed).toBe(true);
    expect(pumpkin.previousValue).toBe(10);
    expect(pumpkin.value).toBe(20);

    expect(state.values.find((v) => v.itemId === "dirt")!.changed).toBe(false);
  });

  it("clears the previous run's change flags when a new scan starts", async () => {
    fake.prices.set("dirt", 1);
    await scanner.start(accountId);
    await waitForStatus(accountId, ["COMPLETED"]);
    fake.prices.set("dirt", 2);
    await scanner.start(accountId);
    await waitForStatus(accountId, ["COMPLETED"]);
    expect((await scanner.getState(accountId)).values.find((v) => v.itemId === "dirt")!.changed).toBe(true);

    // Third scan with no movement must drop the stale highlight.
    await scanner.start(accountId);
    await waitForStatus(accountId, ["COMPLETED"]);
    const state = await scanner.getState(accountId);
    expect(state.values.find((v) => v.itemId === "dirt")!.changed).toBe(false);
    expect(state.changedCount).toBe(0);
  });

  it("pauses when the bot goes offline and resumes at the same item", async () => {
    fake.prices.set("dirt", 1);
    fake.online = false;

    await scanner.start(accountId);
    const paused = await waitForStatus(accountId, ["PAUSED"]);
    expect(paused.cursor).toBe(0);
    expect(fake.asked).toEqual([]);
    expect(paused.lastError).toContain("offline");

    // Coming back online must restart the loop by itself.
    fake.prices.set("pumpkin", 5);
    fake.goOnline();
    const done = await waitForStatus(accountId, ["COMPLETED"]);
    expect(done.cursor).toBe(3);
    expect(fake.asked).toEqual(["dirt", "pumpkin", "bedrock"]);
    expect((await scanner.getState(accountId)).values).toHaveLength(3);
  });

  it("counts unanswered items and moves on instead of hanging", async () => {
    fake.prices.set("dirt", "silent");
    fake.prices.set("pumpkin", 5);

    await scanner.start(accountId);
    const scan = await waitForStatus(accountId, ["COMPLETED"]);

    expect(scan.missedCount).toBe(1);
    expect(scan.cursor).toBe(3);
    const state = await scanner.getState(accountId);
    // A silent item must not be recorded at all, so an old price is preserved.
    expect(state.values.some((v) => v.itemId === "dirt")).toBe(false);
    expect(state.values.find((v) => v.itemId === "pumpkin")?.value).toBe(5);
  });

  it("ignores a reply that names a different item than the one asked", async () => {
    fake.echoName = false; // fake server answers about the wrong item
    // All three need a price, because the "no price" reply carries no item
    // name and therefore cannot be correlated (and is accepted as-is).
    for (const item of ITEMS) fake.prices.set(item.id, 1);

    await scanner.start(accountId);
    const scan = await waitForStatus(accountId, ["COMPLETED"]);

    // Every mismatching reply must time out rather than be recorded, otherwise
    // a random player's chat line could poison the price table.
    expect(scan.missedCount).toBe(3);
    expect((await scanner.getState(accountId)).values).toHaveLength(0);
  });

  it("stays parked after giving up, even when status events keep firing", async () => {
    // Every item silent -> the miss limit is reached almost immediately.
    fake.silentAll = true;
    const giveUp = new ItemWorthScanner(fake as unknown as ClientManager, {
      items: Array.from({ length: 40 }, (_, i) => ({ id: `i${i}`, name: `I${i}` })),
      minDelaySeconds: 0,
      maxDelaySeconds: 0,
      replyTimeoutMs: 5,
    });
    try {
      await giveUp.start(accountId);
      const paused = await waitForStatus(accountId, ["PAUSED"]);
      expect(paused.resumable).toBe(false);

      // Status events fire on every health/balance tick, not just transitions.
      // They must not revive a scan that deliberately gave up.
      fake.goOnline();
      fake.goOnline();
      await new Promise((resolve) => setTimeout(resolve, 150));
      const still = await prisma.itemWorthScan.findUnique({
        where: { minecraftAccountId: accountId },
      });
      expect(still?.status).toBe("PAUSED");
      expect(still?.resumable).toBe(false);
    } finally {
      giveUp.dispose();
    }
  });

  it("refuses to start a second scan while one is in progress", async () => {
    fake.prices.set("dirt", "silent");
    await scanner.start(accountId);
    await expect(scanner.start(accountId)).rejects.toThrow(/already in progress/i);
    await scanner.stop(accountId);
  });

  it("stops on request and keeps the prices gathered so far", async () => {
    fake.prices.set("dirt", 1);
    fake.prices.set("pumpkin", "silent");

    await scanner.start(accountId);
    // Wait until dirt has been recorded, then cancel mid-run.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const count = await prisma.itemWorthValue.count({ where: { minecraftAccountId: accountId } });
      if (count >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await scanner.stop(accountId);

    const scan = await prisma.itemWorthScan.findUnique({ where: { minecraftAccountId: accountId } });
    expect(scan?.status).toBe("CANCELLED");
    const state = await scanner.getState(accountId);
    expect(state.values.find((v) => v.itemId === "dirt")?.value).toBe(1);
  });

  it("parks an interrupted scan as PAUSED on boot so it can resume", async () => {
    fake.prices.set("dirt", "silent");
    await scanner.start(accountId);
    scanner.dispose();
    // Simulate the process dying mid-scan: the row is still RUNNING.
    await prisma.itemWorthScan.update({
      where: { minecraftAccountId: accountId },
      data: { status: "RUNNING" },
    });

    const rebooted = makeScanner(fake);
    await rebooted.init();
    const scan = await prisma.itemWorthScan.findUnique({ where: { minecraftAccountId: accountId } });
    expect(scan?.status).toBe("PAUSED");
    rebooted.dispose();
  });
});
