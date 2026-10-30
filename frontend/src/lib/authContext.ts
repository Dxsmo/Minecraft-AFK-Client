import { createContext } from "react";
import type { CurrentUser } from "./types";
import type { useDashboardPreferences } from "./useDashboardPreferences";

export interface AuthContextValue {
  user: CurrentUser | null;
  loading: boolean;
  dashboardProfile: ReturnType<typeof useDashboardPreferences>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);
