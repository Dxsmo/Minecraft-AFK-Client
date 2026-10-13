import { describe, expect, it } from "vitest";
import { commandSchema, createAccountSchema, updateAccountSchema } from "../../src/accounts/schemas.js";

describe("slash-only Minecraft commands", () => {
  it.each(["hello", "/", " /help", "/ help", "/say hi\nhello", "/\u0000", "/help\rstop"])("rejects %j", command => {
    expect(commandSchema.safeParse({ command }).success).toBe(false);
  });
  it.each(["/help", "/home farm", "//wand", "/say hello world"])("accepts %j", command => {
    expect(commandSchema.parse({ command })).toEqual({ command });
  });
});

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
