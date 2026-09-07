import { describe, it, expect } from "vitest";
import {
  parseWorthReply,
  parseWorthNumber,
  worthChanged,
  nextQueryDelayMs,
} from "../../src/minecraft/itemWorth.js";
import { ITEM_REGISTRY, findRegistryItem } from "../../src/minecraft/itemRegistry.js";

describe("parseWorthReply", () => {
  it("parses the plain HugoSMP reply", () => {
    expect(parseWorthReply("<HugoSMP> Der Wert von Dirt beträgt $1.")).toEqual({
      itemName: "Dirt",
      value: 1,
    });
  });

  it("parses a reply without the sender prefix", () => {
    expect(parseWorthReply("Der Wert von Pumpkin beträgt $12.5")).toEqual({
      itemName: "Pumpkin",
      value: 12.5,
    });
  });

  // Regression: the reply ends in a sentence period. Letting it into the number
  // made the grouping heuristic read "$12.5." as 125, silently inflating every
  // fractional price by 10x/100x.
  it("ignores the sentence period after a fractional price", () => {
    expect(parseWorthReply("<HugoSMP> Der Wert von Pumpkin beträgt $12.5.")?.value).toBe(12.5);
    expect(parseWorthReply("<HugoSMP> Der Wert von Wheat beträgt $0.05.")?.value).toBe(0.05);
    expect(parseWorthReply("<HugoSMP> Der Wert von Gold beträgt $1,250.75.")?.value).toBe(1250.75);
    expect(parseWorthReply("<HugoSMP> Der Wert von Gold beträgt $1.234,56.")?.value).toBe(1234.56);
    expect(parseWorthReply("<HugoSMP> Der Wert von Dirt beträgt $1.")?.value).toBe(1);
  });

  it("parses multi-word item names and thousands separators", () => {
    expect(parseWorthReply("<HugoSMP> Der Wert von Netherite Ingot beträgt $1,250.75")).toEqual({
      itemName: "Netherite Ingot",
      value: 1250.75,
    });
  });

  it("recognises items without a configured price", () => {
    expect(parseWorthReply("<HugoSMP> Das Item hat keinen festgelegten Wert.")).toEqual({
      itemName: null,
      value: null,
    });
  });

  it("ignores unrelated chat so the scan is not derailed by other players", () => {
    expect(parseWorthReply("<Steve> was ist der wert von dirt?")).toBeNull();
    expect(parseWorthReply("<HugoSMP> Du hast $500 erhalten.")).toBeNull();
    expect(parseWorthReply("")).toBeNull();
  });

  it("survives a missing currency sign and an umlaut-less 'betragt'", () => {
    expect(parseWorthReply("Der Wert von Stone betragt 3")).toEqual({
      itemName: "Stone",
      value: 3,
    });
  });
});

describe("parseWorthNumber", () => {
  it("reads plain integers and decimals", () => {
    expect(parseWorthNumber("1")).toBe(1);
    expect(parseWorthNumber("0.05")).toBe(0.05);
    expect(parseWorthNumber("$42")).toBe(42);
  });

  it("treats a single separator before exactly three digits as grouping", () => {
    expect(parseWorthNumber("1.234")).toBe(1234);
    expect(parseWorthNumber("1,234")).toBe(1234);
  });

  it("treats a single separator before one or two digits as a decimal point", () => {
    expect(parseWorthNumber("1.5")).toBe(1.5);
    expect(parseWorthNumber("1,25")).toBe(1.25);
  });

  it("uses the later separator as the decimal point when both appear", () => {
    expect(parseWorthNumber("1,234.56")).toBe(1234.56);
    expect(parseWorthNumber("1.234,56")).toBe(1234.56);
  });

  it("handles repeated grouping separators", () => {
    expect(parseWorthNumber("1.234.567")).toBe(1234567);
  });

  it("rejects non-numeric text", () => {
    expect(parseWorthNumber("")).toBeNull();
    expect(parseWorthNumber("abc")).toBeNull();
  });

  it("strips a trailing sentence separator", () => {
    expect(parseWorthNumber("12.5.")).toBe(12.5);
    expect(parseWorthNumber("1,250.75.")).toBe(1250.75);
    expect(parseWorthNumber("1.")).toBe(1);
  });
});

describe("worthChanged", () => {
  it("treats two missing prices as unchanged", () => {
    expect(worthChanged(null, null)).toBe(false);
  });

  it("detects a price appearing or disappearing", () => {
    expect(worthChanged(null, 5)).toBe(true);
    expect(worthChanged(5, null)).toBe(true);
  });

  it("ignores float round-trip noise but catches real changes", () => {
    expect(worthChanged(1.1, 1.1)).toBe(false);
    expect(worthChanged(1.1, 1.2)).toBe(true);
  });
});

describe("nextQueryDelayMs", () => {
  it("stays inside the configured window", () => {
    expect(nextQueryDelayMs(5, 10, () => 0)).toBe(5000);
    expect(nextQueryDelayMs(5, 10, () => 1)).toBe(10000);
    expect(nextQueryDelayMs(5, 10, () => 0.5)).toBe(7500);
  });
});

describe("item registry", () => {
  it("covers the full 1.21.x item set without air", () => {
    expect(ITEM_REGISTRY.length).toBeGreaterThan(1400);
    expect(ITEM_REGISTRY.some((item) => item.id === "air")).toBe(false);
  });

  it("has unique ids", () => {
    expect(new Set(ITEM_REGISTRY.map((item) => item.id)).size).toBe(ITEM_REGISTRY.length);
  });

  it("looks items up with and without the namespace", () => {
    expect(findRegistryItem("dirt")?.name).toBe("Dirt");
    expect(findRegistryItem("minecraft:pumpkin")?.name).toBe("Pumpkin");
    expect(findRegistryItem("not_a_real_item")).toBeUndefined();
  });
});
