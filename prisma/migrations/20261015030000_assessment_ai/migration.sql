ALTER TABLE "DeepSeekSetting" ADD COLUMN "assessmentEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Assessment"
  ADD COLUMN "aiStatus" TEXT NOT NULL DEFAULT 'not_requested',
  ADD COLUMN "aiClaimId" TEXT,
  ADD COLUMN "aiStartedAt" TIMESTAMP(3),
  ADD COLUMN "aiCompletedAt" TIMESTAMP(3),
  ADD COLUMN "aiResultJson" JSONB;
