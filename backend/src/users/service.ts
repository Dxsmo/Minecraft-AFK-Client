import { prisma } from "../database/prisma.js";
import { hashPassword } from "../auth/password.js";
import { destroyAllUserSessions } from "../auth/session.js";
import type { CreateUserInput, UpdateUserInput } from "./schemas.js";

const publicUserSelect = {
  id: true,
  username: true,
  role: true,
  status: true,
  createdAt: true,
  lastLoginAt: true,
} as const;

export async function listUsers() {
  return prisma.user.findMany({ select: publicUserSelect, orderBy: { createdAt: "asc" } });
}

export async function getUserById(id: string) {
  return prisma.user.findUnique({ where: { id }, select: publicUserSelect });
}

export async function createUser(input: CreateUserInput) {
  const passwordHash = await hashPassword(input.password);
  return prisma.user.create({
    data: { username: input.username, passwordHash, role: input.role },
    select: publicUserSelect,
  });
}

export async function updateUser(id: string, input: UpdateUserInput) {
  const data: Record<string, unknown> = {};
  if (input.password) data.passwordHash = await hashPassword(input.password);
  if (input.role) data.role = input.role;
  if (input.status) data.status = input.status;

  const user = await prisma.user.update({ where: { id }, data, select: publicUserSelect });

  // Force re-login if the account was disabled, role changed, or password reset.
  if (input.status === "DISABLED" || input.role || input.password) {
    await destroyAllUserSessions(id);
  }
  return user;
}

export async function deleteUser(id: string) {
  await destroyAllUserSessions(id);
  await prisma.user.delete({ where: { id } });
}

export async function countAdmins(): Promise<number> {
  return prisma.user.count({ where: { role: "ADMIN", status: "ACTIVE" } });
}
