BEGIN;

-- Accepted ratings update StudyProgress before their SessionItem in the same
-- transaction. This lock waits for those transactions and prevents new ratings
-- while deriving the pointer; no application table is rewritten or emptied.
LOCK TABLE "StudyProgress" IN ACCESS EXCLUSIVE MODE;
ALTER TABLE "StudyProgress"
  ADD COLUMN "reviewFocusSenseId" TEXT,
  ADD COLUMN "reviewFocusRevision" INTEGER NOT NULL DEFAULT 0;

-- Only this exact cache-invalidation trigger may be suppressed during the
-- derived-column backfill. A changed/missing/disabled trigger aborts the whole
-- migration instead of silently changing another trigger's prior state.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='"StudyProgress"'::regclass
      AND tgname='lookup_study_progress'
      AND tgfoid='nightstudy_lookup_collection_changed()'::regprocedure
      AND tgtype=29 AND tgenabled='O' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'review_focus_expected_lookup_trigger_missing_or_changed';
  END IF;
END;
$$;
ALTER TABLE "StudyProgress" DISABLE TRIGGER "lookup_study_progress";

-- A cancelled group can still contain a previously accepted rating. An unrated
-- abandoned item, another user's history, or a future revision cannot supply
-- a pointer. Raw or later-held IDs remain historical evidence only: runtime
-- selection still checks the current meaning and exact source proof.
WITH accepted AS (
  SELECT DISTINCT ON (p.id)
    p.id, si."focusSenseId", si."progressRevision"
  FROM "StudyProgress" p
  JOIN "StudySession" ss ON ss."userId"=p."userId"
  JOIN "SessionItem" si ON si."sessionId"=ss.id AND si."wordId"=p."wordId"
  WHERE ss.status IN ('in_progress','paused','completed','cancelled')
    AND si.rated=true AND si.revealed=true AND si.status IN ('rated','completed')
    AND si."focusSenseId" IS NOT NULL AND btrim(si."focusSenseId")<>''
    AND si."progressRevision">0 AND si."progressRevision"<=p.revision
    AND p."firstLearnedAt" IS NOT NULL AND p."lastReviewAt" IS NOT NULL
  ORDER BY p.id, si."progressRevision" DESC, ss."createdAt" DESC, si.id DESC
)
UPDATE "StudyProgress" p
SET "reviewFocusSenseId"=a."focusSenseId", "reviewFocusRevision"=a."progressRevision"
FROM accepted a WHERE a.id=p.id;

ALTER TABLE "StudyProgress" ENABLE TRIGGER "lookup_study_progress";
ALTER TABLE "StudyProgress" ADD CONSTRAINT "StudyProgress_review_focus_pair_check" CHECK (
  ("reviewFocusSenseId" IS NULL AND "reviewFocusRevision"=0)
  OR
  ("reviewFocusSenseId" IS NOT NULL AND btrim("reviewFocusSenseId")<>''
    AND "reviewFocusRevision">0 AND "reviewFocusRevision"<=revision)
);

COMMIT;
