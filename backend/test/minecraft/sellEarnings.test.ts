import { describe, expect, it } from "vitest";
import { parseSellEarning } from "../../src/minecraft/sellEarnings.js";

describe("confirmed sale payouts", () => {
  it.each([
    ["<HugoSMP> +$1.071 (Basis: $630, Bonus: +$441 durch 1.7x)", 1071],
    ["+$14.492,50 (Basis: $8.525,00, Bonus: +$5.967,50 durch 1.7x)", 14492.5],
    ["+$14,492.50 (Basis: $8,525.00, Bonus: +$5,967.50 durch 1.7x)", 14492.5],
    ["+$1.234.567 (Basis: $726216, Bonus: +$508351 durch 1.7x)", 1234567],
    ["§a+$1.071 §7(Basis: $630, Bonus: +$441 durch 1.7x)", 1071],
    ["You sold 64 cobblestone for $500", 500],
    ["Verkauft für $1,250", 1250],
    ["Verkauft für $1234,56", 1234.56],
    ["You sold 2 items for $12.50", 12.5],
    ["You sold 2 items for $12.50.", 12.5],
  ])("parses the total from %s", (message, amount) => {
    expect(parseSellEarning(message)).toBe(amount);
  });

  it.each([
    "Steve paid you $9000",
    "You received $100 from Steve",
    "+$100",
    "Daily bonus: +$100",
    "Sell price: $200",
    "Balance: $1.071",
    "Verkauft für $0",
    "Verkauft für $1.2.3",
    "Verkauft für $999999999999999999999999999",
    "Welcome to the server!",
  ])("does not count unrelated or invalid amounts: %s", (message) => {
    expect(parseSellEarning(message)).toBeNull();
  });
});
