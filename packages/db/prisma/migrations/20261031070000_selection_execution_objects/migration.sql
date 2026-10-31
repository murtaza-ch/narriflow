-- Shared selection inputs are held by their exact adopted key. Multiple
-- windows may reference one input; the latest deadline bounds the hold.
CREATE INDEX "ClipSelectionWindow_inputStorageKey_operationDeadlineAt_idx"
  ON "ClipSelectionWindow" ("inputStorageKey", "operationDeadlineAt" DESC);
