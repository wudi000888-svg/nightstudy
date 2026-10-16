CREATE FUNCTION nightstudy_hold_rebound_meanings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "LearningSense" SET "status"='held' WHERE "id"=OLD."learningSenseId" AND "status"='published';
  IF TG_OP='UPDATE' AND OLD."learningSenseId" <> NEW."learningSenseId" THEN
    UPDATE "LearningSense" SET "status"='held' WHERE "id"=NEW."learningSenseId" AND "status"='published';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER "hold_rebound_meanings" AFTER UPDATE OR DELETE ON "SenseSourceBinding" FOR EACH ROW EXECUTE FUNCTION nightstudy_hold_rebound_meanings();
