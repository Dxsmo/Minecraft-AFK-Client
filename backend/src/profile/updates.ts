import { prisma } from "../database/prisma.js";

// Change this ID ONLY when the owner explicitly requests a new announcement.
// Routine releases, copy edits and version bumps must not reset the bell.
export const websiteUpdate = {
  id: "2026-11-stability-update",
  date: "2026-11-03",
  title: "Das ist neu",
  introduction: "Hier die letzten Änderungen – kurz zusammengefasst.",
  items: [
    {
      title: "Remote Control",
      description: "Remote Control wurde vorerst wieder entfernt, da die Funktion unter Last bisher nicht stabil und zuverlässig genug lief.",
      hint: "",
    },
    {
      title: "Auto Sell",
      description: "Auto Sell hat viele Performance-Fixes bekommen. Auch wenn sehr viele Items um einen Account herumliegen, sollte der automatische Verkauf jetzt stabil und ohne Stopps oder Geschwindigkeitseinbrüche weiterlaufen.",
      hint: "",
    },
    {
      title: "Performance",
      description: "Es gab viele Performance-Fixes. Außerdem wurden Fehler behoben, durch die Accounts nach einigen Stunden unerwartet die Verbindung verlieren konnten. Diese Probleme sollten jetzt behoben sein.",
      hint: "",
    },
  ],
};

export async function getWebsiteUpdate(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { lastSeenWebsiteUpdate: true } });
  return { announcement: websiteUpdate, unread: user.lastSeenWebsiteUpdate !== websiteUpdate.id };
}

export async function readWebsiteUpdate(userId: string, announcementId: string) {
  // A stale tab must not acknowledge a newer announcement it never displayed.
  if (announcementId !== websiteUpdate.id) {
    throw Object.assign(new Error("Website update changed; please reload"), { statusCode: 409 });
  }
  await prisma.user.update({ where: { id: userId }, data: { lastSeenWebsiteUpdate: announcementId } });
  return { announcement: websiteUpdate, unread: false };
}
