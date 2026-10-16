CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "Word_lookup_trgm_published_idx" ON "Word" USING GIN ("normalizedLemma" gin_trgm_ops) WHERE "status"='published';
CREATE INDEX "Word_lookup_c_published_idx" ON "Word" ("normalizedLemma" COLLATE "C", "id") WHERE "status"='published';
