import { useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";
import type { SniperAccount } from "../lib/types";

/**
 * Minimal creation dialog for a Name Sniper account: just a cosmetic label
 * and the Microsoft account email. Unlike CreateAccountDialog, there is no
 * device-code sign-in step here — that only happens later, lazily, the first
 * time the account is enabled from its detail page (see SniperAccountDetailPage).
 */
export function CreateSniperAccountDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [label, setLabel] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const account = await api.post<SniperAccount>("/namesniper/accounts", { label, email });
      onCreated();
      // Caller navigates the newly created account into view.
      return account;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create account");
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: "rgba(0,0,0,0.6)" }}>
      <div className="card w-full max-w-md p-6" style={{ boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}>
        <h2 className="text-base font-semibold" style={{ color: "var(--text)" }}>
          New Name Sniper account
        </h2>
        <p className="mt-0.5 text-xs" style={{ color: "var(--text-subtle)" }}>
          Add a Microsoft account to try renaming. You'll sign in and pick a desired name after creating it.
        </p>

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          <div>
            <label className="label">Label (optional)</label>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="input"
              placeholder="e.g. Sniper 1"
              maxLength={48}
            />
          </div>

          <div>
            <label className="label">Microsoft account email</label>
            <input
              required
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input"
              placeholder="account@example.com"
            />
          </div>

          {error && <p className="alert-error">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="btn btn-ghost">
              Cancel
            </button>
            <button type="submit" disabled={submitting} className="btn btn-primary">
              {submitting ? "Creating…" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
