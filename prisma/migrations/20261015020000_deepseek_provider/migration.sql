CREATE TABLE "DeepSeekSetting" (
  "id" TEXT NOT NULL DEFAULT 'singleton',
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "model" TEXT NOT NULL DEFAULT 'deepseek-flash',
  "keyCiphertext" TEXT,
  "keyPreview" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DeepSeekSetting_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DeepSeekRequestLease" (
  "id" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DeepSeekRequestLease_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DeepSeekRequestLease_expiresAt_idx" ON "DeepSeekRequestLease"("expiresAt");
