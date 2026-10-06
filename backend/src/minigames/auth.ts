import { createHash, randomBytes, randomUUID } from "node:crypto";
import { prisma } from "../database/prisma.js";
import { ensure } from "./protocol.js";
export const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export async function createChallenge(name: string) {
  const id = randomUUID(),
    serverId = randomBytes(20).toString("hex");
  await prisma.minigameChallenge.create({
    data: { id, serverId, name, expiresAt: new Date(Date.now() + 60000) },
  });
  return { id, serverId };
}
export async function verifyChallenge(id: string, uuid: string) {
  const challenge = await prisma.minigameChallenge.findUnique({
    where: { id },
  });
  ensure(
    challenge && challenge.expiresAt.getTime() > Date.now(),
    "CHALLENGE_EXPIRED",
  );
  const deleted = await prisma.minigameChallenge.deleteMany({
    where: { id, expiresAt: { gt: new Date() } },
  });
  ensure(deleted.count === 1, "CHALLENGE_EXPIRED");
  const url = new URL(
    "https://sessionserver.mojang.com/session/minecraft/hasJoined",
  );
  url.searchParams.set("username", challenge.name);
  url.searchParams.set("serverId", challenge.serverId);
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  ensure(response.ok, "MINECRAFT_AUTH_FAILED");
  const profile = (await response.json()) as { id?: string; name?: string };
  ensure(
    profile.id === uuid.replaceAll("-", "") &&
      profile.name?.toLowerCase() === challenge.name.toLowerCase(),
    "MINECRAFT_AUTH_FAILED",
  );
  const token = randomBytes(32).toString("base64url"),
    expiresAt = new Date(Date.now() + 12 * 3600000);
  await prisma.minigameSession.create({
    data: { tokenHash: tokenHash(token), playerUuid: uuid, expiresAt },
  });
  return { token, expiresAt: expiresAt.getTime() };
}
export async function authenticate(header: string | undefined) {
  ensure(header && /^Bearer [A-Za-z0-9_-]{43}$/.test(header), "UNAUTHORIZED");
  const session = await prisma.minigameSession.findUnique({
    where: { tokenHash: tokenHash(header.slice(7)) },
  });
  ensure(session && session.expiresAt.getTime() > Date.now(), "UNAUTHORIZED");
  return session;
}
