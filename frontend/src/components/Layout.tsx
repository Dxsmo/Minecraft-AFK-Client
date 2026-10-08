import { NavLink, Outlet, useLocation } from "react-router-dom";
import { ErrorBoundary } from "./ErrorBoundary";
import { useAuth } from "../lib/auth";

type IconName = "notes" | "minigames" | "dashboard" | "sniper" | "worth" | "users" | "logs" | "settings";

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
    case "minigames":
      return <svg {...common}><rect x="2" y="6" width="20" height="12" rx="4"/><path d="M7 10v4M5 12h4M16 10h.01M19 14h.01"/></svg>;
    case "dashboard":
      return (
        <svg {...common}>
          <rect x="3" y="3" width="7" height="9" rx="1.5" />
          <rect x="14" y="3" width="7" height="5" rx="1.5" />
          <rect x="14" y="12" width="7" height="9" rx="1.5" />
          <rect x="3" y="16" width="7" height="5" rx="1.5" />
        </svg>
      );
    case "sniper":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" />
          <circle cx="12" cy="12" r="2.5" />
          <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
        </svg>
      );
    case "worth":
      return (
        <svg {...common}>
          <polyline points="3 16 9 10 13 14 21 6" />
          <polyline points="15 6 21 6 21 12" />
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
  { to: "/namesniper", label: "Name Sniper", icon: "sniper", adminOnly: true },
  { to: "/minigames", label: "Minigames", icon: "minigames", adminOnly: true },
  { to: "/item-worth", label: "Item Wert", icon: "worth", adminOnly: true },
  { to: "/users", label: "Users", icon: "users", adminOnly: true },
  { to: "/logs", label: "Audit Logs", icon: "logs", adminOnly: true },
  { to: "/settings", label: "Settings", icon: "settings", adminOnly: false },
];

export function Layout() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const initial = user?.username?.charAt(0).toUpperCase() ?? "?";

  return (
    <div className="app-shell flex h-screen overflow-hidden">
      <aside
        className="app-sidebar flex w-14 shrink-0 flex-col overflow-y-auto px-2 py-5 sm:w-60 sm:px-3"
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
          <span className="version-badge" aria-label="Version V4.2.0">
            <span className="version-icon" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3ZM4 7.5l8 4.5 8-4.5M12 12v9" /></svg></span>
            <span className="version-text">V4.2.0</span>
            <span className="version-spark" aria-hidden="true" />
          </span>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="app-header sticky top-0 z-10 flex items-center justify-end gap-3 px-3 py-3 backdrop-blur sm:px-6"
        >
          <div className="text-right leading-tight">
            <p className="text-sm font-medium" style={{ color: "var(--text)" }}>
              {user?.username}
            </p>
            <p className="text-[11px]" style={{ color: "var(--text-subtle)" }}>
              {user?.role}
            </p>
          </div>
          <span
            className="user-avatar flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold"
          >
            {initial}
          </span>
          <button onClick={() => void logout()} className="btn btn-ghost btn-sm">
            Log out
          </button>
        </header>
        <main className="min-w-0 flex-1 overflow-y-auto p-3 sm:p-6">
          <div className="mx-auto max-w-6xl">
            <ErrorBoundary resetKey={location.pathname}>
              <Outlet />
            </ErrorBoundary>
          </div>
        </main>
      </div>
    </div>
  );
}
