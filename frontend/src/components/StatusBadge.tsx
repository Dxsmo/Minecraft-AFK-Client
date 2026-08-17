import type { ClientStatus } from "../lib/types";

const STYLES: Record<ClientStatus, string> = {
  ONLINE: "bg-emerald-900/40 text-emerald-300",
  OFFLINE: "bg-slate-800 text-slate-400",
  CONNECTING: "bg-amber-900/40 text-amber-300",
  RECONNECTING: "bg-amber-900/40 text-amber-300",
  DISCONNECTING: "bg-slate-800 text-slate-400",
  ERROR: "bg-red-900/40 text-red-300",
};

const DOT_STYLES: Record<ClientStatus, string> = {
  ONLINE: "bg-emerald-500",
  OFFLINE: "bg-slate-400",
  CONNECTING: "bg-amber-500 animate-pulse",
  RECONNECTING: "bg-amber-500 animate-pulse",
  DISCONNECTING: "bg-slate-400",
  ERROR: "bg-red-500",
};

export function StatusBadge({ status }: { status: ClientStatus }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${STYLES[status]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${DOT_STYLES[status]}`} />
      {status}
    </span>
  );
}
