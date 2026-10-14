-- A group's postponement is independent of the word's memory due date.
ALTER TABLE "StudySession" ADD COLUMN "deferredUntil" TIMESTAMP(3);
