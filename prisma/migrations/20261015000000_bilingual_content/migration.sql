ALTER TABLE "Sense" ADD COLUMN "contentMetadata" JSONB NOT NULL DEFAULT '{}';

CREATE TABLE "WordExample" (
    "id" TEXT NOT NULL,
    "wordId" TEXT NOT NULL,
    "exampleEn" TEXT NOT NULL,
    "exampleZh" TEXT NOT NULL,
    "contentMetadata" JSONB NOT NULL DEFAULT '{}',
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "WordExample_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WordExample_wordId_ordinal_idx" ON "WordExample"("wordId", "ordinal");
ALTER TABLE "WordExample" ADD CONSTRAINT "WordExample_wordId_fkey" FOREIGN KEY ("wordId") REFERENCES "Word"("id") ON DELETE CASCADE ON UPDATE CASCADE;
