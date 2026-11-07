import { create, fromJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { SettingsNamespaceSchema, SettingsNamespace_SettingsEntrySchema, type SettingsNamespace } from "@soulfiremc/sdk/generated/soulfire/common_pb";

/** Merge one startup snapshot before replacing the owned account atomically.
 * Reconnecting must not rewrite/reload the SQLite instance once per setting. */
export function mergeBotSettings(current: SettingsNamespace[], updates: Record<string, Record<string, string | number | boolean>>): SettingsNamespace[] {
  const namespaces = new Map(current.map(namespace => [namespace.namespace, namespace]));
  for (const [namespace, entries] of Object.entries(updates)) {
    const merged = new Map((namespaces.get(namespace)?.entries ?? []).map(entry => [entry.key, entry]));
    for (const [key, value] of Object.entries(entries)) merged.set(key,
      create(SettingsNamespace_SettingsEntrySchema, { key, value: fromJson(ValueSchema, value) }));
    namespaces.set(namespace, create(SettingsNamespaceSchema, { namespace, entries: [...merged.values()] }));
  }
  return [...namespaces.values()];
}
