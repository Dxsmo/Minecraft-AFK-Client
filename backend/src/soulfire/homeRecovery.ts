import path from "node:path";
import { access, readFile } from "node:fs/promises";
import { writePrivateJson } from "./auth.js";

export const validHome = (home: string): boolean => /^[\p{L}\p{N}_.-]{1,64}$/u.test(home);
export type HomeOwner = { host: string; port: number; edition: string; botId: string };
export async function rememberedHome(directory: string, owner: HomeOwner): Promise<string> {
  try {
    const saved = JSON.parse(await readFile(path.join(directory, "confirmed-home.json"), "utf8"));
    return saved.host === owner.host && saved.port === owner.port && saved.edition === owner.edition
      && saved.botId === owner.botId && typeof saved.home === "string" && validHome(saved.home) ? saved.home : "";
  } catch { return ""; }
}
export const rememberHome = (directory: string, owner: HomeOwner, home: string): Promise<void> =>
  writePrivateJson(path.join(directory, "confirmed-home.json"), { ...owner, home: validHome(home) ? home : "" });

/** One-time upgrade: accept a manually requested destination only after its
 * server confirmation and a known matching connection endpoint. */
export function homeFromHistory(rows: { type: string; message: string; createdAt: Date }[], host: string, port: number): string {
  const address = `${host.includes(":") ? `[${host}]` : host}:${port}`;
  let endpoint = "", home = "", pending: { home: string; at: number } | undefined;
  for (const row of rows) {
    const connection = row.type === "SYSTEM" && row.message.match(/^Starte Minecraft-Verbindung zu (.+)…$/);
    if (connection) {
      endpoint = connection[1]; pending = undefined;
      if (endpoint !== address) home = "";
    }
    if (endpoint !== address) continue;
    if (row.type === "USER_COMMAND") {
      const requested = row.message.match(/^\/home\s+(\S+)\s*$/i)?.[1];
      if (requested && validHome(requested)) pending = { home: requested, at: row.createdAt.getTime() };
      else if (/^\/(?:home|spawn|hub|lobby|warp|server|tpaccept|tpyes)(?:\s|$)/i.test(row.message)) { home = ""; pending = undefined; }
    }
    if (row.type === "SERVER_MESSAGE" && pending && row.createdAt.getTime() - pending.at <= 120_000
        && row.message.replace(/§./g, "").trim() === `[HugoSMP] Du wurdest zu deinem Home ${pending.home} teleportiert!`) {
      home = pending.home; pending = undefined;
    }
  }
  return home;
}

export async function hasHomeRecord(directory: string): Promise<boolean> {
  try { await access(path.join(directory, "confirmed-home.json")); return true; } catch { return false; }
}
