import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiError } from "./api";
import type { CurrentUser } from "./types";

interface AuthContextValue {
  user: CurrentUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

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
    void (async () => {
      try {
        await api.post("/auth/logout");
      } catch {
        // No active session to clear — nothing to do.
      }
      setUser(null);
      setLoading(false);
    })();
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const loggedIn = await api.post<CurrentUser>("/auth/login", { username, password });
    setUser(loggedIn);
  }, []);

  const logout = useCallback(async () => {
    await api.post("/auth/logout");
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, loading, login, logout, refresh }), [user, loading, login, logout, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
