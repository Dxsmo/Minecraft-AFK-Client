import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";

interface AuditLogEntry {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: string | null;
  createdAt: string;
  user: { username: string } | null;
}

export function LogsPage() {
  const [logs, setLogs] = useState<AuditLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<AuditLogEntry[]>("/audit-logs")
      .then(setLogs)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load logs"));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold" style={{ color: "var(--text)" }}>
          Audit Logs
        </h1>
        <p className="mt-0.5 text-sm" style={{ color: "var(--text-muted)" }}>
          Critical admin actions and account activity
        </p>
      </div>

      {error && <p className="alert-error">{error}</p>}

      <div className="card overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <Th>Time</Th>
              <Th>User</Th>
              <Th>Action</Th>
              <Th>Target</Th>
              <Th>Details</Th>
            </tr>
          </thead>
          <tbody>
            {(logs ?? []).map((log) => (
              <tr key={log.id} style={{ borderTop: "1px solid var(--border)" }}>
                <td className="whitespace-nowrap px-4 py-3" style={{ color: "var(--text-subtle)" }}>
                  {new Date(log.createdAt).toLocaleString()}
                </td>
                <td className="px-4 py-3" style={{ color: "var(--text-muted)" }}>
                  {log.user?.username ?? "system"}
                </td>
                <td className="px-4 py-3 font-medium" style={{ color: "var(--text)" }}>
                  {log.action}
                </td>
                <td className="px-4 py-3" style={{ color: "var(--text-subtle)" }}>
                  {log.targetType ?? "—"}
                </td>
                <td
                  className="max-w-xs truncate px-4 py-3 font-mono text-xs"
                  style={{ color: "var(--text-subtle)" }}
                  title={log.details ?? ""}
                >
                  {log.details ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {logs?.length === 0 && (
          <div className="p-8 text-center text-sm" style={{ color: "var(--text-subtle)" }}>
            No audit log entries yet.
          </div>
        )}
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-3 text-xs font-medium uppercase tracking-wide" style={{ color: "var(--text-subtle)" }}>
      {children}
    </th>
  );
}
