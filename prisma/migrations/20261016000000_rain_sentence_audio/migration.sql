CREATE TABLE "SiteAppearance" (
  "id" TEXT NOT NULL DEFAULT 'singleton',
  "mode" TEXT NOT NULL DEFAULT 'rain-night',
  "positionX" DOUBLE PRECISION NOT NULL DEFAULT 50,
  "positionY" DOUBLE PRECISION NOT NULL DEFAULT 50,
  "overlay" DOUBLE PRECISION NOT NULL DEFAULT 0.4,
  "animationEnabled" BOOLEAN NOT NULL DEFAULT true,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "imageSha256" TEXT,
  "imageBytes" BYTEA,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SiteAppearance_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "SentenceAudio" (
  "id" TEXT NOT NULL,
  "textHash" TEXT NOT NULL,
  "text" TEXT NOT NULL,
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
  CONSTRAINT "SentenceAudio_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SentenceAudio_textHash_accent_key" ON "SentenceAudio"("textHash", "accent");
CREATE INDEX "SentenceAudio_status_accent_idx" ON "SentenceAudio"("status", "accent");
