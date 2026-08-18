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
    <div className="app-aurora flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <span
            className="flex h-9 w-9 items-center justify-center rounded-lg text-base font-bold"
            style={{ backgroundColor: "var(--accent-soft)", color: "var(--accent)" }}
          >
            ◆
          </span>
          <div className="leading-tight">
            <h1 className="text-sm font-semibold" style={{ color: "var(--text)" }}>
              Minecraft AFK
            </h1>
            <p className="text-[11px] font-semibold" style={{ color: "var(--accent)" }}>
              Hosted by Desmodus
            </p>
          </div>
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
      </div>
    </div>
  );
}
