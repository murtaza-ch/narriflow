ALTER TABLE "ContentPack" ADD COLUMN "autopilotAuthority" JSONB;
ALTER TABLE "ContentPack" ADD CONSTRAINT "ContentPack_autopilotAuthority_bound"
  CHECK ("autopilotAuthority" IS NULL OR (
    "autopilotRuleId" IS NOT NULL AND
    jsonb_typeof("autopilotAuthority") = 'object' AND
    octet_length("autopilotAuthority"::text) <= 65536
  ));

CREATE FUNCTION "guardContentPackAutopilotAuthority"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."autopilotAuthority" IS DISTINCT FROM OLD."autopilotAuthority"
    OR (OLD."autopilotAuthority" IS NOT NULL AND (
      NEW."autopilotRuleId" IS DISTINCT FROM OLD."autopilotRuleId" OR
      NEW."recipe" IS DISTINCT FROM OLD."recipe"
    )) THEN
    RAISE EXCEPTION 'content pack Autopilot authority is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ContentPack_autopilotAuthority_immutable"
  BEFORE UPDATE ON "ContentPack"
  FOR EACH ROW EXECUTE FUNCTION "guardContentPackAutopilotAuthority"();
