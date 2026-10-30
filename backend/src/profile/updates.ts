import { prisma } from "../database/prisma.js";

// Change this ID ONLY when the owner explicitly requests a new announcement.
// Routine releases, copy edits and version bumps must not reset the bell.
export const websiteUpdate = {
  id: "2026-10-soulfire-features",
  date: "2026-10-30",
  title: "Das ist neu",
  introduction: "Hier die letzten Änderungen – kurz zusammengefasst.",
  items: [
    {
      title: "Neue Engine: SoulFire",
      description: "Java und Bedrock laufen jetzt mit SoulFire. Damit können wir noch einiges Neues einbauen. Beim Umstieg kann’s auch mal haken – sag Bescheid, wenn dir ein Bug auffällt.",
      hint: "",
    },
    {
      title: "Knapp 1.500 Items als Account-Bild",
      description: "Such dir ein Minecraft-Item als Bild für deinen Account aus. Alles ist alphabetisch sortiert und mit der Suche findest du schnell was Passendes.",
      hint: "Einfach aufs Plus oder dein aktuelles Account-Bild klicken.",
    },
    {
      title: "Live Cam & Remote Control",
      description: "Du kannst jetzt sehen, was dein Account sieht, und ihn auch selbst steuern. Einfach ins Live-Bild klicken. Mit Escape bist du wieder raus.",
      hint: "Account öffnen → Live Cam. Lädt erst, wenn du den Tab öffnest.",
    },
    {
      title: "Maustaste dauerhaft halten",
      description: "Links- oder Rechtsklick lassen sich jetzt dauerhaft gedrückt halten. Läuft auch nach Teleports und Reconnects weiter.",
      hint: "Account → Einstellungen → Auto button.",
    },
    {
      title: "Kleine Fixes & Verbesserungen",
      description: "Dazu kommen viele kleinere Bugfixes, eine schnellere Konsole und ein paar Dinge, die die Bedienung angenehmer machen.",
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
