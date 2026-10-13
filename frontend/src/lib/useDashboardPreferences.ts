import { useCallback, useEffect, useRef, useState } from "react";
import { api, apiFetch, ApiError } from "./api";
import type { CurrentUser, DashboardPreferences } from "./types";

type Patch = {
  accountOrder?: string[];
  uploaderOrder?: string[];
  blur?: { accountId: string; value: boolean };
  collapse?: { uploaderId: string; value: boolean };
};
interface Response { initialized: boolean; preferences: DashboardPreferences }
const membership = (ids: string[], id: string, value: boolean) => value
  ? [...new Set([...ids, id])] : ids.filter(item => item !== id);
function apply(preferences: DashboardPreferences, patch: Patch): DashboardPreferences {
  return { ...preferences,
    ...(patch.accountOrder && { accountOrder: patch.accountOrder }),
    ...(patch.uploaderOrder && { uploaderOrder: patch.uploaderOrder }),
    ...(patch.blur && { blurredAccountIds: membership(preferences.blurredAccountIds, patch.blur.accountId, patch.blur.value) }),
    ...(patch.collapse && { collapsedUploaderIds: membership(preferences.collapsedUploaderIds, patch.collapse.uploaderId, patch.collapse.value) }),
  };
}

function legacyKeys(id: string) { return [`afk.blurredAccounts.${id}`, `afk.uploaderCategories.v1.${id}`]; }
function readLegacy(user: CurrentUser): DashboardPreferences | null {
  try {
    const [blurKey, uploaderKey] = legacyKeys(user.id);
    const blur = localStorage.getItem(blurKey), uploader = localStorage.getItem(uploaderKey);
    if (blur === null && uploader === null) return null;
    const parse = (raw: string | null) => { try { return JSON.parse(raw ?? "null"); } catch { return null; } };
    const strings = (value: unknown): string[] => Array.isArray(value)
      ? [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 160))].slice(0, 10000) : [];
    const categories = user.role === "ADMIN" ? parse(uploader) : null;
    return { accountOrder: [], blurredAccountIds: strings(parse(blur)),
      uploaderOrder: strings(categories?.order), collapsedUploaderIds: strings(categories?.collapsed) };
  } catch { return null; }
}
function clearLegacy(id: string) {
  try { for (const key of legacyKeys(id)) localStorage.removeItem(key); } catch { /* Optional migration cleanup. */ }
}

interface Run {
  userId: string | undefined;
  role: CurrentUser["role"] | undefined;
  active: boolean;
  controller: AbortController;
  confirmed: DashboardPreferences | null;
  pending: Patch[];
  saving: boolean;
  version: number;
}

/** Optimistic edits are serialized and replayed over each server response.
 * Temporary failures stay queued; changing users cancels the old user's work.
 */
export function useDashboardPreferences(user: CurrentUser | null) {
  const runRef = useRef<Run | null>(null);
  const [preferences, setPreferences] = useState<DashboardPreferences | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const userId = user?.id;
  const role = user?.role;

  const refresh = useCallback(async () => {
    const run = runRef.current;
    if (!run?.active || !userId || !role || run.userId !== userId || run.role !== role) return;
    const version = run.version;
    try {
      let response = await api.get<Response>("/profile/dashboard", { signal: run.controller.signal });
      if (!run.active) return;
      if (!response?.preferences) throw new Error("Invalid dashboard profile response");
      if (!response.initialized) {
        const legacy = readLegacy({ id: userId, role, username: "", status: "ACTIVE" });
        if (legacy) response = await apiFetch<Response>("/profile/dashboard/import", {
          method: "POST", body: JSON.stringify(legacy), signal: run.controller.signal, headers: { "x-profile-owner": userId },
        });
      }
      if (!run.active) return;
      if (response.initialized) clearLegacy(userId);
      // A completed write is newer than a refresh started before that write.
      if (version !== run.version) return;
      run.confirmed = response.preferences;
      setPreferences(run.pending.reduce(apply, response.preferences));
      if (!run.pending.length) setError(null);
    } catch (failure) {
      if (run.active) setError(`Ansicht konnte nicht geladen werden: ${failure instanceof ApiError ? failure.message : "Verbindung fehlgeschlagen"}`);
    }
  }, [userId, role]);

  const flush = useCallback(async () => {
    const run = runRef.current;
    if (!run?.active || run.saving || !run.confirmed) return;
    run.saving = true;
    setSaving(true);
    try {
      while (run.active && run.pending.length) {
        const response = await apiFetch<Response>("/profile/dashboard", {
          method: "PATCH", body: JSON.stringify(run.pending[0]), signal: run.controller.signal, headers: { "x-profile-owner": run.userId! },
        });
        if (!run.active) return;
        if (!response?.preferences) throw new Error("Invalid dashboard profile response");
        run.pending.shift();
        run.confirmed = response.preferences;
        run.version++;
        setPreferences(run.pending.reduce(apply, response.preferences));
      }
      if (run.active) setError(null);
    } catch (failure) {
      if (run.active) {
        // An outdated order or revoked permission must not permanently block
        // later edits. Retry refreshes the server state after a rejected edit.
        if (failure instanceof ApiError && [400, 401, 403, 404, 409].includes(failure.status)) run.pending.shift();
        setError(`Ansicht konnte nicht gespeichert werden: ${failure instanceof ApiError ? failure.message : "Verbindung fehlgeschlagen"}`);
      }
    } finally {
      run.saving = false;
      if (run.active) setSaving(false);
    }
  }, []);

  useEffect(() => {
    const run: Run = { userId, role, active: true, controller: new AbortController(), confirmed: null, pending: [], saving: false, version: 0 };
    runRef.current = run;
    setPreferences(null);
    setError(null);
    setSaving(false);
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      run.active = false;
      run.controller.abort();
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh, userId, role]);

  function update(patch: Patch) {
    const run = runRef.current;
    if (!run?.active || !run.confirmed) return;
    run.pending.push(patch);
    setPreferences(run.pending.reduce(apply, run.confirmed));
    void flush();
  }

  const ownerMatches = runRef.current?.userId === userId && runRef.current?.role === role;
  return { preferences: ownerMatches ? preferences : null, saving: ownerMatches && saving, error: ownerMatches ? error : null, update, refresh,
    retry: () => { if (runRef.current?.pending.length) void flush(); else void refresh(); } };
}
