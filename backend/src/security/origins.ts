import { config } from "../config/config.js";

const trustedOrigins = new Set([config.publicOrigin, ...config.corsOrigins].flatMap((value) => {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? [url.origin] : [];
  } catch { return []; }
}));

export function isTrustedOrigin(origin: unknown): boolean {
  return typeof origin === "string" && trustedOrigins.has(origin);
}

export function isWebsiteSocketPath(path: string): boolean {
  return path === "/ws/dashboard" || path === "/ws/namesniper-dashboard" ||
    path.startsWith("/ws/accounts/") || path.startsWith("/ws/namesniper/");
}
