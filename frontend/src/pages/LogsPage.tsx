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
        <h1 className="text-xl font-semibold text-slate-100">Audit Logs</h1>
        <p className="text-sm text-slate-500">Critical admin actions and account activity</p>
      </div>

      {error && <p className="rounded-md bg-red-950 px-3 py-2 text-sm text-red-400">{error}</p>}

      <div className="card overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-800 bg-slate-900/60 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-3 font-medium">Time</th>
              <th className="px-4 py-3 font-medium">User</th>
              <th className="px-4 py-3 font-medium">Action</th>
              <th className="px-4 py-3 font-medium">Target</th>
              <th className="px-4 py-3 font-medium">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {(logs ?? []).map((log) => (
              <tr key={log.id}>
                <td className="whitespace-nowrap px-4 py-3 text-slate-500">
                  {new Date(log.createdAt).toLocaleString()}
                </td>
                <td className="px-4 py-3 text-slate-300">{log.user?.username ?? "system"}</td>
                <td className="px-4 py-3 font-medium text-slate-100">{log.action}</td>
                <td className="px-4 py-3 text-slate-500">{log.targetType ?? "-"}</td>
                <td className="max-w-xs truncate px-4 py-3 font-mono text-xs text-slate-500" title={log.details ?? ""}>
                  {log.details ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {logs?.length === 0 && <div className="p-8 text-center text-sm text-slate-500">No audit log entries yet.</div>}
      </div>
    </div>
  );
}
