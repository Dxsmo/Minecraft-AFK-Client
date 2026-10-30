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
      title: "Neue Engine",
      description: "Der AFK-Client wurde auf eine neue Engine umgestellt, die viele neue Features ermöglicht. Dadurch können aber auch neue Bugs auftreten – sagt also Bescheid, wenn ihr welche findet.",
      hint: "",
    },
    {
      title: "Account-Icon",
      description: "Ihr könnt jedem Minecraft-Account ein Icon zuweisen, damit eure Account-Liste übersichtlicher wird. Klickt dafür links beim Account aufs Plus oder auf das vorhandene Bild und wählt ein neues Icon aus. Ein eigenes Bild müsst ihr dafür nicht hochladen: Es stehen euch rund 1.500 Minecraft-Blöcke und -Items zur Auswahl.",
      hint: "",
    },
    {
      title: "Live Cam & Remote Control",
      description: "Neu ist auch die Live Cam. Ihr findet sie beim jeweiligen Minecraft-Account im Reiter „Live Cam“ und könnt dort live sehen, was euer Account ingame sieht. Für kleinere Anpassungen könnt ihr ihn auch selbst steuern: Klickt dafür einfach auf das Bild in der Live Cam.",
      hint: "Mit Escape verlasst ihr die Remote Control wieder.",
    },
    {
      title: "Dauer-Button",
      description: "Den neuen Auto button findet ihr in den Einstellungen eures jeweiligen Minecraft-Accounts. Dort könnt ihr aktivieren, dass der Account durchgehend entweder die linke oder die rechte Maustaste gedrückt hält – ohne Pausen.",
      hint: "",
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
