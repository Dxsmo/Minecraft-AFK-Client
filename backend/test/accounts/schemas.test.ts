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
  autoAddOtherEdition: true, linkedAccountId: "retired-link",
  autoCommandEnabled: true, autoCommandText: "/home farm",
  autoCommandIntervalMinutes: 10, autoCommandSpanEnabled: true,
  autoCommandSpanMinSeconds: 300, autoCommandSpanMaxSeconds: 3600,
  dailyCommandEnabled: true, dailyCommandTimes: ["08:00"],
  tpAutoEnabled: true, tpAutoAllowlist: ["Steve"],
  balanceEnabled: true, balanceCommand: "/bal", homes: ["farm"],
};

describe("persistent mutually exclusive mouse input", () => {
  it.each(["OFF", "LEFT", "RIGHT"])("accepts %s on creation and live updates", autoButton => {
    expect(createAccountSchema.parse({ name: "Bot", serverHost: "localhost", credentialsSecret: "bot@example.com", autoButton }).autoButton).toBe(autoButton);
    expect(updateAccountSchema.parse({ autoButton })).toEqual({ autoButton });
  });
  it("defaults off and rejects simultaneous or unknown buttons", () => {
    expect(createAccountSchema.parse({ name: "Bot", serverHost: "localhost", credentialsSecret: "bot@example.com" }).autoButton).toBe("OFF");
    for (const autoButton of [["LEFT", "RIGHT"], "BOTH", "left", null]) expect(updateAccountSchema.safeParse({ autoButton }).success).toBe(false);
  });
});

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
