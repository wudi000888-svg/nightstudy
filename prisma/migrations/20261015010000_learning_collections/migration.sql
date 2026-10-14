ALTER TABLE "Book" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'vocabulary';
ALTER TABLE "UserWord" ADD COLUMN "graduatedAt" TIMESTAMP(3);

CREATE TABLE "AutoKnownWord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "wordId" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "policyVersion" TEXT NOT NULL DEFAULT 'fsrs-familiarity-v1',
    CONSTRAINT "AutoKnownWord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AutoKnownWord_userId_wordId_key" ON "AutoKnownWord"("userId", "wordId");
CREATE INDEX "AutoKnownWord_userId_revokedAt_idx" ON "AutoKnownWord"("userId", "revokedAt");
CREATE INDEX "ReviewLog_userId_wordId_reviewedAt_idx" ON "ReviewLog"("userId", "wordId", "reviewedAt");

ALTER TABLE "AutoKnownWord" ADD CONSTRAINT "AutoKnownWord_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AutoKnownWord" ADD CONSTRAINT "AutoKnownWord_wordId_fkey"
    FOREIGN KEY ("wordId") REFERENCES "Word"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "WordCollocation" (
    "wordId" TEXT NOT NULL,
    "phraseId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "WordCollocation_pkey" PRIMARY KEY ("wordId", "phraseId")
);
CREATE INDEX "WordCollocation_phraseId_idx" ON "WordCollocation"("phraseId");
ALTER TABLE "WordCollocation" ADD CONSTRAINT "WordCollocation_wordId_fkey"
    FOREIGN KEY ("wordId") REFERENCES "Word"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WordCollocation" ADD CONSTRAINT "WordCollocation_phraseId_fkey"
    FOREIGN KEY ("phraseId") REFERENCES "Word"("id") ON DELETE CASCADE ON UPDATE CASCADE;
