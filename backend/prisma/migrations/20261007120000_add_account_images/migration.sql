CREATE TABLE "AccountImage" (
    "minecraftAccountId" TEXT NOT NULL PRIMARY KEY,
    "data" BLOB NOT NULL,
    "revision" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AccountImage_minecraftAccountId_fkey" FOREIGN KEY ("minecraftAccountId") REFERENCES "MinecraftAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
