import { useMemo, useState } from "react";

interface UploaderPreferences {
  order: string[];
  collapsed: string[];
}

function readPreferences(key: string | null): UploaderPreferences {
  try {
    const value = key ? JSON.parse(localStorage.getItem(key) ?? "null") : null;
    const strings = (input: unknown): string[] => Array.isArray(input)
      ? [...new Set(input.filter((item): item is string => typeof item === "string"))] : [];
    return { order: strings(value?.order), collapsed: strings(value?.collapsed) };
  } catch {
    return { order: [], collapsed: [] };
  }
}

/** Category preferences belong to the signed-in admin, independently of the
 * shared account ordering. Stable uploader IDs also survive username changes.
 */
export function useUploaderPreferences(adminId: string | null) {
  const key = adminId ? `afk.uploaderCategories.v1.${adminId}` : null;
  const restored = useMemo(() => readPreferences(key), [key]);
  const [changed, setChanged] = useState<{ key: string | null; value: UploaderPreferences } | null>(null);
  const preferences = changed?.key === key ? changed.value : restored;

  function save(value: UploaderPreferences) {
    setChanged({ key, value });
    try {
      if (key) localStorage.setItem(key, JSON.stringify(value));
    } catch { /* Categories remain usable when browser storage is unavailable. */ }
  }

  function toggle(id: string) {
    const collapsed = new Set(preferences.collapsed);
    if (collapsed.has(id)) collapsed.delete(id);
    else collapsed.add(id);
    save({ ...preferences, collapsed: [...collapsed] });
  }

  function reorder(order: string[]) {
    save({ ...preferences, order });
  }

  return { ...preferences, toggle, reorder };
}
