CREATE TABLE "UserLearningPreference" (
  "userId" TEXT NOT NULL,
  "theme" TEXT NOT NULL DEFAULT 'day',
  "accent" TEXT NOT NULL DEFAULT 'us',
  "autoPlay" BOOLEAN NOT NULL DEFAULT false,
  "spellingEnabled" BOOLEAN NOT NULL DEFAULT true,
  "fontScale" DOUBLE PRECISION NOT NULL DEFAULT 1,
  "reminderEnabled" BOOLEAN NOT NULL DEFAULT false,
  "reminderTime" TEXT NOT NULL DEFAULT '20:00',
  "revision" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserLearningPreference_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "LibrarySentence" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "wordId" TEXT,
  "sourceType" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "sourceHash" TEXT NOT NULL,
  "exampleEn" TEXT NOT NULL,
  "exampleZh" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LibrarySentence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LibraryNote" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "wordId" TEXT,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LibraryNote_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AcademyAttempt" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "lessonId" TEXT NOT NULL,
  "lessonVersion" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'in_progress',
  "revision" INTEGER NOT NULL DEFAULT 0,
  "itemsJson" JSONB NOT NULL DEFAULT '[]',
  "resultJson" JSONB,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "AcademyAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LibrarySentence_userId_sourceType_sourceId_sourceHash_key" ON "LibrarySentence"("userId", "sourceType", "sourceId", "sourceHash");
CREATE INDEX "LibrarySentence_userId_createdAt_id_idx" ON "LibrarySentence"("userId", "createdAt", "id");
CREATE INDEX "LibraryNote_userId_updatedAt_id_idx" ON "LibraryNote"("userId", "updatedAt", "id");
CREATE INDEX "AcademyAttempt_userId_startedAt_id_idx" ON "AcademyAttempt"("userId", "startedAt", "id");
ALTER TABLE "UserLearningPreference" ADD CONSTRAINT "UserLearningPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LibrarySentence" ADD CONSTRAINT "LibrarySentence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LibrarySentence" ADD CONSTRAINT "LibrarySentence_wordId_fkey" FOREIGN KEY ("wordId") REFERENCES "Word"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LibraryNote" ADD CONSTRAINT "LibraryNote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LibraryNote" ADD CONSTRAINT "LibraryNote_wordId_fkey" FOREIGN KEY ("wordId") REFERENCES "Word"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AcademyAttempt" ADD CONSTRAINT "AcademyAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
