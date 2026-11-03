import { Code, ConnectError } from "@connectrpc/connect";

/** Include the socket/DNS cause that fetch and Connect otherwise hide. Never
 * serialize request headers, credentials, or complete transport objects. */
export function soulFireError(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth = 0) => {
    if (!value || typeof value !== "object" || seen.has(value) || depth > 6) return;
    seen.add(value);
    const detail = value as { message?: unknown; code?: unknown; cause?: unknown; errors?: unknown[] };
    if (typeof detail.message === "string" && !parts.includes(detail.message)) parts.push(detail.message);
    if (typeof detail.code === "string" && !parts.some(part => part.includes(detail.code as string))) parts.push(detail.code);
    visit(detail.cause, depth + 1);
    if (Array.isArray(detail.errors)) for (const child of detail.errors.slice(0, 4)) visit(child, depth + 1);
  };
  visit(error);
  return (parts.join("; ") || "SoulFire-Verbindung fehlgeschlagen").slice(0, 1500);
}

export function retryEventStream(error: unknown): boolean {
  return ![Code.Unauthenticated, Code.PermissionDenied, Code.InvalidArgument, Code.NotFound, Code.FailedPrecondition]
    .includes(ConnectError.from(error).code);
}

/** A game disconnect is authoritative, unlike a broken telemetry connection. */
export class MinecraftDisconnected extends Error {}
