/**
 * Detects items whose price does not fit the rest of their family.
 *
 * Minecraft has large sets of items that are pure cosmetic variants of each
 * other — every wood type has a boat, every dye colour has wool. A server
 * prices those uniformly, so when a *single* variant deviates ("all boats cost
 * $1, but jungle boat costs $2.50") that is almost always a deliberate,
 * unannounced price change: exactly the off-meta this feature exists to find.
 *
 * Everything here is pure so the (heuristic) grouping can be unit tested.
 */

/**
 * Tokens that only describe a cosmetic variant, never the item's worth.
 *
 * This list is deliberately conservative. `iron` and `gold` are NOT in it:
 * an iron ingot and a gold ingot are genuinely different goods, and grouping
 * them would produce a flood of false positives. Only families whose members
 * are normally priced identically belong here.
 */
const VARIANT_TOKENS = new Set([
  // Wood types.
  "oak",
  "dark",
  "pale",
  "spruce",
  "birch",
  "jungle",
  "acacia",
  "mangrove",
  "cherry",
  "bamboo",
  "crimson",
  "warped",
  // Dye colours.
  "white",
  "orange",
  "magenta",
  "light",
  "blue",
  "yellow",
  "lime",
  "pink",
  "gray",
  "grey",
  "cyan",
  "purple",
  "brown",
  "green",
  "red",
  "black",
  // Coral / flower / mob variants that come in fixed sets.
  "tube",
  "brain",
  "bubble",
  "fire",
  "horn",
  "dead",
]);

/**
 * The family an item belongs to, derived by removing cosmetic variant tokens
 * from its registry id. `acacia_boat` and `jungle_boat` both become `boat`,
 * while `acacia_chest_boat` becomes `chest_boat` — a separate family, since
 * chest boats are priced separately from plain ones.
 *
 * Returns null when nothing is left after stripping (e.g. `red`, `oak`), which
 * means the item is not a variant of anything.
 */
export function itemFamilyKey(itemId: string): string | null {
  const tokens = itemId.split("_").filter((token) => token.length > 0);
  const kept = tokens.filter((token) => !VARIANT_TOKENS.has(token));
  // Nothing was stripped -> the item is not part of a cosmetic variant set.
  if (kept.length === tokens.length) return null;
  if (kept.length === 0) return null;
  return kept.join("_");
}

export interface FamilyMember {
  itemId: string;
  itemName: string;
  value: number | null;
}

export interface SuspiciousItem {
  itemId: string;
  itemName: string;
  value: number | null;
  /** The price the rest of the family agrees on. */
  expected: number;
  /** Family key, e.g. `boat`. */
  family: string;
  /** How many family members hold the expected price. */
  agreeing: number;
  familySize: number;
  /** Relative deviation from the expected price, or null for a missing price. */
  deviation: number | null;
}

/** A family needs at least this many scanned members to say anything useful. */
const MIN_FAMILY_SIZE = 3;

/** Share of the family that must agree on a price before outliers mean anything. */
const CONSENSUS_RATIO = 2 / 3;

/**
 * Find items that break their family's price consensus.
 *
 * A family only produces findings when a clear majority of its members share
 * one price; without that there is no "normal" to deviate from and flagging
 * anything would be noise.
 */
export function findSuspiciousItems(members: readonly FamilyMember[]): SuspiciousItem[] {
  const families = new Map<string, FamilyMember[]>();
  for (const member of members) {
    const family = itemFamilyKey(member.itemId);
    if (family === null) continue;
    const list = families.get(family);
    if (list) list.push(member);
    else families.set(family, [member]);
  }

  const findings: SuspiciousItem[] = [];

  for (const [family, group] of families) {
    if (group.length < MIN_FAMILY_SIZE) continue;

    const priced = group.filter((member) => member.value !== null);
    if (priced.length === 0) continue;

    // The price the family agrees on is simply its most common one.
    const counts = new Map<number, number>();
    for (const member of priced) {
      counts.set(member.value!, (counts.get(member.value!) ?? 0) + 1);
    }
    let expected = priced[0]!.value!;
    let agreeing = 0;
    for (const [value, count] of counts) {
      // Ties go to the cheaper price: a raised price is the thing we hunt for,
      // so it must not be able to become the baseline by tying.
      if (count > agreeing || (count === agreeing && value < expected)) {
        expected = value;
        agreeing = count;
      }
    }

    if (agreeing < 2 || agreeing / group.length < CONSENSUS_RATIO) continue;

    for (const member of group) {
      if (member.value === null) {
        // A missing price only stands out when literally everything else in the
        // family has one; otherwise unpriced items are far too common to flag.
        if (priced.length !== group.length - 1) continue;
        findings.push({
          itemId: member.itemId,
          itemName: member.itemName,
          value: null,
          expected,
          family,
          agreeing,
          familySize: group.length,
          deviation: null,
        });
        continue;
      }

      if (Math.abs(member.value - expected) <= 1e-9) continue;
      findings.push({
        itemId: member.itemId,
        itemName: member.itemName,
        value: member.value,
        expected,
        family,
        agreeing,
        familySize: group.length,
        deviation: expected === 0 ? null : (member.value - expected) / Math.abs(expected),
      });
    }
  }

  // Biggest deviations first — those are the most likely deliberate changes.
  return findings.sort((a, b) => Math.abs(b.deviation ?? 0) - Math.abs(a.deviation ?? 0));
}
