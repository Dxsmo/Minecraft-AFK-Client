import { NavLink, Outlet, useLocation } from "react-router-dom";
import { ErrorBoundary } from "./ErrorBoundary";
import { useAuth } from "../lib/useAuth";
import { Suspense, useEffect, useState } from "react";
import { useWebsiteUpdates } from "../lib/useWebsiteUpdates";
import { WebsiteUpdatesDialog, WebsiteVersion } from "./WebsiteUpdates";

type IconName = "notes" | "dashboard" | "users" | "logs" | "settings";

function Icon({ name }: { name: IconName }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (name) {
    case "notes":
      return <svg {...common}><path d="M14 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V10zM14 3v7h7M7 14h10M7 17h7" /></svg>;
    case "dashboard":
      return (
        <svg {...common}>
          <rect x="3" y="3" width="7" height="9" rx="1.5" />
          <rect x="14" y="3" width="7" height="5" rx="1.5" />
          <rect x="14" y="12" width="7" height="9" rx="1.5" />
          <rect x="3" y="16" width="7" height="5" rx="1.5" />
        </svg>
      );
    case "users":
      return (
        <svg {...common}>
          <circle cx="9" cy="8" r="3.2" />
          <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
          <path d="M16 5.5a3 3 0 0 1 0 5.8" />
          <path d="M18 20a5.5 5.5 0 0 0-2.5-4.6" />
        </svg>
      );
    case "logs":
      return (
        <svg {...common}>
          <path d="M8 6h12M8 12h12M8 18h12" />
          <circle cx="3.5" cy="6" r="1" />
          <circle cx="3.5" cy="12" r="1" />
          <circle cx="3.5" cy="18" r="1" />
        </svg>
      );
    case "settings":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
        </svg>
      );
  }
}

const navItems: { to: string; label: string; icon: IconName; adminOnly: boolean }[] = [
  { to: "/dashboard", label: "Dashboard", icon: "dashboard", adminOnly: false },
  { to: "/notes", label: "Notizen", icon: "notes", adminOnly: false },
  { to: "/users", label: "Admin Panel", icon: "users", adminOnly: true },
  { to: "/logs", label: "Audit Logs", icon: "logs", adminOnly: true },
  { to: "/settings", label: "Settings", icon: "settings", adminOnly: false },
];

export function Layout() {
  const { user, logout } = useAuth();
  const updates = useWebsiteUpdates(user?.id);
  const [logoutError, setLogoutError] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  async function signOut() {
    setLoggingOut(true); setLogoutError("");
    try { await logout(); }
    catch { setLogoutError("Abmelden ist gerade nicht möglich. Bitte erneut versuchen."); }
    finally { setLoggingOut(false); }
  }
  const location = useLocation();
  const initial = user?.username?.charAt(0).toUpperCase() ?? "?";

  useEffect(() => { window.scrollTo({ top: 0, left: 0, behavior: "instant" }); }, [location.pathname]);

  return (
    <div className="app-shell flex min-h-dvh">
      <aside
        className="app-sidebar sticky top-0 hidden h-dvh w-60 shrink-0 flex-col overflow-y-auto px-3 py-5 lg:flex"
      >
        <div className="flex items-center justify-center gap-2.5 sm:justify-start sm:px-2">
          <span
            className="brand-mark flex h-9 w-9 shrink-0 items-center justify-center rounded-lg p-1.5"
          >
            <img src="/desmodus-head.svg" alt="" className="h-full w-full object-contain" />
          </span>
          <div className="hidden leading-tight sm:block">
            <h1 className="text-sm font-semibold" style={{ color: "var(--text)" }}>
              Minecraft AFK
            </h1>
            <p className="text-[11px] font-medium" style={{ color: "var(--text-subtle)" }}>
              Hosted by Desmo
            </p>
          </div>
        </div>

        <nav className="mt-7 flex flex-col gap-0.5">
          {navItems
            .filter((item) => !item.adminOnly || user?.role === "ADMIN")
            .map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                aria-label={item.label}
                title={item.label}
                className={({ isActive }) =>
                  `flex items-center justify-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-all sm:justify-start ${
                    isActive ? "nav-active" : "nav-idle"
                  }`
                }
              >
                <Icon name={item.icon} />
                <span className="hidden sm:inline">{item.label}</span>
              </NavLink>
            ))}
        </nav>

        <div className="mt-auto hidden px-1.5 pt-4 sm:block">
          <WebsiteVersion updates={updates} />
        </div>
      </aside>

      <div className="app-content flex min-w-0 flex-1 flex-col">
        <header
          className="app-header sticky top-0 z-10 flex items-center justify-end gap-3 px-3 py-3 backdrop-blur sm:px-6"
        >
          <LinkBrand />
          <div className="mobile-only"><WebsiteVersion updates={updates} compact /></div>
          <div className="header-user min-w-0 text-right leading-tight">
            <p className="truncate text-sm font-medium" style={{ color: "var(--text)" }}>
              {user?.username}
            </p>
            <p className="desktop-only text-[11px]" style={{ color: "var(--text-subtle)" }}>
              {user?.role}
            </p>
          </div>
          <span
            className="desktop-only user-avatar flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold"
          >
            {initial}
          </span>
          {logoutError && <p role="alert" className="text-xs" style={{ color: "#f87171" }}>{logoutError}</p>}
          <button onClick={() => void signOut()} disabled={loggingOut} className="btn btn-ghost btn-sm">
            Log out
          </button>
        </header>
        <main className="min-w-0 flex-1 p-3 sm:p-6">
          <div className="mx-auto max-w-6xl">
            <ErrorBoundary resetKey={location.pathname}>
              <Suspense fallback={<p role="status" className="text-sm text-slate-400">Seite wird geladen…</p>}>
                <Outlet />
              </Suspense>
            </ErrorBoundary>
          </div>
        </main>
      </div>
      <nav className="mobile-nav" aria-label="Mobile Navigation">
        {navItems.filter(item => ["/dashboard", "/users", "/settings"].includes(item.to)
          && (!item.adminOnly || user?.role === "ADMIN")).map(item => (
          <NavLink key={item.to} to={item.to} className={({ isActive }) => isActive ? "nav-active" : "nav-idle"}>
            <Icon name={item.icon} />
            <span>{item.to === "/dashboard" ? "Accounts" : item.to === "/settings" ? "Einstellungen" : item.label}</span>
          </NavLink>
        ))}
      </nav>
      {updates.open && <WebsiteUpdatesDialog updates={updates} />}
    </div>
  );
}

function LinkBrand() {
  return <NavLink to="/dashboard" className="mobile-brand" aria-label="Minecraft AFK Accounts">
    <img src="/desmodus-head.svg" alt="" width="28" height="28" />
    <span>AFK</span>
  </NavLink>;
}
