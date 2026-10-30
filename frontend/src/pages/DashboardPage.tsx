import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/useAuth";
import { useDashboardSocket } from "../lib/sockets";
import type { DashboardAccount, ManagedUser } from "../lib/types";
import { StatusBadge } from "../components/StatusBadge";
const CreateAccountDialog = lazy(() => import("../components/CreateAccountDialog").then(module => ({ default: module.CreateAccountDialog })));
import { AccountImageButton } from "../components/AccountImageButton";
import { AccountCreatorAvatar } from "../components/AccountCreatorAvatar";
import { AccountSellPreview } from "../components/AccountSellPreview";
import { AccountDetails } from "../components/AccountDetails";
import { useCompactLayout } from "../lib/useCompactLayout";
import { UploaderCategory } from "../components/UploaderCategory";

type Uploader = Pick<ManagedUser, "id" | "username" | "minecraftUsername">;
const uploaderKey = (account: DashboardAccount) => account.createdBy ? `user:${account.createdBy.id}` : "unassigned";

export function DashboardPage() {
  const { user, dashboardProfile: profile } = useAuth();
  const refreshProfile = profile.refresh;
  const isAdmin = user?.role === "ADMIN";
  const compact = useCompactLayout();
  const [accounts, setAccounts] = useState<DashboardAccount[] | null>(null);
  const [uploaders, setUploaders] = useState<Uploader[] | null>(null);
  const preferences = profile.preferences;
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const reorderBusy = profile.saving;
  const [now, setNow] = useState(Date.now);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const lastSales = useRef<Record<string, string>>({});
  const blurred = useMemo(() => new Set(preferences?.blurredAccountIds ?? []), [preferences?.blurredAccountIds]);
  function updateImage(update: { id: string; imageUrl: string }) {
    setAccounts((prev) => prev?.map((account) => account.id === update.id ? { ...account, imageUrl: update.imageUrl } : account) ?? null);
  }
  function updateSale(update: { id: string; lastSellAt: string }) {
    const previous = lastSales.current[update.id];
    if (previous && Date.parse(previous) >= Date.parse(update.lastSellAt)) return;
    lastSales.current[update.id] = update.lastSellAt;
    setAccounts((prev) => prev?.map((account) => account.id === update.id
      && (!account.lastSellAt || Date.parse(account.lastSellAt) < Date.parse(update.lastSellAt))
      ? { ...account, lastSellAt: update.lastSellAt } : account) ?? null);
    setNow(Date.now());
  }
  const liveStatuses = useDashboardSocket(updateImage, () => { void load(); void profile.refresh(); }, updateSale);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timestamps = (accounts ?? []).map(account => Date.parse(account.lastSellAt ?? "")).filter(Number.isFinite);
    const refresh = () => {
      clearTimeout(timer);
      if (document.hidden) return;
      const current = Date.now();
      setNow(current);
      if (timestamps.length) {
        // Each account advances at its own sale + 30s boundary, even when other accounts keep selling.
        const delay = Math.min(...timestamps.map(at => at > current ? at - current + 30_000 : 30_000 - (current - at) % 30_000));
        timer = setTimeout(refresh, delay);
      }
    };
    refresh();
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [accounts]);

  function toggleBlur(id: string) {
    profile.update({ blur: { accountId: id, value: !blurred.has(id) } });
  }

  const load = useCallback(async () => {
    try {
      // Only admins can list website users. Include users without any uploads;
      // assignments are deliberately unrelated to uploader categories.
      const [loaded, users] = await Promise.all([
        api.get<DashboardAccount[]>("/minecraft/accounts?view=dashboard"),
        isAdmin ? api.get<Uploader[]>("/users") : Promise.resolve([]),
      ]);
      setUploaders(users.map(({ id, username, minecraftUsername }) => ({ id, username, minecraftUsername: minecraftUsername ?? null })));
      setError(null);
      setAccounts(loaded.map((account) => {
        const liveSale = lastSales.current[account.id];
        return liveSale && (!account.lastSellAt || Date.parse(liveSale) > Date.parse(account.lastSellAt))
          ? { ...account, lastSellAt: liveSale } : account;
      }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load accounts");
    }
  }, [isAdmin]);

  useEffect(() => {
    void load();
    void refreshProfile();
  }, [load, refreshProfile]);

  const orderedAccounts = useMemo(() => {
    const ranks = new Map((preferences?.accountOrder ?? []).map((id, index) => [id, index]));
    return [...accounts ?? []].sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity));
  }, [accounts, preferences?.accountOrder]);

  const merged = useMemo(
    () => (accounts ?? []).map((a) => ({ ...a, live: liveStatuses[a.id] ?? a.live })),
    [accounts, liveStatuses],
  );

  const uploaderGroups = useMemo(() => {
    if (!isAdmin) return [];
    const groups = new Map<string, { id: string; username: string; minecraftUsername: string | null; accounts: DashboardAccount[] }>();
    for (const uploader of uploaders ?? []) {
      const id = `user:${uploader.id}`;
      groups.set(id, { id, username: uploader.username, minecraftUsername: uploader.minecraftUsername, accounts: [] });
    }
    for (const account of orderedAccounts) {
      const id = uploaderKey(account);
      // Preserve legacy accounts and uploads whose creator was deleted, as
      // well as creators added between the two dashboard requests.
      if (!groups.has(id)) groups.set(id, { id, username: account.createdBy?.username ?? "Ohne Uploader",
        minecraftUsername: account.createdBy?.minecraftUsername ?? null, accounts: [] });
      groups.get(id)!.accounts.push(account);
    }
    const ranks = new Map((preferences?.uploaderOrder ?? []).map((id, index) => [id, index]));
    return [...groups.values()].sort((a, b) => {
      const rankA = ranks.get(a.id), rankB = ranks.get(b.id);
      if (rankA !== undefined || rankB !== undefined) return (rankA ?? Infinity) - (rankB ?? Infinity);
      if (a.id === "unassigned" || b.id === "unassigned") return a.id === "unassigned" ? 1 : -1;
      return a.username.localeCompare(b.username) || a.id.localeCompare(b.id);
    });
  }, [isAdmin, uploaders, orderedAccounts, preferences?.uploaderOrder]);

  function moveCategory(id: string, direction: -1 | 1) {
    const order = uploaderGroups.map(group => group.id);
    const index = order.indexOf(id), target = index + direction;
    if (index < 0 || target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    profile.update({ uploaderOrder: order });
  }

  const counts = useMemo(() => {
    const statuses = merged.map((a) => a.live?.status ?? a.status);
    return {
      total: statuses.length,
      online: statuses.filter((s) => s === "ONLINE").length,
      offline: statuses.filter((s) => s === "OFFLINE" || s === "DISCONNECTING").length,
      error: statuses.filter((s) => s === "ERROR").length,
    };
  }, [merged]);

  async function runAction(id: string, action: "start" | "stop") {
    setBusyIds((prev) => new Set(prev).add(id));
    try {
      await api.post(`/minecraft/accounts/${id}/${action}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Failed to ${action}`);
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  async function deleteAccount(id: string, name: string) {
    if (!confirm(`Delete Minecraft account "${name}"? This cannot be undone.`)) return;
    setBusyIds((prev) => new Set(prev).add(id));
    try {
      await api.delete(`/minecraft/accounts/${id}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to delete account");
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  async function moveAccount(id: string, direction: -1 | 1) {
    if (!accounts || reorderBusy) return;
    const idx = orderedAccounts.findIndex((a) => a.id === id);
    if (idx < 0) return;
    const siblings = isAdmin ? orderedAccounts.filter(account => uploaderKey(account) === uploaderKey(orderedAccounts[idx])) : orderedAccounts;
    const neighbor = siblings[siblings.findIndex(account => account.id === id) + direction];
    if (!neighbor) return;
    const nextIdx = orderedAccounts.findIndex(account => account.id === neighbor.id);
    const next = [...orderedAccounts];
    [next[idx], next[nextIdx]] = [next[nextIdx], next[idx]];
    profile.update({ accountOrder: next.map(account => account.id) });
  }

  const actions = useRef({ moveAccount, updateImage, toggleBlur, runAction, deleteAccount });
  actions.current = { moveAccount, updateImage, toggleBlur, runAction, deleteAccount };

  function renderAccount(account: DashboardAccount, index: number, total: number) {
    return <AccountCard key={account.id}
      account={account} live={liveStatuses[account.id] ?? account.live} index={index} total={total}
      busy={busyIds.has(account.id)} isBlurred={blurred.has(account.id)} expanded={expandedId === account.id}
      age={saleAge(account.lastSellAt, now)} reorderBusy={reorderBusy} actions={actions}
      compact={compact} setExpandedId={setExpandedId} setError={setError} />;
  }

  return (
    <div className="dashboard-page space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold" style={{ color: "var(--text)" }}>
            Dashboard
          </h1>
          <p className="mt-0.5 text-sm" style={{ color: "var(--text-muted)" }}>
            Overview of your Minecraft AFK clients
          </p>
        </div>
        <button onClick={() => setDialogOpen(true)} className="btn btn-primary">
          + New account
        </button>
      </div>

      <p className="mobile-only text-sm" style={{ color: "var(--text-muted)" }}>{counts.online} / {counts.total} Accounts online</p>
      <div className="desktop-only grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Online" value={counts.online} accent="#38bdf8" />
        <StatCard label="Offline" value={counts.offline} accent="#8a8a93" />
        <StatCard label="Errors" value={counts.error} accent="#f87171" />
      </div>

      {error && <p className="alert-error">{error}</p>}
      {profile.error && <div className="alert-error" role="alert">{profile.error}
        <button type="button" className="btn btn-ghost btn-sm ml-2" onClick={profile.retry}>Erneut versuchen</button>
      </div>}
      {profile.saving && <p role="status" className="text-sm" style={{ color: "var(--text-muted)" }}>Ansicht wird gespeichert…</p>}

      {accounts === null || preferences === null || (isAdmin && uploaders === null) ? (
        <div className="card p-10 text-center text-sm" style={{ color: "var(--text-subtle)" }}>
          Loading accounts…
        </div>
      ) : isAdmin ? (
        <div className="uploader-categories space-y-3">
          {uploaderGroups.map((group, index) => <UploaderCategory key={group.id}
            id={group.id} username={group.username} minecraftUsername={group.minecraftUsername} count={group.accounts.length}
            expanded={!preferences.collapsedUploaderIds.includes(group.id)} index={index} total={uploaderGroups.length}
            onToggle={() => {
              if (group.accounts.some(account => account.id === expandedId)) setExpandedId(null);
              profile.update({ collapse: { uploaderId: group.id, value: !preferences.collapsedUploaderIds.includes(group.id) } });
            }} onMove={direction => moveCategory(group.id, direction)}>
            {group.accounts.map((account, accountIndex) => renderAccount(account, accountIndex, group.accounts.length))}
          </UploaderCategory>)}
        </div>
      ) : merged.length === 0 ? (
        <div className="card p-14 text-center">
          <p className="text-sm font-medium" style={{ color: "var(--text)" }}>
            No Minecraft accounts yet
          </p>
          <p className="mx-auto mt-1 max-w-sm text-sm" style={{ color: "var(--text-muted)" }}>
            Create your first account to get started, or ask an admin to assign one to you.
          </p>
          <button onClick={() => setDialogOpen(true)} className="btn btn-secondary btn-sm mt-4">
            + New account
          </button>
        </div>
      ) : (
        <div className="space-y-2.5">
          {orderedAccounts.map((account, index) => renderAccount(account, index, orderedAccounts.length))}
        </div>
      )}

      {dialogOpen && (
        <Suspense fallback={<p role="status">Loading account form…</p>}>
          <CreateAccountDialog
            onClose={() => setDialogOpen(false)}
            onCreated={() => {
              setDialogOpen(false);
              void load();
            }}
          />
        </Suspense>
      )}
    </div>
  );
}

interface AccountCardProps {
  account: DashboardAccount;
  compact: boolean;
  live: DashboardAccount["live"];
  index: number;
  total: number;
  busy: boolean;
  isBlurred: boolean;
  expanded: boolean;
  age: string;
  reorderBusy: boolean;
  actions: RefObject<{
    moveAccount: (id: string, direction: -1 | 1) => Promise<void>;
    updateImage: (update: { id: string; imageUrl: string }) => void;
    toggleBlur: (id: string) => void;
    runAction: (id: string, action: "start" | "stop") => Promise<void>;
    deleteAccount: (id: string, name: string) => Promise<void>;
  }>;
  setExpandedId: Dispatch<SetStateAction<string | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
}

/** A live update or hover only renders the affected cards. Event handlers read
 * current page state through a stable ref, so reordering always uses the latest list.
 */
const AccountCard = memo(function AccountCard({ account, compact, live, index, total, busy, isBlurred, expanded, age,
  reorderBusy, actions, setExpandedId, setError }: AccountCardProps) {
  const status = live?.status ?? account.status;
  const label = account.displayName?.trim() || live?.name || account.name;
  const detailsId = `account-details-${account.id}`;
  const updateImage = (update: { id: string; imageUrl: string }) => actions.current.updateImage(update);
  return (
    <div
      key={account.id}
      className="card card-hover account-card relative"
      data-expanded={expanded}
      onPointerEnter={(event) => { if (!compact && event.pointerType === "mouse") setExpandedId(account.id); }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") setExpandedId(current => current === account.id ? null : current);
      }}
      onFocusCapture={(event) => { if (!compact && event.target.matches(":focus-visible")) setExpandedId(account.id); }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setExpandedId(current => current === account.id ? null : current);
      }}
    >
      <Link to={`/accounts/${account.id}?tab=console`} className="account-row-link absolute inset-0 z-10 rounded-[inherit]"
        aria-label={`Open console for ${isBlurred ? "account" : label}`} />
      <div className="account-row relative">
        <div className="account-sort relative z-20 flex flex-col items-center justify-center gap-1">
          <button
            type="button"
            className="desktop-only btn btn-ghost btn-sm px-1 sm:px-2"
            onClick={() => void actions.current.moveAccount(account.id, -1)}
            disabled={reorderBusy || index === 0}
            title="Move up"
            aria-label="Move up"
          >
            ↑
          </button>
          <button
            type="button"
            className="desktop-only btn btn-ghost btn-sm px-1 sm:px-2"
            onClick={() => void actions.current.moveAccount(account.id, 1)}
            disabled={reorderBusy || index === total - 1}
            title="Move down"
            aria-label="Move down"
          >
            ↓
          </button>
          <button type="button" className="account-details-toggle btn btn-ghost btn-sm"
            aria-expanded={expanded} aria-controls={detailsId}
            aria-label={expanded ? "Verkaufsdetails einklappen" : "Verkaufsdetails ausklappen"}
            onClick={() => setExpandedId(current => current === account.id ? null : account.id)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"
              style={{ transform: expanded ? "rotate(90deg)" : undefined, transition: "transform 300ms ease" }}><path d="m9 6 6 6-6 6" /></svg>
          </button>
        </div>
        <AccountImageButton accountId={account.id} imageUrl={account.imageUrl} blurred={isBlurred}
          onUpdated={updateImage} onError={setError} />
        <div
          className="account-summary min-w-0"
          style={{
            filter: isBlurred ? "blur(6px)" : undefined,
            userSelect: isBlurred ? "none" : undefined,
            pointerEvents: isBlurred ? "none" : undefined,
            transition: "filter 150ms ease",
          }}
          aria-hidden={isBlurred}
        >
          <div className="account-heading flex items-center">
            <span className="truncate font-medium" style={{ color: "var(--text)" }}>
              {label}
            </span>
            <StatusBadge status={status} />
            {account.edition === "BEDROCK" ? (
              <span
                className="hidden shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide sm:inline"
                style={{ backgroundColor: "rgba(245,158,11,0.15)", color: "var(--warning)" }}
              >
                Bedrock
              </span>
            ) : (
              <span
                className="hidden shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide sm:inline"
                style={{ backgroundColor: "var(--accent-soft)", color: "var(--accent)" }}
              >
                Java
              </span>
            )}
          </div>
          <NotesField accountId={account.id} initial={account.notes ?? ""} disabled={isBlurred} />
        </div>

        <div className="account-actions relative z-20 flex items-center">
          {!compact && <AccountCreatorAvatar account={account} blurred={isBlurred} />}
          <button
            type="button"
            onClick={() => actions.current.toggleBlur(account.id)}
            className={`${compact && !isBlurred ? "desktop-only " : ""}btn btn-ghost btn-sm`}
            title={isBlurred ? "Reveal account" : "Blur / censor account"}
            aria-label={isBlurred ? "Reveal account" : "Blur account"}
            aria-pressed={isBlurred}
          >
            <EyeIcon off={isBlurred} />
          </button>
          <button
            disabled={busy || status === "ONLINE" || status === "CONNECTING"}
            onClick={() => void actions.current.runAction(account.id, "start")}
            className="btn btn-secondary btn-sm"
            title="Start account" aria-label="Start account"
          >
            <svg className="sm:hidden" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m8 4 12 8-12 8z" /></svg>
            <span className="hidden sm:inline">Start</span>
          </button>
          <button
            disabled={busy || status === "OFFLINE"}
            onClick={() => void actions.current.runAction(account.id, "stop")}
            className="btn btn-secondary btn-sm"
            title="Stop account" aria-label="Stop account"
          >
            <svg className="sm:hidden" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 5h14v14H5z" /></svg>
            <span className="hidden sm:inline">Stop</span>
          </button>
          <button
            disabled={busy}
            onClick={() => void actions.current.deleteAccount(account.id, label)}
            className="desktop-only btn btn-danger btn-sm"
            title="Delete account" aria-label="Delete account"
          >
            <svg className="sm:hidden" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg>
            <span className="hidden sm:inline">Delete</span>
          </button>
        </div>
      </div>
      {!compact && <AccountDetails id={detailsId} expanded={expanded} blurred={isBlurred}>
        <div className="account-details-content"
          style={{ filter: isBlurred ? "blur(6px)" : undefined, userSelect: isBlurred ? "none" : undefined }}>
          <div className="account-details-meta min-w-0">
            <p className="account-server w-full truncate text-[10px]" style={{ color: "var(--text-subtle)" }}>
              {account.serverHost}
              {account.minecraftVersion ? ` · ${account.minecraftVersion}` : " · auto"}
            </p>
            <p className="account-last-sale text-[11px]" style={{ color: "var(--text-muted)" }}
              title={!isBlurred && account.lastSellAt ? new Date(account.lastSellAt).toLocaleString("de-DE") : undefined}>
              Letzter Verkauf: <span className="whitespace-nowrap tabular-nums">{age}</span>
            </p>
            <p className="account-created-by truncate text-[10px]" style={{ color: "var(--text-subtle)" }}>
              Erstellt von <span style={{ color: "var(--text-muted)" }}>{account.createdBy?.username ?? "unbekannt"}</span>
            </p>
          </div>
          <AccountSellPreview accountId={account.id} active={expanded} blurred={isBlurred} />
        </div>
      </AccountDetails>}
    </div>
  );
});

/** Age of the most recent confirmed sale, including accounts currently offline. */
function saleAge(timestamp: string | null, now: number): string {
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return "noch keiner";
  const seconds = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 30_000) * 30);
  if (seconds < 30) return "gerade eben";
  if (seconds < 60) return `${seconds} Sek.`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} Min.${seconds % 60 ? " 30 Sek." : ""}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} Std.${minutes % 60 ? ` ${minutes % 60} Min.` : ""}`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "Tag" : "Tage"}${hours % 24 ? ` ${hours % 24} Std.` : ""}`;
}

/** Inline, debounced-autosave note line for an account (no save button). */
function NotesField({ accountId, initial, disabled }: { accountId: string; initial: string; disabled: boolean }) {
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState(false);
  const savedRef = useRef(initial);

  useEffect(() => {
    setValue(initial);
    savedRef.current = initial;
  }, [initial, accountId]);

  useEffect(() => {
    if (value === savedRef.current) return;
    const t = setTimeout(async () => {
      try {
        await api.patch(`/minecraft/accounts/${accountId}`, { notes: value });
        savedRef.current = value;
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
      } catch {
        /* ignore transient autosave errors; will retry on next edit */
      }
    }, 600);
    return () => clearTimeout(t);
  }, [value, accountId]);

  return (
    <div className="relative z-20 mt-0.5 flex items-center gap-2 sm:mt-1.5">
      <input
        value={value}
        maxLength={50}
        disabled={disabled}
        aria-label="Account note"
        onChange={(e) => setValue(e.target.value)}
        placeholder="Add a note…"
        className="w-full max-w-xs bg-transparent text-[10px] outline-none sm:text-xs"
        style={{ color: "var(--text-muted)" }}
      />
      {saved && (
        <span className="shrink-0 text-[10px]" style={{ color: "var(--accent)" }}>
          saved
        </span>
      )}
    </div>
  );
}

/** Eye / eye-off icon used for the local blur toggle. */
function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {off ? (
        <>
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
          <line x1="1" y1="1" x2="23" y2="23" />
        </>
      ) : (
        <>
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </svg>
  );
}

function StatCard({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div className="card relative overflow-hidden p-4">
      <span
        className="absolute inset-y-0 left-0 w-1"
        style={{ backgroundColor: accent, opacity: 0.7 }}
        aria-hidden="true"
      />
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: accent, boxShadow: `0 0 0 3px ${accent}22` }} />
        <p className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
          {label}
        </p>
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums" style={{ color: "var(--text)" }}>
        {value}
      </p>
    </div>
  );
}
