import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { ApiError } from "../lib/api";
import { rememberedUsername, rememberUsername, restoreBrowserPassword, storeBrowserPassword } from "../lib/rememberLogin";

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [savedUsername] = useState(rememberedUsername);
  const [username, setUsername] = useState(savedUsername ?? "");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(savedUsername !== null);
  const edited = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!remember || !savedUsername) return;
    const controller = new AbortController();
    void restoreBrowserPassword(savedUsername, controller.signal).then((stored) => {
      if (stored !== null && !controller.signal.aborted && !edited.current) setPassword(stored);
    });
    return () => controller.abort();
  }, [remember, savedUsername]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    // Read the form itself: password managers may fill fields without a React
    // change event, and the visible credentials must still be submitted.
    const values = new FormData(e.currentTarget);
    const enteredUsername = String(values.get("username") ?? "").trim();
    const enteredPassword = String(values.get("password") ?? "");
    setError(null);
    setSubmitting(true);
    try {
      await login(enteredUsername, enteredPassword);
      rememberUsername(remember ? enteredUsername : null);
      if (remember) void storeBrowserPassword(enteredUsername, enteredPassword);
      navigate("/dashboard", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Login failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="app-aurora relative flex min-h-screen items-center justify-center px-4">
      <div className="relative w-full max-w-sm animate-fadein">
        <div className="mb-7 flex flex-col items-center text-center">
          <span
            className="brand-mark glow-ring flex h-14 w-14 items-center justify-center rounded-xl p-2.5"
          >
            <img src="/desmodus-head.svg" alt="" className="h-full w-full object-contain" />
          </span>
          <h1 className="mt-3 text-base font-semibold" style={{ color: "var(--text)" }}>
            Minecraft AFK
          </h1>
          <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--accent)" }}>
            Hosted by Desmo
          </p>
        </div>

        <div className="card p-7">
          <h2 className="text-lg font-semibold" style={{ color: "var(--text)" }}>
            Welcome back
          </h2>
          <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
            Sign in to manage your bots.
          </p>

          <form onSubmit={handleSubmit} autoComplete={remember ? "on" : "off"} className="mt-6 space-y-4">
            <div>
              <label htmlFor="login-username" className="label">Username</label>
              <input id="login-username" name="username" autoComplete={remember ? "username" : "off"} autoCapitalize="none" spellCheck={false}
                autoFocus value={username} onChange={(e) => { edited.current = true; setUsername(e.target.value); }} className="input" required maxLength={64} />
            </div>
            <div>
              <label htmlFor="login-password" className="label">Password</label>
              <input
                id="login-password" name="password" autoComplete={remember ? "current-password" : "off"}
                type="password"
                value={password}
                onChange={(e) => { edited.current = true; setPassword(e.target.value); }}
                className="input"
                required
              />
            </div>

            <label className="flex cursor-pointer items-center gap-2 text-xs" style={{ color: "var(--text-muted)" }}>
              <input type="checkbox" checked={remember} className="accent-[var(--accent)]" disabled={submitting} onChange={(e) => {
                setRemember(e.target.checked);
                if (!e.target.checked) { rememberUsername(null); edited.current = true; }
              }} />
              Anmeldedaten speichern
            </label>
            {remember && <p className="text-[11px]" style={{ color: "var(--text-subtle)" }}>Passwort über deinen Browser-Passwortmanager speichern.</p>}

            {error && <p className="alert-error">{error}</p>}

            <button type="submit" disabled={submitting} className="btn btn-primary w-full">
              {submitting ? "Signing in..." : "Sign in"}
            </button>
          </form>
        </div>

      </div>
    </div>
  );
}
