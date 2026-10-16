-- A sentence is evidence for one exact published meaning version. Updating a
-- meaning must never relabel existing sentences as a newer content version.
CREATE UNIQUE INDEX "LearningSense_id_wordId_contentVersion_key"
  ON "LearningSense"("id", "wordId", "contentVersion");

ALTER TABLE "WordExample"
  DROP CONSTRAINT "WordExample_learningSenseId_wordId_fkey";
ALTER TABLE "WordExample"
  ADD CONSTRAINT "WordExample_learningSenseId_wordId_contentVersion_fkey"
  FOREIGN KEY ("learningSenseId", "wordId", "contentVersion")
  REFERENCES "LearningSense"("id", "wordId", "contentVersion")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
