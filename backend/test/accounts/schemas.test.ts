import { describe, expect, it } from "vitest";
import {
  createAccountSchema, updateAccountSchema,
  stripAdminOnlyCreateFields, stripAdminOnlyFields,
} from "../../src/accounts/schemas.js";

const autoHome = {
  autoCommandEnabled: true,
  autoCommandText: "/home farm",
  autoCommandIntervalMinutes: 10,
  autoCommandSpanEnabled: true,
  autoCommandSpanMinSeconds: 300,
  autoCommandSpanMaxSeconds: 3600,
  dailyCommandEnabled: true,
  dailyCommandTimes: ["08:00"],
};

describe("admin-only auto home", () => {
  it("strips all home schedules from user updates and keeps ordinary settings", () => {
    const parsed = updateAccountSchema.parse({ ...autoHome, crouchEnabled: true, autoSellEnabled: true });
    expect(stripAdminOnlyFields(parsed)).toEqual({ crouchEnabled: true, autoSellEnabled: true });
  });

  it("resets home schedules on user creation", () => {
    const parsed = createAccountSchema.parse({
      name: "Bot_01", serverHost: "localhost", credentialsSecret: "bot@example.com",
      ...autoHome, crouchEnabled: true, autoSellEnabled: true,
    });
    const userInput = stripAdminOnlyCreateFields(parsed);
    expect(userInput).toMatchObject({
      autoCommandEnabled: false, autoCommandText: "", autoCommandSpanEnabled: false,
      dailyCommandEnabled: false, dailyCommandTimes: "[]",
      crouchEnabled: true, autoSellEnabled: true,
    });
    expect(parsed.autoCommandEnabled).toBe(true);
    expect(parsed.dailyCommandTimes).toBe('["08:00"]');
  });

  it("keeps home schedules available in the admin payload", () => {
    expect(updateAccountSchema.parse(autoHome)).toEqual({ ...autoHome, dailyCommandTimes: '["08:00"]' });
  });

  it("ignores removed balance settings for every role", () => {
    expect(updateAccountSchema.parse({ balanceEnabled: true, balanceCommand: "/bal" })).toEqual({});
    const created = createAccountSchema.parse({
      name: "Bot_01", serverHost: "localhost", credentialsSecret: "bot@example.com",
      balanceEnabled: true, balanceCommand: "/bal",
    });
    expect(created).not.toHaveProperty("balanceEnabled");
    expect(created).not.toHaveProperty("balanceCommand");
  });
});
