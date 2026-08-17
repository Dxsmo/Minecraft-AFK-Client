import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../lib/auth";

const navItems = [
  { to: "/dashboard", label: "Dashboard", adminOnly: false },
  { to: "/users", label: "Users", adminOnly: true },
  { to: "/logs", label: "Audit Logs", adminOnly: true },
  { to: "/settings", label: "Settings", adminOnly: false },
];

export function Layout() {
  const { user, logout } = useAuth();

  return (
    <div className="flex min-h-screen bg-slate-950">
      <aside className="w-60 shrink-0 border-r border-slate-800 bg-slate-900 px-4 py-6">
        <div className="mb-8 px-2">
          <h1 className="text-base font-semibold text-slate-100">Minecraft AFK</h1>
          <p className="text-xs text-slate-500">Client Management</p>
          <p className="mt-1 text-[11px] text-slate-600">Hosted by Desmodus</p>
        </div>
        <nav className="flex flex-col gap-1">
          {navItems
            .filter((item) => !item.adminOnly || user?.role === "ADMIN")
            .map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    isActive ? "bg-slate-700 text-white" : "text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-slate-800 bg-slate-900 px-6 py-3">
          <div />
          <div className="flex items-center gap-3">
            <div className="text-right">
              <p className="text-sm font-medium text-slate-100">{user?.username}</p>
              <p className="text-xs text-slate-500">{user?.role}</p>
            </div>
            <button onClick={() => void logout()} className="btn-secondary">
              Log out
            </button>
          </div>
        </header>
        <main className="min-w-0 flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
