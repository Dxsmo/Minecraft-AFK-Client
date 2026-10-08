import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildApp } from "../../src/app.js";
import { prisma } from "../../src/database/prisma.js";
import { createSession } from "../../src/auth/session.js";
import { config } from "../../src/config/config.js";

let app: Awaited<ReturnType<typeof buildApp>>;
const users: string[] = [];
const headers: { cookie: string; "x-csrf-token": string }[] = [];
const content = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text, marks: [{ type: "bold" }] }] }] });
const create = async () => {
  const response = await app.inject({ method: "POST", url: "/api/notes", headers: headers[0], payload: { title: "Private Gedanken", content: content("Hallo") } });
  expect(response.statusCode).toBe(201);
  return response.json();
};
const share = (id: string, users: { userId: string; canWrite: boolean }[], session = 0) =>
  app.inject({ method: "PUT", url: `/api/notes/${id}/access`, headers: headers[session], payload: { users } });
const patch = (id: string, revision: number, text: string, session = 0) =>
  app.inject({ method: "PATCH", url: `/api/notes/${id}`, headers: headers[session], payload: { revision, content: content(text) } });

beforeAll(async () => {
  for (const role of ["USER", "USER", "USER", "ADMIN"] as const) {
    const user = await prisma.user.create({ data: { username: `note-${randomUUID().slice(0, 8)}`, passwordHash: "test", role } });
    users.push(user.id);
    const session = await createSession(user.id, {});
    headers.push({ cookie: `${config.session.cookieName}=${session.sessionId}`, "x-csrf-token": session.csrfToken });
  }
  app = await buildApp();
});
beforeEach(async () => { await prisma.note.deleteMany({ where: { ownerId: { in: users } } }); });
afterAll(async () => { await app?.close(); await prisma.user.deleteMany({ where: { id: { in: users } } }); });

it("lets normal users create private notes and exposes no unshared notes, even to admins", async () => {
  const note = await create();
  expect(note).toMatchObject({ ownerId: users[0], isOwner: true, canWrite: true, shared: false, revision: 0, grants: [] });
  for (let index = 1; index < headers.length; index++) {
    expect((await app.inject({ url: `/api/notes/${note.id}`, headers: headers[index] })).statusCode).toBe(404);
    const list = await app.inject({ url: "/api/notes", headers: headers[index] });
    expect(list.json().some((entry: { id: string }) => entry.id === note.id)).toBe(false);
    expect((await patch(note.id, 0, "Unbefugt", index)).statusCode).toBe(404);
  }
  const list = await app.inject({ url: "/api/notes", headers: headers[0] });
  expect(list.json()[0]).not.toHaveProperty("content");
  expect(list.headers["cache-control"]).toBe("private, no-store");
});

it("shares read and write permissions separately, hides grant details and persists formatted text", async () => {
  const note = await create();
  expect((await share(note.id, [{ userId: users[1], canWrite: true }, { userId: users[2], canWrite: false }])).statusCode).toBe(200);
  expect((await patch(note.id, 0, "Gemeinsam fett", 1)).statusCode).toBe(200);
  expect((await patch(note.id, 1, "Nicht erlaubt", 2)).statusCode).toBe(403);
  for (const index of [1, 2]) {
    const read = await app.inject({ url: `/api/notes/${note.id}`, headers: headers[index] });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ content: content("Gemeinsam fett"), canWrite: index === 1, isOwner: false, grants: [] });
  }
  const stored = await prisma.note.findUniqueOrThrow({ where: { id: note.id } });
  expect(JSON.parse(stored.content)).toEqual(content("Gemeinsam fett"));
});

it("allows only the owner to change access or delete a note", async () => {
  const note = await create();
  await share(note.id, [{ userId: users[1], canWrite: true }, { userId: users[3], canWrite: true }]);
  for (const index of [1, 3]) {
    expect((await share(note.id, [], index)).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/api/notes/${note.id}`, headers: headers[index] })).statusCode).toBe(404);
  }
  expect(await prisma.noteGrant.count({ where: { noteId: note.id } })).toBe(2);
});

it("rejects stale or simultaneous writes instead of silently overwriting another user's changes", async () => {
  const note = await create();
  await share(note.id, [{ userId: users[1], canWrite: true }]);
  const results = await Promise.all([patch(note.id, 0, "Version A"), patch(note.id, 0, "Version B", 1)]);
  expect(results.map((response) => response.statusCode).sort()).toEqual([200, 409]);
  const stored = await prisma.note.findUniqueOrThrow({ where: { id: note.id } });
  expect(stored.revision).toBe(1);
  expect(JSON.parse(stored.content)).toEqual(content(results[0].statusCode === 200 ? "Version A" : "Version B"));
  expect((await patch(note.id, 0, "Alte Version")).statusCode).toBe(409);
});

it("honors revoked and downgraded access immediately", async () => {
  const note = await create();
  await share(note.id, [{ userId: users[1], canWrite: true }, { userId: users[2], canWrite: false }]);
  await share(note.id, [{ userId: users[1], canWrite: false }]);
  expect((await app.inject({ url: `/api/notes/${note.id}`, headers: headers[1] })).statusCode).toBe(200);
  expect((await patch(note.id, 0, "Schreiben nach Downgrade", 1)).statusCode).toBe(403);
  expect((await app.inject({ url: `/api/notes/${note.id}`, headers: headers[2] })).statusCode).toBe(404);
  expect((await patch(note.id, 0, "Schreiben nach Entzug", 2)).statusCode).toBe(404);
  expect((await app.inject({ url: "/api/notes", headers: headers[2] })).json()).toEqual([]);
});

it("validates grants atomically and only lists safe user fields", async () => {
  const note = await create();
  await share(note.id, [{ userId: users[1], canWrite: false }]);
  for (const selection of [
    [{ userId: "missing-user", canWrite: true }], [{ userId: users[0], canWrite: false }],
    [{ userId: users[1], canWrite: false }, { userId: users[1], canWrite: true }],
  ]) {
    expect((await share(note.id, selection)).statusCode).toBe(400);
    expect((await prisma.noteGrant.findMany({ where: { noteId: note.id } })).map((grant) => grant.userId)).toEqual([users[1]]);
  }
  const response = await app.inject({ url: "/api/notes/users", headers: headers[0] });
  expect(response.statusCode).toBe(200);
  for (const user of response.json()) expect(Object.keys(user).sort()).toEqual(["id", "username"]);
});

it("accepts long notes beyond the default HTTP body limit without a word or character cap", async () => {
  const note = await create();
  const text = "Notizen ohne Wörterlimit. ".repeat(60_000);
  expect(Buffer.byteLength(text)).toBeGreaterThan(1024 * 1024);
  expect((await patch(note.id, 0, text)).statusCode).toBe(200);
  const read = await app.inject({ url: `/api/notes/${note.id}`, headers: headers[0] });
  expect(read.json().content.content[0].content[0].text).toBe(text);
});

it("rejects raw HTML, unsafe URLs, unsupported attributes and invalid rich-text structure", async () => {
  const note = await create();
  const cases = [
    { type: "doc", content: [{ type: "script", text: "alert(1)" }] },
    { type: "doc", content: [{ type: "paragraph", attrs: { onclick: "alert(1)" } }] },
    { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "unsafe", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] }] },
    { type: "doc", content: [{ type: "text", text: "Missing paragraph" }] },
  ];
  for (const invalid of cases) {
    const response = await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, headers: headers[0], payload: { revision: 0, content: invalid } });
    expect(response.statusCode).toBe(400);
  }
  expect((await prisma.note.findUniqueOrThrow({ where: { id: note.id } })).revision).toBe(0);
});

it("persists editor link attributes and makes external links safe to open", async () => {
  const note = await create();
  const document = { type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Plan", marks: [
    { type: "bold" }, { type: "link", attrs: { href: "https://example.com/plan", target: "_blank", rel: "opener", class: null, title: null } },
  ] }] }, { type: "paragraph" }] };
  const response = await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, headers: headers[0], payload: { revision: 0, content: document } });
  expect(response.statusCode).toBe(200);
  const read = await app.inject({ url: `/api/notes/${note.id}`, headers: headers[0] });
  expect(read.json().content.content[0].content[0].marks).toEqual([
    { type: "bold" }, { type: "link", attrs: { href: "https://example.com/plan", target: "_blank", rel: "noopener noreferrer", class: null, title: null } },
  ]);
});

it("persists left and centered paragraphs and headings for shared readers", async () => {
  const note = await create();
  await share(note.id, [{ userId: users[2], canWrite: false }]);
  const document = { type: "doc", content: [
    { type: "heading", attrs: { level: 2, textAlign: "center" }, content: [{ type: "text", text: "Zentrierte Überschrift" }] },
    { type: "paragraph", attrs: { textAlign: "center" }, content: [{ type: "text", text: "Mitte", marks: [{ type: "bold" }] }] },
    { type: "paragraph", attrs: { textAlign: "left" }, content: [{ type: "text", text: "Links" }] },
  ] };
  const response = await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, headers: headers[0], payload: { revision: 0, content: document } });
  expect(response.statusCode).toBe(200);
  const read = await app.inject({ url: `/api/notes/${note.id}`, headers: headers[2] });
  expect(read.json().content).toEqual(document);
  expect(read.json().canWrite).toBe(false);
});

it("accepts default alignment but rejects unsupported alignment values and style attributes", async () => {
  const note = await create();
  const payload = (attrs: Record<string, unknown>) => ({ revision: 0, content: { type: "doc", content: [{ type: "paragraph", attrs }] } });
  for (const attrs of [{ textAlign: "right" }, { textAlign: 123 }, { textAlign: "center", style: "position:fixed" }, { textAlign: "center; color:red" }]) {
    const response = await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, headers: headers[0], payload: payload(attrs) });
    expect(response.statusCode).toBe(400);
  }
  const response = await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, headers: headers[0], payload: payload({ textAlign: null }) });
  expect(response.statusCode).toBe(200);
});

it("enforces authentication and CSRF on all note mutations", async () => {
  const note = await create();
  for (const url of ["/api/notes", "/api/notes/users", `/api/notes/${note.id}`]) expect((await app.inject({ url })).statusCode).toBe(401);
  for (const [method, url, payload] of [
    ["POST", "/api/notes", {}], ["PATCH", `/api/notes/${note.id}`, { revision: 0, title: "Changed" }],
    ["PUT", `/api/notes/${note.id}/access`, { users: [] }], ["DELETE", `/api/notes/${note.id}`, undefined],
  ] as const) {
    expect((await app.inject({ method, url, payload })).statusCode).toBe(401);
    expect((await app.inject({ method, url, payload, headers: { cookie: headers[0].cookie } })).statusCode).toBe(403);
  }
});

it("cleans up grants with a deleted note", async () => {
  const note = await create();
  await share(note.id, [{ userId: users[1], canWrite: true }]);
  expect((await app.inject({ method: "DELETE", url: `/api/notes/${note.id}`, headers: headers[0] })).statusCode).toBe(204);
  expect(await prisma.noteGrant.count({ where: { noteId: note.id } })).toBe(0);
  expect((await app.inject({ url: `/api/notes/${note.id}`, headers: headers[1] })).statusCode).toBe(404);
});
