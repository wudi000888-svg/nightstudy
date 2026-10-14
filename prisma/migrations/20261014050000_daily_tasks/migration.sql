-- AlterTable
ALTER TABLE "ReviewLog" ADD COLUMN     "planId" TEXT;

-- AlterTable
ALTER TABLE "StudySession" ADD COLUMN     "pausedAt" TIMESTAMP(3),
ADD COLUMN     "planId" TEXT,
ADD COLUMN     "taskKind" TEXT NOT NULL DEFAULT 'legacy';

-- AlterTable
ALTER TABLE "UserSettings" ADD COLUMN     "dailyTotalGoal" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "pendingTimeZone" TEXT,
ADD COLUMN     "timeZoneEffectiveAt" TIMESTAMP(3);

-- Preserve the configured number when migrating from a daily new-word allowance.
UPDATE "UserSettings" SET "dailyTotalGoal" = LEAST(100, GREATEST(1, "dailyNewLimit"));
ALTER TABLE "UserSettings" ADD CONSTRAINT "UserSettings_dailyTotalGoal_check"
CHECK ("dailyTotalGoal" BETWEEN 1 AND 100);

-- CreateTable
CREATE TABLE "DailyPlan" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "localDate" TEXT NOT NULL,
    "timeZone" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "targetTotal" INTEGER NOT NULL,
    "sourceBookId" TEXT,
    "sourceBookTitle" TEXT,
    "goal" TEXT NOT NULL,
    "prefsRevision" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyPlan_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "DailyPlan" ADD CONSTRAINT "DailyPlan_targetTotal_check"
CHECK ("targetTotal" BETWEEN 1 AND 100);
ALTER TABLE "DailyPlan" ADD CONSTRAINT "DailyPlan_window_check"
CHECK ("endsAt" > "startsAt");

-- CreateTable
CREATE TABLE "DailyPlanWord" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "wordId" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "dueAtSnapshot" TIMESTAMP(3),
    "firstRatedAt" TIMESTAMP(3),
    "activeSessionId" TEXT,
    "deferredUntil" TIMESTAMP(3),
    "ordinal" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyPlanWord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DailyPlan_userId_endsAt_idx" ON "DailyPlan"("userId", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "DailyPlan_userId_startsAt_key" ON "DailyPlan"("userId", "startsAt");

-- CreateIndex
CREATE INDEX "DailyPlanWord_planId_status_ordinal_idx" ON "DailyPlanWord"("planId", "status", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "DailyPlanWord_planId_wordId_key" ON "DailyPlanWord"("planId", "wordId");

-- CreateIndex
CREATE INDEX "ReviewLog_planId_reviewedAt_idx" ON "ReviewLog"("planId", "reviewedAt");

-- AddForeignKey
ALTER TABLE "StudySession" ADD CONSTRAINT "StudySession_planId_fkey" FOREIGN KEY ("planId") REFERENCES "DailyPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewLog" ADD CONSTRAINT "ReviewLog_planId_fkey" FOREIGN KEY ("planId") REFERENCES "DailyPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyPlan" ADD CONSTRAINT "DailyPlan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyPlanWord" ADD CONSTRAINT "DailyPlanWord_planId_fkey" FOREIGN KEY ("planId") REFERENCES "DailyPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyPlanWord" ADD CONSTRAINT "DailyPlanWord_wordId_fkey" FOREIGN KEY ("wordId") REFERENCES "Word"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

