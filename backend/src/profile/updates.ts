import { prisma } from "../database/prisma.js";

// Change this ID ONLY when the owner explicitly requests a new announcement.
// Routine releases, copy edits and version bumps must not reset the bell.
export const websiteUpdate = {
  id: "2026-10-soulfire-features",
  date: "2026-10-30",
  title: "Neue Möglichkeiten für deine Accounts",
  introduction: "Die wichtigsten Neuerungen auf einen Blick – und wo du sie findest.",
  items: [
    {
      title: "Neue Engine: SoulFire",
      description: "Java und Bedrock laufen jetzt mit SoulFire. Das ermöglicht viele neue Funktionen; durch den Umstieg können auch neue Bugs auftreten. Dein Feedback hilft uns weiter.",
      hint: "",
      image: "command_block",
    },
    {
      title: "Rund 1.500 Minecraft-Icons",
      description: "Gib jedem Account ein passendes Item als Bild – mit rund 1.500 Minecraft-Items, alphabetischem Raster und schneller Suche.",
      hint: "Auf das Plus oder das aktuelle Account-Bild klicken.",
      image: "diamond",
    },
    {
      title: "Live Cam & Remote Control",
      description: "Sieh die Welt aus der Sicht deines Accounts. Ein Klick ins Live-Bild startet die Steuerung mit Maus und Tastatur; Escape beendet sie wieder.",
      hint: "Account öffnen → Live Cam. Lädt erst beim Öffnen.",
      image: "spyglass",
    },
    {
      title: "Maustaste dauerhaft halten",
      description: "Lass wahlweise die linke oder rechte Maustaste automatisch gedrückt halten – auch nach Teleports und erneuten Verbindungen.",
      hint: "Account → Einstellungen → Auto button.",
      image: "lever",
    },
    {
      title: "Kleine Änderungen, besserer Alltag",
      description: "Viele Bugfixes, eine schnellere Konsole und Verbesserungen an Bedienung und Account-Abläufen machen den Alltag angenehmer.",
      hint: "",
      image: "amethyst_shard",
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
