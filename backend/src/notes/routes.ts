import type { FastifyInstance } from "fastify";
import { prisma } from "../database/prisma.js";
import { parseOrReject } from "../utils/validate.js";
import { recordAuditLog } from "../logging/auditLog.js";
import { createNoteSchema, updateNoteSchema, noteAccessSchema } from "./schemas.js";

const ownerSelect = { id: true, username: true } as const;
const summarySelect = { id: true, title: true, ownerId: true, owner: { select: ownerSelect }, revision: true, createdAt: true, updatedAt: true,
  grants: { select: { userId: true, canWrite: true, user: { select: ownerSelect } } } } as const;
const visibleTo = (userId: string) => ({ OR: [{ ownerId: userId }, { grants: { some: { userId } } }] });
const writableBy = (userId: string) => ({ OR: [{ ownerId: userId }, { grants: { some: { userId, canWrite: true } } }] });
function present<T extends { ownerId: string; grants: { userId: string; canWrite: boolean }[] }>(note: T, userId: string) {
  const { grants, ...rest } = note;
  const isOwner = note.ownerId === userId;
  return { ...rest, canWrite: isOwner || grants.some((grant) => grant.userId === userId && grant.canWrite), isOwner,
    shared: grants.length > 0, grants: isOwner ? grants : [] };
}

export default async function notesRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.requireAuth);
  app.addHook("onSend", async (_req, reply) => { reply.header("Cache-Control", "private, no-store"); });

  app.get("/api/notes", async (req) => {
    const notes = await prisma.note.findMany({ where: visibleTo(req.session!.user.id), select: summarySelect, orderBy: { updatedAt: "desc" } });
    return notes.map((note) => present(note, req.session!.user.id));
  });

  app.get("/api/notes/users", async () => prisma.user.findMany({ where: { status: "ACTIVE" }, select: ownerSelect, orderBy: { username: "asc" } }));

  app.get("/api/notes/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const note = await prisma.note.findFirst({ where: { id, ...visibleTo(req.session!.user.id) }, select: { ...summarySelect, content: true } });
    if (!note) return reply.code(404).send({ error: "Notiz nicht gefunden" });
    return { ...present(note, req.session!.user.id), content: JSON.parse(note.content) };
  });

  // The transport has a byte bound; text itself has no word/character limit.
  app.post("/api/notes", { preHandler: app.requireCsrf, bodyLimit: 64 * 1024 * 1024 }, async (req, reply) => {
    const body = parseOrReject(createNoteSchema, req.body, reply);
    if (!body) return;
    const note = await prisma.note.create({ data: { ownerId: req.session!.user.id, title: body.title,
      ...(body.content ? { content: JSON.stringify(body.content) } : {}) }, select: { ...summarySelect, content: true } });
    await recordAuditLog({ userId: req.session!.user.id, action: "NOTE_CREATE", targetType: "Note", targetId: note.id });
    return reply.code(201).send({ ...present(note, req.session!.user.id), content: JSON.parse(note.content) });
  });

  app.patch("/api/notes/:id", { preHandler: app.requireCsrf, bodyLimit: 64 * 1024 * 1024 }, async (req, reply) => {
    const { id } = req.params as { id: string }, userId = req.session!.user.id;
    const body = parseOrReject(updateNoteSchema, req.body, reply);
    if (!body) return;
    const result = await prisma.$transaction(async (tx) => {
      const changed = await tx.note.updateMany({ where: { id, revision: body.revision, ...writableBy(userId) },
        data: { title: body.title, ...(body.content ? { content: JSON.stringify(body.content) } : {}), revision: { increment: 1 } } });
      const note = await tx.note.findFirst({ where: { id, ...visibleTo(userId) }, select: summarySelect });
      return { changed: changed.count === 1, note };
    });
    if (!result.note) return reply.code(404).send({ error: "Notiz nicht gefunden" });
    const note = present(result.note, userId);
    if (!note.canWrite) return reply.code(403).send({ error: "Du hast nur Leserechte für diese Notiz" });
    if (!result.changed) return reply.code(409).send({ error: "Diese Notiz wurde inzwischen geändert. Deine Änderungen wurden nicht überschrieben." });
    return reply.send(note);
  });

  app.put("/api/notes/:id/access", { preHandler: app.requireCsrf }, async (req, reply) => {
    const { id } = req.params as { id: string }, userId = req.session!.user.id;
    const body = parseOrReject(noteAccessSchema, req.body, reply);
    if (!body) return;
    const result = await prisma.$transaction(async (tx) => {
      if (!(await tx.note.findFirst({ where: { id, ownerId: userId }, select: { id: true } }))) return "missing" as const;
      const ids = body.users.map((grant) => grant.userId);
      if (ids.includes(userId) || new Set(ids).size !== ids.length ||
          (await tx.user.count({ where: { id: { in: ids }, status: "ACTIVE" } })) !== ids.length) return "invalid" as const;
      await tx.noteGrant.deleteMany({ where: { noteId: id } });
      if (body.users.length) await tx.noteGrant.createMany({ data: body.users.map((grant) => ({ noteId: id, ...grant })) });
      return tx.noteGrant.findMany({ where: { noteId: id }, select: { userId: true, canWrite: true, user: { select: ownerSelect } } });
    });
    if (result === "missing") return reply.code(404).send({ error: "Nur der Ersteller kann Zugriffsrechte ändern" });
    if (result === "invalid") return reply.code(400).send({ error: "Ungültige Nutzerauswahl" });
    await recordAuditLog({ userId, action: "NOTE_ACCESS_UPDATE", targetType: "Note", targetId: id, details: { users: body.users } });
    return reply.send(result);
  });

  app.delete("/api/notes/:id", { preHandler: app.requireCsrf }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await prisma.note.deleteMany({ where: { id, ownerId: req.session!.user.id } });
    if (!result.count) return reply.code(404).send({ error: "Nur der Ersteller kann diese Notiz löschen" });
    await recordAuditLog({ userId: req.session!.user.id, action: "NOTE_DELETE", targetType: "Note", targetId: id });
    return reply.code(204).send();
  });
}
