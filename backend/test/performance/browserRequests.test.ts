import { afterEach, expect, it, vi } from "vitest";
import { api, apiFetch, ApiError, clearApiReadCache, invalidateAccountHistory } from "../../../frontend/src/lib/api.js";

afterEach(() => { clearApiReadCache(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json" },
});
const graph = (amount = 42) => ({ end: new Date(Math.floor(Date.now() / 300_000) * 300_000).toISOString(), bucketMs: 300_000, total: amount });
const path = "/minecraft/accounts/a/earnings/history?range=1h";

it("bounds reads and mutations and preserves explicit caller cancellation", async () => {
  vi.stubGlobal("document", { cookie: "" });
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  const fetch = vi.fn().mockResolvedValue(json({}));
  vi.stubGlobal("fetch", fetch);
  await api.post("/auth/logout");
  expect(timeout).toHaveBeenLastCalledWith(3000);
  await api.post("/auth/login", { username: "test", password: "test" });
  expect(timeout).toHaveBeenLastCalledWith(20000);
  const caller = new AbortController();
  await apiFetch("/minecraft/accounts", { signal: caller.signal });
  const signal = fetch.mock.calls.at(-1)![1].signal;
  caller.abort();
  expect(signal.aborted).toBe(true);
  expect(deadline.signal.aborted).toBe(false);
});

it("shares pending GETs and allows one subscriber to cancel without cancelling other readers", async () => {
  let finish!: (value: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  const first = api.get(path, { signal: controller.signal });
  const second = api.get(path);
  expect(fetch).toHaveBeenCalledTimes(1);
  controller.abort();
  await expect(first).rejects.toMatchObject({ name: "AbortError" });
  finish(json(graph()));
  await expect(second).resolves.toMatchObject({ total: 42 });
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(false);
});

it("caches completed graph intervals until the boundary and isolates ranges/accounts", async () => {
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(json(graph())));
  vi.stubGlobal("fetch", fetch);
  await api.get(path);
  await api.get(path);
  expect(fetch).toHaveBeenCalledTimes(1);
  await api.get(path.replace("1h", "24h"));
  await api.get(path.replace("/a/", "/b/"));
  expect(fetch).toHaveBeenCalledTimes(3);
  vi.spyOn(Date, "now").mockReturnValue(Math.floor(now / 300_000) * 300_000 + 300_000);
  await api.get(path);
  expect(fetch).toHaveBeenCalledTimes(4);
});

it("never caches failures or normal GET responses", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(json({ error: "Busy" }, 503))
    .mockImplementation(() => Promise.resolve(json(graph())));
  vi.stubGlobal("fetch", fetch);
  await expect(api.get(path)).rejects.toBeInstanceOf(ApiError);
  await api.get(path);
  await api.get("/minecraft/accounts");
  await api.get("/minecraft/accounts");
  expect(fetch).toHaveBeenCalledTimes(4);
});

it("clears cached data across mutations, authentication failures and confirmed sales", async () => {
  vi.stubGlobal("document", { cookie: "afk_csrf=test-token" });
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(json(graph())));
  vi.stubGlobal("fetch", fetch);
  await api.get(path);
  invalidateAccountHistory("a");
  await api.get(path);
  await api.post("/auth/logout");
  await api.get(path);
  fetch.mockResolvedValueOnce(json({ error: "Unauthorized" }, 401));
  await expect(api.get("/auth/me")).rejects.toMatchObject({ status: 401 });
  await api.get(path);
  expect(fetch).toHaveBeenCalledTimes(6);
});

it("does not repopulate a cache with a read started before logout or a mutation", async () => {
  vi.stubGlobal("document", { cookie: "" });
  let finish!: (value: Response) => void;
  const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }))
    .mockImplementation(() => Promise.resolve(json(graph())));
  vi.stubGlobal("fetch", fetch);
  const old = api.get(path);
  await api.post("/auth/logout");
  finish(json(graph(1)));
  await old;
  await expect(api.get(path)).resolves.toMatchObject({ total: 42 });
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("announces expired sessions, but not an incorrect password or a stale response after a new login", async () => {
  const events = new EventTarget(), expired = vi.fn(); events.addEventListener("afk-session-expired", expired);
  vi.stubGlobal("window", events); const document = { cookie: "afk_csrf=old-session" }; vi.stubGlobal("document", document);
  const fetch = vi.fn().mockResolvedValueOnce(json({ error: "Current password is incorrect" }, 401))
    .mockResolvedValueOnce(json({ error: "Unauthorized" }, 401));
  vi.stubGlobal("fetch", fetch);
  await expect(api.post("/auth/change-password", {})).rejects.toBeInstanceOf(ApiError); expect(expired).not.toHaveBeenCalled();
  await expect(api.get("/auth/me")).rejects.toBeInstanceOf(ApiError); expect(expired).toHaveBeenCalledTimes(1);
  let finish!: (value: Response) => void; fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const previous = api.get("/old-session-request"); document.cookie = "afk_csrf=new-session";
  finish(json({ error: "Unauthorized" }, 401)); await expect(previous).rejects.toBeInstanceOf(ApiError);
  expect(expired).toHaveBeenCalledTimes(1);
});
