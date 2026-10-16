ALTER TABLE "UserLearningPreference" ADD COLUMN "meaningChoiceEnabled" BOOLEAN NOT NULL DEFAULT true;
CREATE TRIGGER "lookup_study_progress" AFTER INSERT OR UPDATE OR DELETE ON "StudyProgress" FOR EACH ROW EXECUTE FUNCTION nightstudy_lookup_collection_changed();
CREATE TRIGGER "lookup_known_claim" AFTER INSERT OR UPDATE OR DELETE ON "KnownClaim" FOR EACH ROW EXECUTE FUNCTION nightstudy_lookup_collection_changed();
CREATE TRIGGER "lookup_known_import" AFTER INSERT OR UPDATE OR DELETE ON "KnownImport" FOR EACH ROW EXECUTE FUNCTION nightstudy_lookup_collection_changed();
CREATE TRIGGER "lookup_auto_known" AFTER INSERT OR UPDATE OR DELETE ON "AutoKnownWord" FOR EACH ROW EXECUTE FUNCTION nightstudy_lookup_collection_changed();
CREATE TRIGGER "lookup_book_items" AFTER INSERT OR UPDATE OR DELETE ON "BookItem" FOR EACH STATEMENT EXECUTE FUNCTION nightstudy_lookup_catalog_changed();
