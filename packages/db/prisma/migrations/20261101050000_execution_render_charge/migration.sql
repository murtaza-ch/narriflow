-- Actual process starts consume the group's finite budget permanently.
-- Unstarted releases remain uncharged; no historical accounting is rewritten.
ALTER TABLE "RenderGroupExecution"
  DROP CONSTRAINT "RenderGroupExecution_release_check",
  DROP CONSTRAINT "RenderGroupExecution_charge_check",
  ADD CONSTRAINT "RenderGroupExecution_charge_check"
    CHECK ("charged" = ("startedAt" IS NOT NULL));

CREATE FUNCTION render_group_charge_monotone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."chargedAttemptCount" < OLD."chargedAttemptCount" THEN
    RAISE EXCEPTION 'started render group attempts cannot be refunded' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "RenderGroup_charge_monotone" BEFORE UPDATE OF "chargedAttemptCount" ON "RenderGroup"
FOR EACH ROW EXECUTE FUNCTION render_group_charge_monotone();
