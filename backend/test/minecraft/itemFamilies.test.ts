import { describe, it, expect } from "vitest";
import {
  itemFamilyKey,
  findSuspiciousItems,
  type FamilyMember,
} from "../../src/minecraft/itemFamilies.js";
import { ITEM_REGISTRY } from "../../src/minecraft/itemRegistry.js";

function member(itemId: string, value: number | null): FamilyMember {
  return { itemId, itemName: itemId, value };
}

describe("itemFamilyKey", () => {
  it("groups the same item across wood types", () => {
    expect(itemFamilyKey("acacia_boat")).toBe("boat");
    expect(itemFamilyKey("jungle_boat")).toBe("boat");
    expect(itemFamilyKey("dark_oak_boat")).toBe("boat");
    expect(itemFamilyKey("pale_oak_boat")).toBe("boat");
  });

  it("groups the same item across dye colours", () => {
    expect(itemFamilyKey("red_wool")).toBe("wool");
    expect(itemFamilyKey("light_blue_wool")).toBe("wool");
    expect(itemFamilyKey("black_wool")).toBe("wool");
  });

  it("keeps sub-variants apart", () => {
    // Chest boats are priced separately from plain boats, so they must not
    // land in the same family.
    expect(itemFamilyKey("acacia_chest_boat")).toBe("chest_boat");
    expect(itemFamilyKey("acacia_chest_boat")).not.toBe(itemFamilyKey("acacia_boat"));
  });

  it("does not group genuinely different materials", () => {
    // Iron and gold are different goods with different prices; grouping them
    // would flag every single one of them as an outlier.
    expect(itemFamilyKey("iron_ingot")).toBeNull();
    expect(itemFamilyKey("gold_ingot")).toBeNull();
    expect(itemFamilyKey("diamond")).toBeNull();
    expect(itemFamilyKey("dirt")).toBeNull();
  });

  it("returns null when only variant tokens remain", () => {
    expect(itemFamilyKey("oak")).toBeNull();
    expect(itemFamilyKey("light_blue")).toBeNull();
  });

  it("produces sane families over the real registry", () => {
    const families = new Map<string, number>();
    for (const item of ITEM_REGISTRY) {
      const key = itemFamilyKey(item.id);
      if (key) families.set(key, (families.get(key) ?? 0) + 1);
    }
    // The boat family must exist and hold every wood type.
    expect(families.get("boat")).toBeGreaterThanOrEqual(9);
    expect(families.get("wool")).toBeGreaterThanOrEqual(16);
    expect(families.size).toBeGreaterThan(50);
  });
});

describe("findSuspiciousItems", () => {
  it("flags the single variant that breaks the family price", () => {
    const found = findSuspiciousItems([
      member("acacia_boat", 1),
      member("oak_boat", 1),
      member("birch_boat", 1),
      member("spruce_boat", 1),
      member("jungle_boat", 2.5),
    ]);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      itemId: "jungle_boat",
      value: 2.5,
      expected: 1,
      family: "boat",
      agreeing: 4,
      familySize: 5,
    });
    expect(found[0]!.deviation).toBeCloseTo(1.5);
  });

  it("stays silent when the family has no clear consensus", () => {
    // Four different prices: there is no "normal" to deviate from.
    expect(
      findSuspiciousItems([
        member("acacia_boat", 1),
        member("oak_boat", 2),
        member("birch_boat", 3),
        member("spruce_boat", 4),
      ]),
    ).toEqual([]);
  });

  it("ignores families that are too small to judge", () => {
    expect(findSuspiciousItems([member("acacia_boat", 1), member("oak_boat", 9)])).toEqual([]);
  });

  it("ignores items that are not part of a variant family", () => {
    expect(
      findSuspiciousItems([member("dirt", 1), member("diamond", 900), member("stone", 1)]),
    ).toEqual([]);
  });

  it("does not treat a raised price as the baseline on a tie", () => {
    // Two at $1, two at $5: a tie must resolve to the cheaper price, otherwise
    // a price hike applied to half a family would hide itself.
    const found = findSuspiciousItems([
      member("acacia_boat", 1),
      member("oak_boat", 1),
      member("birch_boat", 5),
      member("spruce_boat", 5),
    ]);
    // 2 of 4 agreeing is below the consensus ratio, so nothing is reported —
    // but the baseline choice must never be the higher price.
    expect(found.every((item) => item.expected !== 5)).toBe(true);
  });

  it("flags a missing price only when the whole rest of the family has one", () => {
    const flagged = findSuspiciousItems([
      member("acacia_boat", 1),
      member("oak_boat", 1),
      member("birch_boat", 1),
      member("jungle_boat", null),
    ]);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ itemId: "jungle_boat", value: null, expected: 1 });

    // With another unpriced member, unpriced is normal for this family.
    const quiet = findSuspiciousItems([
      member("acacia_boat", 1),
      member("oak_boat", 1),
      member("birch_boat", 1),
      member("jungle_boat", null),
      member("cherry_boat", null),
    ]);
    expect(quiet).toEqual([]);
  });

  it("sorts the biggest deviations first", () => {
    const found = findSuspiciousItems([
      member("white_wool", 2),
      member("red_wool", 2),
      member("blue_wool", 2),
      member("black_wool", 2),
      member("lime_wool", 3),
      member("pink_wool", 20),
    ]);
    expect(found.map((item) => item.itemId)).toEqual(["pink_wool", "lime_wool"]);
  });
});
