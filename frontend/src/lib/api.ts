const API_BASE = "/api";
const pendingReads = new Map<string, Promise<unknown>>();
const historyCache = new Map<string, { expiresAt: number; value: unknown }>();
let readGeneration = 0;

export function clearApiReadCache() {
  readGeneration++;
  pendingReads.clear();
  historyCache.clear();
}

export function invalidateAccountHistory(accountId: string) {
  readGeneration++;
  const prefix = `/minecraft/accounts/${accountId}/earnings/history`;
  for (const key of historyCache.keys()) if (key.startsWith(prefix)) historyCache.delete(key);
  for (const key of pendingReads.keys()) if (key.startsWith(prefix)) pendingReads.delete(key);
}

function getCookie(name: string): string | undefined {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

export class ApiError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/**
 * Thin fetch wrapper: always sends cookies, always echoes the CSRF cookie
 * back as a header for mutating requests (see backend/src/auth/plugin.ts),
 * and normalizes error responses into ApiError.
 */
export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers = new Headers(options.headers);
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(method);
  const sessionAtRequest = typeof document === "undefined" ? undefined : getCookie("afk_csrf");

  if (mutating) {
    clearApiReadCache();
    const csrfToken = getCookie("afk_csrf");
    if (csrfToken) headers.set("x-csrf-token", csrfToken);
  }
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  // Bound mutations too: an unavailable logout/login must not leave the UI
  // waiting for the browser's much longer network timeout. Keep caller aborts.
  const deadline = AbortSignal.timeout(path === "/auth/logout" ? 3_000 : 20_000);
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    credentials: "include",
    signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
  });

  if (mutating || response.status === 401) clearApiReadCache();

  if (response.status === 204) return undefined as T;

  const isJson = response.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await response.json().catch(() => undefined) : undefined;

  if (!response.ok) {
    // A stale request from a previous login must not sign out the new user.
    // An incorrect current password is also a 401, but is not session expiry.
    if (response.status === 401 && body?.error === "Unauthorized" && typeof window !== "undefined"
        && sessionAtRequest === getCookie("afk_csrf")) window.dispatchEvent(new Event("afk-session-expired"));
    throw new ApiError(response.status, body?.error ?? response.statusText, body?.details);
  }
  return body as T;
}

function get<T>(path: string, options: { signal?: AbortSignal } = {}): Promise<T> {
  const signal = options.signal;
  if (signal?.aborted) return Promise.reject(signal.reason);
  const cached = historyCache.get(path);
  let request: Promise<T>;
  if (cached && cached.expiresAt > Date.now()) {
    request = Promise.resolve(cached.value as T);
  } else {
    historyCache.delete(path);
    request = pendingReads.get(path) as Promise<T>;
    if (!request) {
      const generation = readGeneration;
      request = apiFetch<T>(path).then(value => {
        if (generation === readGeneration && /^\/minecraft\/accounts\/[^/]+\/earnings\/history(?:\?|$)/.test(path)) {
          const history = value as { end?: string; bucketMs?: number };
          const expiresAt = Date.parse(history?.end ?? "") + (history?.bucketMs ?? 0);
          if (expiresAt > Date.now()) {
            if (historyCache.size >= 256) historyCache.delete(historyCache.keys().next().value!);
            historyCache.set(path, { expiresAt, value });
          }
        }
        return value;
      }).finally(() => { if (pendingReads.get(path) === request) pendingReads.delete(path); });
      pendingReads.set(path, request);
    }
  }
  if (!signal) return request;
  // Subscribers cancel independently; one closed graph must not abort another reader.
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    request.then(value => { if (!signal.aborted) resolve(value); }, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

export const api = {
  get,
  post: <T>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => apiFetch<T>(path, { method: "DELETE" }),
};
