-- AlterTable
ALTER TABLE "Book" ADD COLUMN     "ownerId" TEXT;

-- AlterTable
ALTER TABLE "SiteState" ALTER COLUMN "instanceId" SET DEFAULT gen_random_uuid()::text;

-- CreateTable
CREATE TABLE "WordAudio" (
    "id" TEXT NOT NULL,
    "wordId" TEXT NOT NULL,
    "accent" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "sourceName" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "license" TEXT NOT NULL,
    "attribution" TEXT NOT NULL,
    "fileKey" TEXT NOT NULL,
    "fileSha256" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WordAudio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomBookImport" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bookId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "goal" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "formatVersion" TEXT NOT NULL DEFAULT 'word-lines-v1',
    "sha256" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'preview',
    "rowsJson" JSONB NOT NULL,
    "countsJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "CustomBookImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WordAudio_status_accent_idx" ON "WordAudio"("status", "accent");

-- CreateIndex
CREATE UNIQUE INDEX "WordAudio_wordId_accent_key" ON "WordAudio"("wordId", "accent");

-- CreateIndex
CREATE INDEX "CustomBookImport_userId_createdAt_idx" ON "CustomBookImport"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "CustomBookImport_expiresAt_idx" ON "CustomBookImport"("expiresAt");

-- CreateIndex
CREATE INDEX "Book_ownerId_status_idx" ON "Book"("ownerId", "status");

-- AddForeignKey
ALTER TABLE "Book" ADD CONSTRAINT "Book_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WordAudio" ADD CONSTRAINT "WordAudio_wordId_fkey" FOREIGN KEY ("wordId") REFERENCES "Word"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomBookImport" ADD CONSTRAINT "CustomBookImport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomBookImport" ADD CONSTRAINT "CustomBookImport_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE SET NULL ON UPDATE CASCADE;

