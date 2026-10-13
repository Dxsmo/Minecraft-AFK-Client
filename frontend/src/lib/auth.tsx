import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError, clearApiReadCache } from "./api";
import type { CurrentUser } from "./types";
import { useDashboardPreferences } from "./useDashboardPreferences";

interface AuthContextValue {
  user: CurrentUser | null;
  loading: boolean;
  dashboardProfile: ReturnType<typeof useDashboardPreferences>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  // Keep pending profile writes alive when navigating between website pages.
  const dashboardProfile = useDashboardPreferences(user);
  // A fresh document always starts signed out; rendering its login form does
  // not require a round trip to the server.
  const [loading, setLoading] = useState(false);
  const startupLogout = useRef<Promise<unknown> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { user } = await api.get<{ user: CurrentUser }>("/auth/me");
      setUser(user);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setUser(null);
      } else {
        throw err;
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Security: every fresh document load (a reload or a newly opened tab)
    // starts logged out. We proactively destroy any lingering server session
    // so the httpOnly session cookie can't silently re-authenticate the
    // previous user — important on shared machines. In-app navigation uses the
    // SPA router (no reload), so an active session is unaffected.
    // Without a CSRF cookie there cannot be a valid logout request. Show the
    // login form immediately for fresh browsers. Share the cleanup in StrictMode.
    startupLogout.current ??= document.cookie.split(";").some(cookie => cookie.trim().startsWith("afk_csrf="))
      ? api.post("/auth/logout").catch(() => undefined)
      : Promise.resolve();
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    // Finish (or time out) the old-session cleanup before accepting a new
    // cookie. A delayed logout response must never clear the new session.
    await startupLogout.current;
    const loggedIn = await api.post<CurrentUser>("/auth/login", { username, password });
    setUser(loggedIn);
  }, []);

  const logout = useCallback(async () => {
    await api.post("/auth/logout");
    clearApiReadCache();
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, loading, dashboardProfile, login, logout, refresh }), [user, loading, dashboardProfile, login, logout, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
