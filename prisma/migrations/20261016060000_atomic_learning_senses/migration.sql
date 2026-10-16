CREATE TABLE "LearningSense" (
  "id" TEXT PRIMARY KEY,
  "wordId" TEXT NOT NULL,
  "pos" TEXT NOT NULL,
  "definitionZh" TEXT NOT NULL,
  "definitionEn" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'candidate',
  "contentVersion" TEXT NOT NULL,
  "bindingHash" TEXT NOT NULL,
  "contentMetadata" JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT "LearningSense_wordId_fkey" FOREIGN KEY ("wordId") REFERENCES "Word"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "LearningSense_status_check" CHECK ("status" IN ('candidate','pending','published','held','superseded')),
  CONSTRAINT "LearningSense_bindingHash_check" CHECK ("bindingHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "LearningSense_published_text_check" CHECK ("status" <> 'published' OR (length(btrim("pos")) > 0 AND length(btrim("definitionZh")) > 0 AND length(btrim("definitionEn")) > 0))
);
CREATE UNIQUE INDEX "LearningSense_id_wordId_key" ON "LearningSense"("id","wordId");
CREATE INDEX "LearningSense_wordId_status_ordinal_id_idx" ON "LearningSense"("wordId","status","ordinal","id");
CREATE UNIQUE INDEX "Sense_id_wordId_key" ON "Sense"("id","wordId");
CREATE TABLE "SenseSourceBinding" (
  "id" TEXT PRIMARY KEY,
  "wordId" TEXT NOT NULL,
  "learningSenseId" TEXT NOT NULL,
  "sourceSenseId" TEXT NOT NULL,
  "relation" TEXT NOT NULL,
  "sourcePosSha256" TEXT NOT NULL,
  "sourceDefinitionZhSha256" TEXT NOT NULL,
  "sourceDefinitionEnSha256" TEXT NOT NULL,
  "contentMetadata" JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT "SenseSourceBinding_learningSenseId_wordId_fkey" FOREIGN KEY ("learningSenseId","wordId") REFERENCES "LearningSense"("id","wordId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SenseSourceBinding_sourceSenseId_wordId_fkey" FOREIGN KEY ("sourceSenseId","wordId") REFERENCES "Sense"("id","wordId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SenseSourceBinding_relation_check" CHECK ("relation" IN ('exact','narrower','corrected-from')),
  CONSTRAINT "SenseSourceBinding_hashes_check" CHECK ("sourcePosSha256" ~ '^[a-f0-9]{64}$' AND "sourceDefinitionZhSha256" ~ '^[a-f0-9]{64}$' AND "sourceDefinitionEnSha256" ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX "SenseSourceBinding_learningSenseId_sourceSenseId_key" ON "SenseSourceBinding"("learningSenseId","sourceSenseId");
CREATE INDEX "SenseSourceBinding_sourceSenseId_wordId_idx" ON "SenseSourceBinding"("sourceSenseId","wordId");
ALTER TABLE "WordExample"
  ADD COLUMN "learningSenseId" TEXT,
  ADD COLUMN "contextLabel" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'candidate',
  ADD COLUMN "contentVersion" TEXT NOT NULL DEFAULT '',
  ADD CONSTRAINT "WordExample_learningSenseId_wordId_fkey" FOREIGN KEY ("learningSenseId","wordId") REFERENCES "LearningSense"("id","wordId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WordExample_status_check" CHECK ("status" IN ('candidate','pending','published','held','superseded')),
  ADD CONSTRAINT "WordExample_published_binding_check" CHECK ("status" <> 'published' OR ("learningSenseId" IS NOT NULL AND length(btrim("contextLabel")) > 0 AND length(btrim("exampleEn")) > 0 AND length(btrim("exampleZh")) > 0));
CREATE INDEX "WordExample_learningSenseId_status_ordinal_id_idx" ON "WordExample"("learningSenseId","status","ordinal","id");

CREATE TABLE "LookupRevision" ("scope" TEXT PRIMARY KEY, "revision" BIGINT NOT NULL DEFAULT 0);
INSERT INTO "LookupRevision"("scope","revision") VALUES ('catalog',0);
CREATE FUNCTION nightstudy_lookup_catalog_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "LookupRevision"("scope","revision") VALUES ('catalog',1)
  ON CONFLICT ("scope") DO UPDATE SET "revision"="LookupRevision"."revision"+1;
  RETURN NULL;
END;
$$;
CREATE TRIGGER "lookup_word_catalog" AFTER INSERT OR DELETE OR UPDATE OF "lemma","normalizedLemma","status" ON "Word" FOR EACH STATEMENT EXECUTE FUNCTION nightstudy_lookup_catalog_changed();
CREATE TRIGGER "lookup_source_catalog" AFTER INSERT OR UPDATE OR DELETE ON "Sense" FOR EACH STATEMENT EXECUTE FUNCTION nightstudy_lookup_catalog_changed();
CREATE TRIGGER "lookup_learning_catalog" AFTER INSERT OR UPDATE OR DELETE ON "LearningSense" FOR EACH STATEMENT EXECUTE FUNCTION nightstudy_lookup_catalog_changed();
CREATE TRIGGER "lookup_binding_catalog" AFTER INSERT OR UPDATE OR DELETE ON "SenseSourceBinding" FOR EACH STATEMENT EXECUTE FUNCTION nightstudy_lookup_catalog_changed();
CREATE TRIGGER "lookup_example_catalog" AFTER INSERT OR UPDATE OR DELETE ON "WordExample" FOR EACH STATEMENT EXECUTE FUNCTION nightstudy_lookup_catalog_changed();
CREATE FUNCTION nightstudy_lookup_collection_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subject TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN subject := OLD."userId"; ELSE subject := NEW."userId"; END IF;
  INSERT INTO "LookupRevision"("scope","revision") VALUES ('user:'||subject,1)
  ON CONFLICT ("scope") DO UPDATE SET "revision"="LookupRevision"."revision"+1;
  IF TG_OP = 'UPDATE' AND OLD."userId" <> NEW."userId" THEN
    INSERT INTO "LookupRevision"("scope","revision") VALUES ('user:'||OLD."userId",1)
    ON CONFLICT ("scope") DO UPDATE SET "revision"="LookupRevision"."revision"+1;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER "lookup_user_collection" AFTER INSERT OR UPDATE OR DELETE ON "UserWord" FOR EACH ROW EXECUTE FUNCTION nightstudy_lookup_collection_changed();

-- An edited source can no longer justify a previously reviewed semantic binding.
CREATE FUNCTION nightstudy_hold_drifted_meanings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."pos" IS DISTINCT FROM NEW."pos" OR OLD."definitionZh" IS DISTINCT FROM NEW."definitionZh" OR OLD."definitionEn" IS DISTINCT FROM NEW."definitionEn" THEN
    UPDATE "LearningSense" SET "status"='held'
    WHERE "status"='published' AND "id" IN (SELECT "learningSenseId" FROM "SenseSourceBinding" WHERE "sourceSenseId"=NEW."id" AND "wordId"=NEW."wordId");
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER "hold_drifted_meanings" AFTER UPDATE OF "pos","definitionZh","definitionEn" ON "Sense" FOR EACH ROW EXECUTE FUNCTION nightstudy_hold_drifted_meanings();
