CREATE TABLE "ContentPack" (
  "id" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ready',
  "sourceUrl" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "license" TEXT NOT NULL,
  "entryCount" INTEGER NOT NULL,
  "phoneticCount" INTEGER NOT NULL,
  "definitionZhCount" INTEGER NOT NULL,
  "definitionEnCount" INTEGER NOT NULL,
  "tagCounts" JSONB NOT NULL,
  "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ContentPack_pkey" PRIMARY KEY ("id")
);

-- Prisma's default text collation is locale-aware on common installations.
-- Prefix lookup needs pattern operators to use an index with those collations.
CREATE INDEX "Word_normalizedLemma_prefix" ON "Word" ("normalizedLemma" text_pattern_ops);
CREATE INDEX "Word_goalTags_gin" ON "Word" USING GIN ("goalTags");

ALTER TABLE "Word" ADD COLUMN "phoneticUs" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "phoneticUk" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "phoneticSource" TEXT NOT NULL DEFAULT '';
