import { expect, it } from "vitest";
import { create, fromJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { SettingsNamespaceSchema } from "@soulfiremc/sdk/generated/soulfire/common_pb";
import { mergeBotSettings } from "../../src/soulfire/settings.js";

it("preserves unknown account settings and namespaces while replacing managed entries once", () => {
  const original = [create(SettingsNamespaceSchema, { namespace: "bot", entries: [
    { key: "custom", value: fromJson(ValueSchema, "preserve") },
    { key: "protocol-version", value: fromJson(ValueSchema, "old") },
  ] }), create(SettingsNamespaceSchema, { namespace: "other", entries: [{ key: "keep", value: fromJson(ValueSchema, true) }] })];
  const merged = mergeBotSettings(original, { bot: { "protocol-version": "new" }, "afk-service": { "crouch-enabled": true } });
  expect(merged.find(namespace => namespace.namespace === "bot")?.entries.map(entry => [entry.key, entry.value?.kind.value]))
    .toEqual([["custom", "preserve"], ["protocol-version", "new"]]);
  expect(merged.find(namespace => namespace.namespace === "other")).toBe(original[1]);
  expect(original[0].entries[1].value?.kind.value).toBe("old");
});
