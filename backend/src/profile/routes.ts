import type { FastifyInstance } from "fastify";
import { parseOrReject } from "../utils/validate.js";
import { preferencesPatchSchema, preferencesSchema } from "./schemas.js";
import { getPreferences, importPreferences, updatePreferences } from "./service.js";

export default async function profileRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.requireAuth);
  // Bind queued browser writes to their original user, even if a shared
  // browser signs into another account before the queue finishes.
  app.addHook("preHandler", async (req, reply) => {
    const owner = req.headers["x-profile-owner"];
    if (owner !== undefined && owner !== req.session?.user.id) {
      return reply.code(409).send({ error: "Profile session changed" });
    }
  });
  app.get("/api/profile/dashboard", async req => getPreferences(req.session!));
  app.patch("/api/profile/dashboard", { preHandler: app.requireCsrf }, async (req, reply) => {
    const patch = parseOrReject(preferencesPatchSchema, req.body, reply);
    if (patch) return updatePreferences(req.session!, patch);
  });
  app.post("/api/profile/dashboard/import", { preHandler: app.requireCsrf }, async (req, reply) => {
    const legacy = parseOrReject(preferencesSchema, req.body, reply);
    if (legacy) return importPreferences(req.session!, legacy);
  });
}
