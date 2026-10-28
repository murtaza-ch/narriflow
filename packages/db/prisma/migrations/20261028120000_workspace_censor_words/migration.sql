-- One censored-word list per Workspace. Until it is edited the Workspace uses
-- the built-in defaults (censorWordsCustomized = false); after the first edit
-- censorWords replaces them entirely.
ALTER TABLE "Workspace"
  ADD COLUMN "censorWords" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "censorWordsCustomized" BOOLEAN NOT NULL DEFAULT false;
