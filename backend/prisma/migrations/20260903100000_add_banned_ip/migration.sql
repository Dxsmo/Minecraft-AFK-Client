-- CreateTable
CREATE TABLE "BannedIp" (
    "ip" TEXT NOT NULL PRIMARY KEY,
    "reason" TEXT,
    "auto" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    CONSTRAINT "BannedIp_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "BannedIp_createdAt_idx" ON "BannedIp"("createdAt");
