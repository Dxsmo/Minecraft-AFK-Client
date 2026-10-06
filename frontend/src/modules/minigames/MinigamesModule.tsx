import { NavLink, Route, Routes } from "react-router-dom";
import { Dashboard } from "./dashboard";
import { Lobbies, LobbyDetail, Players, Logs } from "./monitoring";
import { ContentPage, SettingsPage } from "./content";
export function MinigamesModule() {
  return (
    <section>
      <div className="mb-6">
        <p
          className="text-xs uppercase tracking-widest mb-1"
          style={{ color: "var(--accent-light)" }}
        >
          Minecraft SMP
        </p>
        <h1 className="text-2xl font-semibold">Minigames</h1>
        <p className="text-sm mt-2" style={{ color: "var(--text-muted)" }}>
          Lobbys, Spielinhalte und Dienststatus verwalten.
        </p>
      </div>
      <nav aria-label="Minigames" className="flex flex-wrap gap-1 mb-6">
        {[
          ["", "Übersicht"],
          ["lobbies", "Lobbys"],
          ["players", "Spieler"],
          ["games", "Spiele & Einstellungen"],
          ["content", "Inhalte"],
          ["logs", "Ereignisse"],
          ["backend", "Backend"],
        ].map(([path, label]) => (
          <NavLink
            key={path}
            to={"/minigames" + (path ? "/" + path : "")}
            end
            className={({ isActive }) =>
              `btn btn-sm ${isActive ? "btn-primary" : "btn-secondary"}`
            }
          >
            {label}
          </NavLink>
        ))}
      </nav>
      <Routes>
        <Route index element={<Dashboard />} />
        <Route path="backend" element={<Dashboard backend />} />
        <Route path="lobbies" element={<Lobbies />} />
        <Route path="lobbies/:id" element={<LobbyDetail />} />
        <Route path="players" element={<Players />} />
        <Route path="games" element={<SettingsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="content" element={<ContentPage />} />
        <Route path="logs" element={<Logs />} />
        <Route
          path="*"
          element={<p>Diese Minigame-Seite existiert nicht.</p>}
        />
      </Routes>
    </section>
  );
}
