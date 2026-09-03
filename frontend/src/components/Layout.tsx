import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../lib/auth";

type IconName = "dashboard" | "sniper" | "users" | "logs" | "settings";

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
  { to: "/namesniper", label: "Name Sniper", icon: "sniper", adminOnly: true },
  { to: "/users", label: "Users", icon: "users", adminOnly: true },
  { to: "/logs", label: "Audit Logs", icon: "logs", adminOnly: true },
  { to: "/settings", label: "Settings", icon: "settings", adminOnly: false },
];

export function Layout() {
  const { user, logout } = useAuth();
  const initial = user?.username?.charAt(0).toUpperCase() ?? "?";

  return (
    <div className="flex h-screen overflow-hidden" style={{ backgroundColor: "var(--bg)" }}>
      <aside
        className="flex w-60 shrink-0 flex-col overflow-y-auto px-3 py-5"
        style={{ borderRight: "1px solid var(--border)", backgroundColor: "var(--bg-elev)" }}
      >
        <div className="flex items-center gap-2.5 px-2">
          <span
            className="glow-ring flex h-9 w-9 shrink-0 items-center justify-center rounded-lg p-1.5"
            style={{ backgroundColor: "var(--accent-soft)" }}
          >
            <img src="/favicon.png" alt="" className="h-full w-full object-contain" />
          </span>
          <div className="leading-tight">
            <h1 className="text-sm font-semibold" style={{ color: "var(--text)" }}>
              Minecraft AFK
            </h1>
            <p className="text-[11px] font-medium" style={{ color: "var(--text-subtle)" }}>
              Hosted by Desmodus
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
                className={({ isActive }) =>
                  `flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-all ${
                    isActive ? "nav-active" : "nav-idle"
                  }`
                }
              >
                <Icon name={item.icon} />
                {item.label}
              </NavLink>
            ))}
        </nav>

        <div className="mt-auto px-1.5 pt-4">
          <span className="version-badge">
            <span className="version-dot" />
            <span className="version-text">V4.2.0</span>
          </span>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="sticky top-0 z-10 flex items-center justify-end gap-3 px-6 py-3 backdrop-blur"
          style={{ borderBottom: "1px solid var(--border)", backgroundColor: "rgba(10,10,11,0.75)" }}
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
            className="flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold"
            style={{ backgroundColor: "var(--surface-hover)", color: "var(--text-muted)" }}
          >
            {initial}
          </span>
          <button onClick={() => void logout()} className="btn btn-ghost btn-sm">
            Log out
          </button>
        </header>
        <main className="min-w-0 flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-6xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
