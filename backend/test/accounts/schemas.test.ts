import { describe, expect, it } from "vitest";
import { createAccountSchema, updateAccountSchema } from "../../src/accounts/schemas.js";

const removedAutomation = {
  autoCommandEnabled: true, autoCommandText: "/home farm",
  autoCommandIntervalMinutes: 10, autoCommandSpanEnabled: true,
  autoCommandSpanMinSeconds: 300, autoCommandSpanMaxSeconds: 3600,
  dailyCommandEnabled: true, dailyCommandTimes: ["08:00"],
  tpAutoEnabled: true, tpAutoAllowlist: ["Steve"],
  balanceEnabled: true, balanceCommand: "/bal", homes: ["farm"],
};

describe("removed account automation", () => {
  it("ignores auto-home, auto-TPA, homes and balance fields on updates for all roles", () => {
    expect(updateAccountSchema.parse({ ...removedAutomation, crouchEnabled: true, autoSellEnabled: true }))
      .toEqual({ crouchEnabled: true, autoSellEnabled: true });
  });

  it("does not accept removed automation on creation", () => {
    const parsed = createAccountSchema.parse({
      name: "Bot_01", serverHost: "localhost", credentialsSecret: "bot@example.com",
      ...removedAutomation, crouchEnabled: true, autoSellEnabled: true,
    });
    for (const key of Object.keys(removedAutomation)) expect(parsed).not.toHaveProperty(key);
    expect(parsed).toMatchObject({ crouchEnabled: true, autoSellEnabled: true });
  });
});
