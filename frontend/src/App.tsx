import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./lib/auth";
import { Layout } from "./components/Layout";
import { RequireAuth, RequireAdmin } from "./components/RouteGuards";
const LoginPage = lazy(() => import("./pages/LoginPage").then((module) => ({ default: module.LoginPage })));
const DashboardPage = lazy(() => import("./pages/DashboardPage").then((module) => ({ default: module.DashboardPage })));
const AccountDetailPage = lazy(() => import("./pages/AccountDetailPage").then((module) => ({ default: module.AccountDetailPage })));
const UsersPage = lazy(() => import("./pages/UsersPage").then((module) => ({ default: module.UsersPage })));
const LogsPage = lazy(() => import("./pages/LogsPage").then((module) => ({ default: module.LogsPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then((module) => ({ default: module.SettingsPage })));
const NameSniperPage = lazy(() => import("./pages/NameSniperPage").then((module) => ({ default: module.NameSniperPage })));
const SniperAccountDetailPage = lazy(() => import("./pages/SniperAccountDetailPage").then((module) => ({ default: module.SniperAccountDetailPage })));
const ItemWorthPage = lazy(() => import("./pages/ItemWorthPage").then((module) => ({ default: module.ItemWorthPage })));

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Suspense fallback={<p className="p-6 text-sm">Loading…</p>}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />

            <Route element={<RequireAuth />}>
              <Route element={<Layout />}>
                <Route path="/dashboard" element={<DashboardPage />} />
                <Route path="/accounts/:id" element={<AccountDetailPage />} />
                <Route path="/settings" element={<SettingsPage />} />

                <Route element={<RequireAdmin />}>
                  <Route path="/namesniper" element={<NameSniperPage />} />
                  <Route path="/namesniper/:id" element={<SniperAccountDetailPage />} />
                  <Route path="/item-worth" element={<ItemWorthPage />} />
                  <Route path="/users" element={<UsersPage />} />
                  <Route path="/logs" element={<LogsPage />} />
                </Route>
              </Route>
            </Route>

            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </Suspense>
      </AuthProvider>
    </BrowserRouter>
  );
}
