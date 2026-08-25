import type { ClientStatus } from "../lib/types";

const CONFIG: Record<ClientStatus, { label: string; color: string; bg: string; pulse?: boolean; glow?: boolean }> = {
  ONLINE: { label: "Online", color: "#34d399", bg: "rgba(16,185,129,0.12)", glow: true },
  OFFLINE: { label: "Offline", color: "#8a8a93", bg: "rgba(140,140,150,0.10)" },
  CONNECTING: { label: "Connecting", color: "#fbbf24", bg: "rgba(251,191,36,0.12)", pulse: true },
  RECONNECTING: { label: "Reconnecting", color: "#fbbf24", bg: "rgba(251,191,36,0.12)", pulse: true },
  DISCONNECTING: { label: "Disconnecting", color: "#8a8a93", bg: "rgba(140,140,150,0.10)", pulse: true },
  ERROR: { label: "Error", color: "#f87171", bg: "rgba(248,113,113,0.12)" },
};

export function StatusBadge({ status }: { status: ClientStatus }) {
  const c = CONFIG[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium"
      style={{ color: c.color, backgroundColor: c.bg }}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${c.pulse ? "animate-pulse" : ""} ${c.glow ? "glow-pulse" : ""}`}
        style={{ backgroundColor: c.color }}
      />
      {c.label}
    </span>
  );
}
