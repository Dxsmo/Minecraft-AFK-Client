import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { ApiError } from "../lib/api";

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(username, password);
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
            className="glow-ring flex h-14 w-14 items-center justify-center rounded-xl p-2.5"
            style={{ backgroundColor: "var(--accent-soft)" }}
          >
            <img src="/favicon.png" alt="" className="h-full w-full object-contain" />
          </span>
          <h1 className="mt-3 text-base font-semibold" style={{ color: "var(--text)" }}>
            Minecraft AFK
          </h1>
          <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--accent)" }}>
            Hosted by Desmodus
          </p>
        </div>

        <div className="card p-7">
          <h2 className="text-lg font-semibold" style={{ color: "var(--text)" }}>
            Welcome back
          </h2>
          <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
            Sign in to manage your bots.
          </p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div>
              <label className="label">Username</label>
              <input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} className="input" required />
            </div>
            <div>
              <label className="label">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input"
                required
              />
            </div>

            {error && <p className="alert-error">{error}</p>}

            <button type="submit" disabled={submitting} className="btn btn-primary w-full">
              {submitting ? "Signing in..." : "Sign in"}
            </button>
          </form>
        </div>

        <div className="mt-5 flex items-center justify-center gap-4 text-[11px]" style={{ color: "var(--text-subtle)" }}>
          <FeaturePill label="Live console" />
          <FeaturePill label="Multi-account" />
          <FeaturePill label="Auto-reconnect" />
        </div>
      </div>
    </div>
  );
}

function FeaturePill({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-1 w-1 rounded-full" style={{ backgroundColor: "var(--accent)" }} />
      {label}
    </span>
  );
}
