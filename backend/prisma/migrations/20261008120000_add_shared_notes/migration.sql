CREATE TABLE "Note" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "title" TEXT NOT NULL DEFAULT 'Neue Notiz',
  "content" TEXT NOT NULL DEFAULT '{"type":"doc","content":[{"type":"paragraph"}]}',
  "revision" INTEGER NOT NULL DEFAULT 0,
  "ownerId" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "Note_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "NoteGrant" (
  "noteId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "canWrite" BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY ("noteId", "userId"),
  CONSTRAINT "NoteGrant_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "Note" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "NoteGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Note_ownerId_updatedAt_idx" ON "Note"("ownerId", "updatedAt");
CREATE INDEX "NoteGrant_userId_idx" ON "NoteGrant"("userId");
