import { useEffect, useRef, useState } from "react";
import { apiFetch, ApiError } from "./api";

export interface WebsiteUpdateResponse {
  unread: boolean;
  announcement: {
    id: string;
    date: string;
    title: string;
    introduction: string;
    items: Array<{ title: string; description: string; hint: string }>;
  };
}

interface UpdatesRun {
  userId: string;
  open: boolean;
  refresh: () => void;
  read: () => void;
}

/** One status read per login/focus; content renders only on opening.
 * The server owns the announcement ID and persists each user's read marker.
 */
export function useWebsiteUpdates(userId: string | undefined) {
  const [data, setData] = useState<WebsiteUpdateResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const runRef = useRef<UpdatesRun | null>(null);

  useEffect(() => {
    setData(null); setOpen(false); setError(null);
    if (!userId) { runRef.current = null; return; }
    const controller = new AbortController();
    let active = true, refreshing = false, saving = false, revision = 0;
    let response: WebsiteUpdateResponse | null = null;
    let pendingRead: string | null = null;
    const options = { signal: controller.signal, headers: { "x-profile-owner": userId } };

    async function read() {
      if (saving || !response || (!response.unread && !pendingRead)) return;
      saving = true; revision++;
      const announcementId = response.announcement.id;
      pendingRead = announcementId;
      // Opening acknowledges the update immediately, even on a slow network.
      response = { ...response, unread: false }; setData(response); setError(null);
      try {
        await apiFetch<WebsiteUpdateResponse>("/profile/updates/read", {
          ...options, method: "PATCH", body: JSON.stringify({ announcementId }),
        });
        if (active) { pendingRead = null; setError(null); }
      } catch (failure) {
        if (active) {
          if (failure instanceof ApiError && failure.status === 409) {
            response = null; pendingRead = null; setData(null);
            setError("Die Ankündigung wurde aktualisiert. Bitte erneut laden.");
          } else setError("Der Gelesen-Status konnte nicht gespeichert werden. Bitte erneut versuchen.");
        }
      } finally { saving = false; }
    }

    async function refresh() {
      if (refreshing || saving) return;
      refreshing = true; const startedAt = revision;
      if (!response) setLoading(true);
      try {
        const result = await apiFetch<WebsiteUpdateResponse>("/profile/updates", options);
        if (!active || revision !== startedAt) return;
        response = result;
        // Keep an unacknowledged write queued across a temporary outage.
        if (pendingRead === result.announcement.id) response = { ...result, unread: false };
        else pendingRead = null;
        setData(response); setError(null);
        if (run.open) void read();
      } catch {
        if (active && !response) setError("Die Updates konnten nicht geladen werden. Bitte erneut versuchen.");
      } finally {
        refreshing = false;
        if (active) setLoading(false);
      }
    }
    const run: UpdatesRun = { userId, open: false, refresh: () => void refresh(), read: () => void read() };
    runRef.current = run;
    const onFocus = () => { if (document.visibilityState === "visible") void refresh(); };
    void refresh();
    window.addEventListener("focus", onFocus);
    return () => { active = false; controller.abort(); window.removeEventListener("focus", onFocus); };
  }, [userId]);

  const ownerMatches = runRef.current?.userId === userId;
  return {
    data: ownerMatches ? data : null, open: ownerMatches && open,
    error: ownerMatches ? error : null, loading: ownerMatches && loading,
    show: () => {
      const run = runRef.current;
      if (!run || run.userId !== userId) return;
      run.open = true; setOpen(true);
      if (data) run.read(); else run.refresh();
    },
    close: () => { if (runRef.current) runRef.current.open = false; setOpen(false); },
    retry: () => { const run = runRef.current; if (run && run.userId === userId) { if (data) run.read(); else run.refresh(); } },
  };
}
